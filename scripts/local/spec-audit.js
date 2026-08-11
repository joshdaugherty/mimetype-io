#!/usr/bin/env node
/**
 * Fork-only. Not part of any upstream pull request.
 *
 * Answers one question for every eligible type: is there a specification a
 * description could be written from?
 *
 * That question is the include test #8 is trying to settle. Batch 1 applied it
 * by hand and kept `image/vnd.zbrush.pcx` while dropping ten neighbours; batch
 * 2 deferred 14 types on an assumption about it that turned out to be wrong for
 * four of them. Applying it by hand does not scale to 996 vendor types and does
 * not give the same answer twice, so it is written down here as code.
 *
 * The test reads one field of the IANA registration template, "Published
 * specification", and sorts on what it says:
 *
 *   readable   a URL that resolves, or a named RFC, W3C or other free standard
 *   paywalled  a real standard that costs money (ISO, GB/T, DVD Forum, SMPTE).
 *              Describable in outline, not checkable against the text
 *   dead       a URL that no longer resolves
 *   none       blank, "proprietary", "available on request", or a contact name
 *   unclear    a document is named, from a body this script cannot place.
 *              A person has to look. 3GPP and ATSC land here and are free;
 *              ASAM and CEA land here and are not
 *   missing    IANA has no template and the registry names only a contact
 *
 * Only `readable` clears the bar batch 3 was written to. `paywalled` and
 * `unclear` are where the judgement lives. `dead` and `none` are the types PR
 * #68 filled with empty descriptions, which is what the maintainer turned down.
 *
 * The verdict is evidence, not a decision. It says what the registration says,
 * which is the part that can be checked; whether a type earns a page is a
 * separate question and #8 owns it.
 *
 * Templates are cached under .cache/iana-templates, which is gitignored, so a
 * second run costs nothing. --probe additionally fetches every URL a
 * registration names, which is what separates `readable` from `dead`; without
 * it a named URL is trusted and reported as `readable (unprobed)`.
 *
 * --clash reports the other half of the include test settled on #8. A type can
 * fail the spec test and still earn a page if its extension already resolves on
 * the site, because someone searching that extension arrives at a neighbour and
 * should be told this name exists. That is why batch 1 kept image/vnd.zbrush.pcx
 * over its .pcx clash. The rule is readable-only; a clash is an exception to
 * argue one entry at a time, so this lists candidates rather than approvals.
 *
 * Usage:
 *   node scripts/local/spec-audit.js --prefix image/vnd.
 *   node scripts/local/spec-audit.js --probe --json out.json
 *   node scripts/local/spec-audit.js --names image/vnd.zbrush.pcx audio/vnd.dra
 *   node scripts/local/spec-audit.js --clash
 */

const { execSync } = require("child_process")
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require("fs")
const path = require("path")

const ROOT = path.join(__dirname, "..", "..")
const CACHE_DIR = path.join(ROOT, ".cache", "iana-templates")
const PROBE_CACHE = path.join(ROOT, ".cache", "spec-probes.json")

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const value = name => {
    const i = argv.indexOf(name)
    if (i === -1) return null
    const next = argv[i + 1]
    return next === undefined || next.startsWith("--") ? null : next
}
const values = name => {
    const i = argv.indexOf(name)
    if (i === -1) return []
    const out = []
    for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j++)
        out.push(argv[j])
    return out
}

/**
 * IANA rate-limits. At eight parallel requests it answered 429 to 538 of 1754
 * templates, and because the placeholder was cached the run looked like 620
 * types with no registration at all. Four workers with a retry on 429 gets
 * through the whole pool. Non-200 responses are never cached, so a throttled
 * run can be repeated instead of poisoning the cache.
 */
const CONCURRENCY = 4
const RETRY_DELAYS = [2000, 5000, 12000, 30000]
const TIMEOUT = 20000
const UA = "mimetype.io-spec-audit"

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Phrases that mean "there is nothing to read here", quoted from the
 * registrations they appear in rather than invented. Matched anywhere in the
 * Published specification field, case-insensitively.
 */
const NO_SPEC_PHRASES = [
    "proprietary",
    "available upon request",
    "available on request",
    "on a case-by-case basis",
    "not published",
    "no formal specification",
    "no official documentation",
    "not publicly available",
    "no public specification",
    "no published specification",
    "privately held",
    "confidential",
    "under nda",
    "contact the author",
]

/** Short answers that only count when they are the entire field. */
const NO_SPEC_EXACT = ["n/a", "na", "none", "tbd", "-", "unknown"]

/**
 * The field labels that can follow Published specification in a registration
 * template. Needed because the value often runs over several lines, and a line
 * of prose ending in a colon ("The audiokoz specifiaction is published at:") is
 * otherwise indistinguishable from the start of the next field.
 */
const NEXT_FIELD =
    /^\s*(?:[o*\-•]|\d+\.)?\s*(applications?\s+(that|which)|fragment identifier|additional information|person\b|persons?\s*(&|and)\s*email|intended usage|restrictions on usage|author\b|change controller|provisional registration|magic number|file extension|macintosh file|deprecated alias|general comments?|object identifier|encoding considerations|security considerations|interoperability considerations|contact\b|registration\b)[^:\n]{0,40}\s*:/i

const PAID_STANDARD_NAMES =
    /\b(ISO\/IEC|ISO \d|IEC \d|GB\/T|IEEE \d|SMPTE|ANSI |DVD Forum|DVD Specifications|JIS |DIN )/i

const FREE_STANDARD_NAMES =
    /\b(RFC\s?\d{3,5}|BCP\s?\d+|STD\s?\d+|W3C|WHATWG|ECMA-\d+|OASIS|Khronos|Unicode Standard|ETSI (TS|EN|TR) \d)/i

/**
 * Extensions too common to mean anything. A vendor JSON type sharing `.json`
 * with application/json tells a searcher nothing; a vendor type sharing `.swf`
 * with application/x-shockwave-flash tells them where the name came from.
 */
const GENERIC_EXTENSIONS = new Set([
    ".json",
    ".xml",
    ".zip",
    ".txt",
    ".bin",
    ".dat",
    ".cbor",
    ".gz",
    ".yaml",
    ".yml",
    ".csv",
    ".html",
    ".xhtml",
    ".js",
    ".pdf",
])

const sanitise = name => name.replace(/[^a-zA-Z0-9._+-]/g, "_")

const readCache = name => {
    const f = path.join(CACHE_DIR, sanitise(name) + ".txt")
    return existsSync(f) ? readFileSync(f, "utf8") : null
}

const writeCache = (name, body) => {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(path.join(CACHE_DIR, sanitise(name) + ".txt"), body)
}

const fetchTemplate = async name => {
    const cached = readCache(name)
    if (cached !== null) return cached
    const url = `https://www.iana.org/assignments/media-types/${name}`
    for (let attempt = 0; ; attempt++) {
        try {
            const res = await fetch(url, {
                redirect: "follow",
                signal: AbortSignal.timeout(TIMEOUT),
                headers: { "user-agent": UA },
            })
            if (res.status === 200) {
                const body = await res.text()
                writeCache(name, body)
                return body
            }
            if (
                (res.status === 429 || res.status >= 500) &&
                attempt < RETRY_DELAYS.length
            ) {
                await sleep(RETRY_DELAYS[attempt])
                continue
            }
            if (res.status === 404) writeCache(name, "__HTTP_404__")
            return `__HTTP_${res.status}__`
        } catch (e) {
            if (attempt < RETRY_DELAYS.length) {
                await sleep(RETRY_DELAYS[attempt])
                continue
            }
            return `__ERROR_${e.message}__`
        }
    }
}

/**
 * The registry CSVs, keyed by type name, for the Reference column.
 *
 * Forty-seven templates predate the current form and have no Published
 * specification field at all: application/batch-SMTP is laid out as a 1998
 * email, and the specification it belongs to is named only in the registry.
 * Falling back to the Reference column recovers those instead of reporting them
 * as unregistered. The CSVs are the cache pool.js already maintains.
 */
const loadRegistryReferences = () => {
    const dir = path.join(ROOT, ".cache", "iana")
    const refs = new Map()
    if (!existsSync(dir)) return refs
    for (const file of require("fs").readdirSync(dir)) {
        if (!file.endsWith(".csv")) continue
        const rows = readFileSync(path.join(dir, file), "utf8").split(/\r?\n/)
        for (const row of rows.slice(1)) {
            // Name,Template,Reference — Reference may itself contain commas
            // inside brackets, so split on the first two separators only.
            const first = row.indexOf(",")
            const second = row.indexOf(",", first + 1)
            if (first === -1 || second === -1) continue
            const template = row.slice(first + 1, second).trim()
            const reference = row.slice(second + 1).trim()
            if (template) refs.set(template.toLowerCase(), reference)
        }
    }
    return refs
}

/**
 * Pulls the Published specification field out of a registration template.
 *
 * The templates are hand-typed plain text with no consistent layout: the label
 * varies in case, the value may be on the same line or the next, and the field
 * may be numbered or bulleted. Everything up to the next field label counts as
 * the value.
 */
const specField = text => {
    const lines = text.split(/\r?\n/)
    const start = lines.findIndex(l =>
        /^\s*(?:[o*\-\d.]+\s*)?published\s+specification\s*:/i.test(l),
    )
    if (start === -1) return null
    let out = lines[start].replace(
        /^\s*(?:[o*\-\d.]+\s*)?published\s+specification\s*:/i,
        "",
    )
    for (let j = start + 1; j < lines.length; j++) {
        const line = lines[j]
        if (!line.trim()) {
            if (out.trim()) break
            continue
        }
        if (NEXT_FIELD.test(line)) break
        out += " " + line
    }
    return out.replace(/\s+/g, " ").trim()
}

const urlsIn = text =>
    (text.match(/https?:\/\/[^\s<>"')\],]+/gi) ?? []).map(u =>
        u.replace(/[.,;]+$/, ""),
    )

/**
 * ISO/IEC 29500 is Office Open XML, and ECMA publishes the identical text as
 * ECMA-376 for nothing. Every one of the 63 Office part registrations cites the
 * ISO number, so without this they would all read as paywalled when the
 * specification is in fact a free download.
 */
const FREE_BEHIND_A_PAID_NUMBER = [
    {
        match: /ISO\/IEC\s*29500/i,
        as: "ECMA-376, the free text of ISO/IEC 29500",
    },
    {
        match: /ISO\/IEC\s*26300/i,
        as: "OASIS OpenDocument, the free text of ISO/IEC 26300",
    },
    {
        match: /ISO\/IEC\s*32000/i,
        as: "PDF, published free by ISO since 32000-1",
    },
]

const classify = (spec, probes, reference) => {
    if (spec === null) {
        const ref = reference ?? ""
        if (FREE_STANDARD_NAMES.test(ref.replace(/[[\]]/g, " ")))
            return { klass: "readable", why: `registry reference ${ref}` }
        const refUrls = urlsIn(ref)
        if (refUrls.some(u => probes[u]?.ok))
            return {
                klass: "readable",
                why: `registry reference ${refUrls[0]}`,
            }
        return {
            klass: "missing",
            why: ref ? `registry names only ${ref}` : "no template field",
        }
    }

    const bare = spec.replace(/[.\s]+$/, "").trim()
    if (!bare) return { klass: "none", why: "field is empty" }

    for (const { match, as } of FREE_BEHIND_A_PAID_NUMBER)
        if (match.test(bare)) return { klass: "readable", why: as }

    const lower = bare.toLowerCase()
    const urls = urlsIn(spec)

    // A URL that actually resolves is the strongest evidence there is, so it
    // outranks everything, including the word "proprietary" in the same field.
    const alive = urls.filter(u => probes[u]?.ok)
    const probed = urls.filter(u => probes[u] !== undefined)
    if (alive.length) return { klass: "readable", why: `${alive[0]} resolves` }
    if (urls.length && !probed.length)
        return { klass: "readable", why: `names ${urls[0]}`, unprobed: true }

    // Beyond that, what the registration says about itself decides. A vendor
    // who wrote "proprietary" is telling you there is nothing to read.
    for (const phrase of NO_SPEC_PHRASES)
        if (lower.includes(phrase))
            return { klass: "none", why: bare.slice(0, 70) }
    if (NO_SPEC_EXACT.includes(lower.replace(/[.\s]+$/, "")))
        return { klass: "none", why: bare.slice(0, 70) }

    if (urls.length)
        return { klass: "dead", why: `${urls[0]} does not resolve` }

    if (FREE_STANDARD_NAMES.test(bare))
        return { klass: "readable", why: `names ${bare.slice(0, 60)}` }
    if (PAID_STANDARD_NAMES.test(bare))
        return { klass: "paywalled", why: bare.slice(0, 70) }

    // "this document" / "this specification" on a vendor type means the
    // registration form itself, which is four lines and not a specification.
    if (/^(this (document|specification|memo))/i.test(bare))
        return { klass: "none", why: "points at the registration form" }

    return { klass: "unclear", why: bare.slice(0, 70) }
}

const mapLimit = async (items, limit, fn) => {
    const out = new Array(items.length)
    let next = 0
    const workers = Array.from(
        { length: Math.min(limit, items.length) },
        async () => {
            while (next < items.length) {
                const i = next++
                out[i] = await fn(items[i], i)
            }
        },
    )
    await Promise.all(workers)
    return out
}

const loadPool = () => {
    const out = execSync("node scripts/local/pool.js --list", {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 1e8,
    })
    const at = out.search(/^\d+ name\(s\):$/m)
    if (at === -1) throw new Error("could not find the pool listing")
    return out
        .slice(at)
        .split(/\r?\n/)
        .slice(1)
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => {
            const [name, source, ...exts] = l.split(/\s+/)
            return { name, source, exts }
        })
}

const main = async () => {
    const explicit = values("--names")
    const prefix = value("--prefix")
    const probe = flag("--probe")

    let rows = explicit.length
        ? explicit.map(name => ({ name, source: "given", exts: [] }))
        : loadPool()
    if (prefix) rows = rows.filter(r => r.name.startsWith(prefix))

    console.log(`Reading ${rows.length} registration(s) from IANA.`)

    const templates = await mapLimit(rows, CONCURRENCY, async r => ({
        ...r,
        text: await fetchTemplate(r.name),
    }))

    // A 404 is an answer: IANA has no template for that type, and the registry
    // Reference column is all there is. Anything else that failed is a request
    // that has to be repeated, which is a different thing and reported as such.
    const withSpec = templates.map(r => ({
        ...r,
        spec: /^__(HTTP|ERROR)_/.test(r.text) ? null : specField(r.text),
        noTemplate: r.text === "__HTTP_404__",
        fetchFailed:
            /^__(HTTP|ERROR)_/.test(r.text) && r.text !== "__HTTP_404__",
    }))

    const probes = existsSync(PROBE_CACHE)
        ? JSON.parse(readFileSync(PROBE_CACHE, "utf8"))
        : {}

    const references = loadRegistryReferences()

    if (probe) {
        const wanted = [
            ...new Set(
                withSpec.flatMap(r => [
                    ...(r.spec ? urlsIn(r.spec) : []),
                    ...urlsIn(references.get(r.name.toLowerCase()) ?? ""),
                ]),
            ),
        ].filter(u => probes[u] === undefined)
        console.log(`Probing ${wanted.length} specification URL(s).`)
        await mapLimit(wanted, CONCURRENCY, async url => {
            try {
                const res = await fetch(url, {
                    redirect: "follow",
                    signal: AbortSignal.timeout(TIMEOUT),
                    headers: { "user-agent": UA },
                })
                // A parked domain answers 200 too, so record what came back.
                // Type and size are what let a person spot a soft 404.
                const body = res.ok ? await res.text() : ""
                probes[url] = {
                    ok: res.status < 400,
                    status: res.status,
                    type: (res.headers.get("content-type") ?? "").split(";")[0],
                    bytes: body.length,
                    finalUrl: res.url === url ? undefined : res.url,
                }
            } catch (e) {
                probes[url] = { ok: false, status: e.message.slice(0, 40) }
            }
        })
        mkdirSync(path.dirname(PROBE_CACHE), { recursive: true })
        writeFileSync(PROBE_CACHE, JSON.stringify(probes, null, 1))
    }

    const results = withSpec.map(r => {
        const reference = references.get(r.name.toLowerCase())
        const verdict = r.fetchFailed
            ? { klass: "throttled", why: r.text.slice(0, 40) }
            : classify(r.spec, probes, reference)
        return {
            name: r.name,
            source: r.source,
            exts: r.exts,
            spec: r.spec,
            reference,
            ...verdict,
        }
    })

    const throttled = results.filter(r => r.klass === "throttled").length
    if (throttled)
        console.log(
            `\n${throttled} template(s) could not be read. Nothing was cached for them; run again to pick them up.`,
        )

    const counts = {}
    for (const r of results) counts[r.klass] = (counts[r.klass] ?? 0) + 1
    console.log("\nVerdicts:")
    for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
        console.log(`  ${String(v).padStart(5)}  ${k}`)

    const jsonOut = value("--json")
    if (jsonOut) {
        writeFileSync(jsonOut, JSON.stringify(results, null, 1))
        console.log(`\nWrote ${results.length} result(s) to ${jsonOut}`)
    }

    if (flag("--show")) {
        const only = value("--show")
        for (const r of results) {
            if (only && r.klass !== only) continue
            console.log(`  ${r.klass.padEnd(10)} ${r.name.padEnd(52)} ${r.why}`)
        }
    }

    if (flag("--clash")) {
        const data = JSON.parse(
            readFileSync(path.join(ROOT, "src", "mimeData.json"), "utf8"),
        )
        const owners = new Map()
        for (const entry of data)
            for (const ext of entry.fileTypes ?? []) {
                const key = ext.toLowerCase()
                if (GENERIC_EXTENSIONS.has(key)) continue
                if (!owners.has(key)) owners.set(key, [])
                owners.get(key).push(entry.name)
            }
        const hits = results
            .map(r => ({
                ...r,
                shared: r.exts.filter(e => owners.has(e.toLowerCase())),
            }))
            .filter(r => r.shared.length)
        const exceptions = hits.filter(r => r.klass !== "readable")
        console.log(
            `\n${hits.length} type(s) share a distinctive extension with a page that already exists.`,
        )
        console.log(
            `${exceptions.length} of those fail the spec test, so each is an exception to argue:\n`,
        )
        for (const r of exceptions)
            console.log(
                `  ${r.klass.padEnd(10)} ${r.name.padEnd(50)} ${r.shared.join(" ")} -> ${r.shared
                    .flatMap(e => owners.get(e.toLowerCase()))
                    .slice(0, 2)
                    .join(", ")}`,
            )
    }
}

main()
