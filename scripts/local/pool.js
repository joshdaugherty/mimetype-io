#!/usr/bin/env node
/**
 * Fork-only. Not part of any upstream pull request.
 *
 * Reports which media types are still eligible to be added, by subtracting
 * everything the current src/mimeData.json already publishes -- both canonical
 * entries and the stub pages generated from `deprecates`, `parentOf` and
 * `alternativeTo`.
 *
 * That subtraction is the whole point: PR #68 was closed because entries
 * appended at the end of the array silently overwrote pages that other entries
 * had already claimed.
 *
 * Candidates come from two places:
 *
 *   1. The closed PR #68 branch, which carries extensions and links for every
 *      type it extracted.
 *   2. The IANA registries, which are authoritative about what exists but say
 *      nothing about file extensions.
 *
 * The branch alone covered 1325 of the 2326 registered types, so a thousand
 * registered types were unreachable by any batch, `application/jwt` and
 * `application/x-www-form-urlencoded` among them. The branch is still the
 * source of extensions where it has them; it is no longer the list of what
 * exists. Its extensions have been wrong four times (audio/asc, text/vcard,
 * text/cache-manifest, audio/vnd.dts.uhd), so check them against the
 * registration either way.
 *
 * Registry CSVs are cached under .cache/iana, which is gitignored. Without a
 * cache and without network the tool still runs, on branch candidates alone,
 * and says so.
 *
 * Usage:
 *   node scripts/local/pool.js              # summary
 *   node scripts/local/pool.js --list       # every eligible name
 *   node scripts/local/pool.js --prefix image/
 *   node scripts/local/pool.js --json image/jxl image/apng
 *   node scripts/local/pool.js --refresh    # re-fetch the registry cache
 *   node scripts/local/pool.js --no-registry
 */

const { execSync } = require("child_process")
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require("fs")
const path = require("path")

/** The head of the closed PR #68 branch, our source of extracted data. */
const PR_REV = "c52ef8c"

const ROOT = path.join(__dirname, "..", "..")
const CURRENT = path.join(ROOT, "src", "mimeData.json")
const CACHE_DIR = path.join(ROOT, ".cache", "iana")

const TOP_LEVELS = [
    "application",
    "audio",
    "font",
    "haptics",
    "image",
    "message",
    "model",
    "multipart",
    "text",
    "video",
]

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const named = args.filter(a => !a.startsWith("--"))

const gitJson = rev =>
    JSON.parse(
        execSync(`git show ${rev}:src/mimeData.json`, {
            cwd: ROOT,
            maxBuffer: 128 * 1024 * 1024,
        }).toString(),
    )

/** A well-formed `type/subtype`. Filters the registry's placeholder rows. */
const WELL_FORMED = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i

const parseCsv = text => {
    const out = []
    for (const line of text.split(/\r?\n/).slice(1)) {
        const m = line.match(/^([^,]*),([^,]*),(.*)$/)
        if (!m) continue
        const template = m[2].trim()
        if (!WELL_FORMED.test(template)) continue
        out.push({ name: template, ref: m[3].replace(/^"|"$/g, "").trim() })
    }
    return out
}

/**
 * Registry names, from cache when present. `--refresh` re-fetches. A failure is
 * reported rather than thrown: the environment this work started in blocked
 * iana.org outright, and the tool should still be useful there.
 */
const loadRegistry = async () => {
    if (flag("--no-registry")) return { types: [], status: "skipped" }

    const types = []
    let fetched = 0
    let fromCache = 0
    const failures = []

    for (const top of TOP_LEVELS) {
        const cached = path.join(CACHE_DIR, `${top}.csv`)
        let text = null

        if (!flag("--refresh") && existsSync(cached)) {
            text = readFileSync(cached, "utf8")
            fromCache++
        } else {
            try {
                const res = await fetch(
                    `https://www.iana.org/assignments/media-types/${top}.csv`,
                    { signal: AbortSignal.timeout(20000) },
                )
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                text = await res.text()
                mkdirSync(CACHE_DIR, { recursive: true })
                writeFileSync(cached, text)
                fetched++
            } catch (e) {
                failures.push(`${top}: ${e.cause?.code ?? e.message}`)
                if (existsSync(cached)) {
                    text = readFileSync(cached, "utf8")
                    fromCache++
                }
            }
        }

        if (text) for (const t of parseCsv(text)) types.push({ ...t, top })
    }

    const status =
        types.length === 0
            ? "unavailable"
            : failures.length
              ? "partial"
              : fetched
                ? "fetched"
                : "cached"
    return { types, status, fetched, fromCache, failures }
}

const main = async () => {
    const current = JSON.parse(readFileSync(CURRENT, "utf8"))
    const proposed = gitJson(PR_REV)
    const registry = await loadRegistry()

    /**
     * Every path the site publishes today, and who claims it.
     *
     * Mirrors lib/pages.ts buildPages(). `relatedTo` is deliberately absent: it
     * renders a link but does not create a page.
     */
    const claimed = new Map()
    const claim = (p, owner, via) => {
        if (!claimed.has(p)) claimed.set(p, [])
        claimed.get(p).push(`${owner} (${via})`)
    }
    for (const entry of current) {
        claim(entry.name, entry.name, "canonical")
        for (const key of ["deprecates", "parentOf", "alternativeTo"]) {
            for (const target of entry.links[key] ?? [])
                claim(target, entry.name, key)
        }
    }

    /**
     * Compared case-insensitively on purpose. IANA registers audio/MP4A-LATM
     * while the site publishes audio/mp4a-latm; they are the same type, and
     * offering the registry spelling as a candidate would duplicate a page.
     */
    const claimedLower = new Map()
    for (const [p, owners] of claimed) claimedLower.set(p.toLowerCase(), owners)

    // name (lowercased) -> candidate
    const candidates = new Map()
    const add = (name, source, extra) => {
        const key = name.toLowerCase()
        const existing = candidates.get(key)
        if (existing) {
            existing.sources.add(source)
            Object.assign(existing, extra ?? {})
            return
        }
        candidates.set(key, {
            name,
            sources: new Set([source]),
            entry: null,
            ref: null,
            ...(extra ?? {}),
        })
    }

    for (const entry of proposed) add(entry.name, "pr68", { entry })
    for (const t of registry.types) add(t.name, "registry", { ref: t.ref })

    const currentNames = new Set(current.map(e => e.name.toLowerCase()))

    /**
     * Three outcomes, and the middle one is the interesting one.
     *
     * A candidate that is already an entry is simply done. A candidate that is
     * not an entry but whose name is already published is a conflict: the page
     * exists only as a stub generated from another entry's `deprecates`,
     * `parentOf` or `alternativeTo`, and adding an entry at that name would
     * overwrite it. Those five are exactly what closed PR #68.
     */
    const conflicts = []
    const eligible = []
    for (const c of candidates.values()) {
        const key = c.name.toLowerCase()
        if (currentNames.has(key)) continue
        const owners = claimedLower.get(key)
        if (owners) {
            conflicts.push({ entry: c, owners })
            continue
        }
        eligible.push(c)
    }
    eligible.sort((a, b) => a.name.localeCompare(b.name))

    const sourceOf = c => (c.sources.has("pr68") ? "branch" : "registry-only")
    const fileTypesOf = c => c.entry?.fileTypes ?? []

    // ---------------------------------------------------------------- --json
    if (flag("--json")) {
        const wanted = new Set(named.map(n => n.toLowerCase()))
        const picked = eligible.filter(e => wanted.has(e.name.toLowerCase()))
        const missing = [...wanted].filter(
            w => !picked.some(e => e.name.toLowerCase() === w),
        )
        if (missing.length) {
            console.error(`not in the eligible pool: ${missing.join(", ")}`)
            process.exit(1)
        }
        console.log(
            JSON.stringify(
                picked.map(c =>
                    c.entry
                        ? { source: "branch", ...c.entry }
                        : {
                              source: "registry-only",
                              reference: c.ref,
                              name: c.name,
                              description: "",
                              links: {
                                  deprecates: [],
                                  relatedTo: [],
                                  parentOf: [],
                                  alternativeTo: [],
                              },
                              fileTypes: [],
                              furtherReading: [],
                              notices: {
                                  hasNoOfficial: false,
                                  communityContributed: false,
                                  popularUsage: null,
                              },
                          },
                ),
                null,
                2,
            ),
        )
        process.exit(0)
    }

    // -------------------------------------------------------------- summary
    const prefixArg = args.indexOf("--prefix")
    const prefix = prefixArg !== -1 ? args[prefixArg + 1] : null

    const fromBranch = eligible.filter(c => c.sources.has("pr68"))
    const registryOnly = eligible.filter(c => !c.sources.has("pr68"))

    console.log(
        `Current data:   ${current.length} entries, ${claimed.size} pages`,
    )
    console.log(`PR #68 branch:  ${proposed.length} entries`)
    console.log(
        `IANA registry:  ${registry.types.length} registered types (${registry.status})`,
    )
    if (registry.failures?.length) {
        for (const f of registry.failures)
            console.log(`                could not fetch ${f}`)
    }
    if (registry.status === "unavailable") {
        console.log(
            `                no cache and no network: branch candidates only`,
        )
    }
    console.log(`\nEligible:       ${eligible.length}`)
    console.log(
        `  ${String(fromBranch.length).padStart(5)}  from the PR #68 branch (extensions included)`,
    )
    console.log(
        `  ${String(registryOnly.length).padStart(5)}  from the IANA registry only (read the registration for extensions)`,
    )

    console.log(
        `\nConflicts (${conflicts.length}) -- these claim a path that already exists:`,
    )
    for (const { entry, owners } of conflicts) {
        console.log(`  ${entry.name}  <-  ${owners.join(", ")}`)
    }

    const byTopLevel = {}
    for (const e of eligible) {
        const top = e.name.split("/")[0]
        byTopLevel[top] = (byTopLevel[top] ?? 0) + 1
    }
    console.log(`\nEligible by top-level type:`)
    for (const [k, v] of Object.entries(byTopLevel).sort(
        (a, b) => b[1] - a[1],
    )) {
        console.log(`  ${String(v).padStart(4)}  ${k}`)
    }

    const uppercase = eligible.filter(e => e.name !== e.name.toLowerCase())
    console.log(
        `\nEligible with uppercase names (rejected by validate-data.js): ${uppercase.length}`,
    )

    if (flag("--list") || prefix) {
        const shown = prefix
            ? eligible.filter(e => e.name.startsWith(prefix))
            : eligible
        console.log(`\n${shown.length} name(s):`)
        for (const e of shown) {
            const exts = fileTypesOf(e).join(" ")
            console.log(
                `  ${e.name.padEnd(46)} ${sourceOf(e).padEnd(14)} ${exts}`,
            )
        }
    }
}

main()
