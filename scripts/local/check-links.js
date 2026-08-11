#!/usr/bin/env node
/**
 * Fork-only. Not part of any upstream pull request.
 *
 * Resolves every furtherReading URL on entries that are new relative to a base
 * revision. scripts/validate-data.js only checks that the URL parses, and five
 * of the types extracted for PR #68 cite an IANA registry page for a type that
 * is not in the registry. The fork's own history includes "docs: fix
 * avif-sequence dead link", so this is a recurring failure mode.
 *
 * Redirects are followed by hand rather than by fetch, because a 200 at the end
 * of a redirect chain says nothing about where you landed. The registration for
 * audio/prs.sid cites a geocities URL that answers 301 and lands on yahoo.com;
 * with `redirect: "follow"` that reported as a working link.
 *
 * Usage: node scripts/local/check-links.js [baseRev]
 *        node scripts/local/check-links.js --self-test
 */

const { execSync } = require("child_process")
const { readFileSync } = require("fs")
const path = require("path")

const ROOT = path.join(__dirname, "..", "..")
const SELF_TEST = process.argv.includes("--self-test")
const BASE_REV =
    process.argv.slice(2).find(a => !a.startsWith("--")) ??
    process.env.BASE_REV ??
    "upstream/master"
const CONCURRENCY = 6
const MAX_HOPS = 6

/**
 * Host changes we accept, as `"from -> to": "why"`.
 *
 * A link that ends up on a different host than the one it names is a failure by
 * default: that is how a citation quietly turns into someone's homepage. If a
 * host change is legitimate, prefer rewriting the link to its destination. Add
 * an entry here only when the redirect is the stable public address and the
 * original is the one worth citing, and say why, the way COLLISION_BASELINE and
 * DANGLING_BASELINE in scripts/validate-data.js are meant to be edited.
 */
const ACCEPTED_HOST_CHANGES = {}

/** Only needed for a real run; --self-test probes fixed URLs and touches no data. */
const collectJobs = () => {
    const baseNames = new Set(
        JSON.parse(
            execSync(`git show ${BASE_REV}:src/mimeData.json`, {
                cwd: ROOT,
                maxBuffer: 128 * 1024 * 1024,
            }).toString(),
        ).map(e => e.name.toLowerCase()),
    )

    const data = JSON.parse(
        readFileSync(path.join(ROOT, "src", "mimeData.json"), "utf8"),
    )
    const added = data.filter(e => !baseNames.has(e.name.toLowerCase()))

    const jobs = []
    for (const entry of added) {
        for (const ref of entry.furtherReading ?? []) {
            jobs.push({ name: entry.name, title: ref.title, url: ref.url })
        }
    }

    console.log(
        `Checking ${jobs.length} link(s) across ${added.length} new entr(ies) vs ${BASE_REV}.\n`,
    )
    return jobs
}

/** Walks the redirect chain one hop at a time so the destination stays visible. */
const follow = async (url, method) => {
    const chain = []
    let current = url
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
        const res = await fetch(current, {
            method,
            redirect: "manual",
            signal: AbortSignal.timeout(20000),
            headers: { "user-agent": "mimetype.io-link-check" },
        })
        const location = res.headers.get("location")
        const redirecting = res.status >= 300 && res.status < 400 && location
        if (!redirecting)
            return { status: res.status, finalUrl: current, chain }
        chain.push(`${res.status} ${current}`)
        current = new URL(location, current).toString()
    }
    return {
        status: "too many redirects",
        finalUrl: current,
        chain,
        tooMany: true,
    }
}

/**
 * HEAD first, then GET on anything that isn't a clean 2xx: a number of spec
 * hosts (ITU, ISO) reject HEAD outright but serve GET fine, and reporting those
 * as broken would train us to ignore the output.
 */
const probe = async url => {
    for (const method of ["HEAD", "GET"]) {
        try {
            const r = await follow(url, method)
            const done = { method, finalUrl: r.finalUrl, chain: r.chain }
            if (r.tooMany) {
                if (method === "GET")
                    return { ok: false, status: r.status, ...done }
                continue
            }
            if (r.status >= 200 && r.status < 300)
                return { ok: true, status: r.status, ...done }
            if (method === "GET")
                return { ok: false, status: r.status, ...done }
        } catch (e) {
            if (method === "GET")
                return {
                    ok: false,
                    status: e.cause?.code ?? e.name ?? "error",
                    method,
                    finalUrl: url,
                    chain: [],
                }
        }
    }
    return {
        ok: false,
        status: "unknown",
        method: "GET",
        finalUrl: url,
        chain: [],
    }
}

const hostOf = u => {
    try {
        return new URL(u).host
    } catch {
        return null
    }
}

/**
 * Classifies a resolved link as "ok", "moved" (same host, different path) or
 * "cross-host". Only cross-host is a failure, because flagging the 36 links that
 * rfc-editor.org canonicalises from /rfc/NNNN to /info/NNNN/ every run would
 * make the output worth ignoring.
 */
const classify = result => {
    if (!result.ok) return "broken"
    const from = hostOf(result.url)
    const to = hostOf(result.finalUrl)
    if (!from || !to || from === to)
        return result.finalUrl !== result.url ? "moved" : "ok"
    if (ACCEPTED_HOST_CHANGES[`${from} -> ${to}`]) return "accepted"
    return "cross-host"
}

const MARK = {
    ok: ".",
    moved: ">",
    accepted: "~",
    "cross-host": "!",
    broken: "x",
}

const run = async () => {
    const jobs = collectJobs()
    const results = []
    let cursor = 0
    const worker = async () => {
        while (cursor < jobs.length) {
            const job = jobs[cursor++]
            const res = await probe(job.url)
            const row = { ...job, ...res }
            row.verdict = classify(row)
            results.push(row)
            process.stdout.write(MARK[row.verdict])
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    process.stdout.write("\n")

    const of = v => results.filter(r => r.verdict === v)
    const broken = of("broken")
    const crossHost = of("cross-host")

    if (broken.length) {
        console.error(`\n${broken.length} broken link(s):`)
        for (const b of broken)
            console.error(`  ${b.name}\n    ${b.status}  ${b.url}`)
    }

    if (crossHost.length) {
        console.error(
            `\n${crossHost.length} link(s) redirect to a different host. A citation ` +
                `that lands somewhere else is not a working link, however healthy the ` +
                `final status looks. Point the link at where it actually goes, or drop ` +
                `it, or add the host change to ACCEPTED_HOST_CHANGES with a reason.`,
        )
        for (const c of crossHost) {
            console.error(`  ${c.name}`)
            console.error(`    from: ${c.url}`)
            for (const hop of c.chain) console.error(`          ${hop}`)
            console.error(`    to:   ${c.status}  ${c.finalUrl}`)
        }
    }

    const summary =
        `${results.length} link(s): ${of("ok").length} direct, ` +
        `${of("moved").length} same-host redirect(s)` +
        (of("accepted").length
            ? `, ${of("accepted").length} accepted host change(s)`
            : "")

    if (broken.length || crossHost.length) {
        console.error(
            `\n${summary}, ${broken.length} broken, ${crossHost.length} cross-host.`,
        )
        process.exit(1)
    }
    console.log(`\nAll ${summary}. Every link ends on the host it names.`)
}

/**
 * Proves the check still catches what it was written for, without waiting for a
 * batch to reintroduce it. The geocities URL is the one that motivated this: it
 * answers 301 and lands on yahoo.com, and used to pass.
 */
const selfTest = async () => {
    const cases = [
        {
            want: "cross-host",
            url: "http://www.geocities.com/SiliconValley/Lakes/5147/sidplay/docs.html",
            why: "the audio/prs.sid published specification, dead since 2009",
        },
        {
            want: "moved",
            url: "https://www.rfc-editor.org/rfc/rfc9559",
            why: "rfc-editor canonicalises /rfc/N to /info/N/ on the same host",
        },
        {
            want: "ok",
            url: "https://www.iana.org/assignments/media-types/audio/AMR",
            why: "resolves with no redirect at all",
        },
    ]
    let failed = 0
    for (const c of cases) {
        const res = await probe(c.url)
        const got = classify({ ...c, ...res })
        const pass = got === c.want
        if (!pass) failed++
        console.log(
            `${pass ? "PASS" : "FAIL"}  expected ${c.want.padEnd(10)} got ${got.padEnd(10)} ${c.url}`,
        )
        console.log(`        ${c.why}`)
        if (res.chain.length)
            for (const hop of res.chain) console.log(`        ${hop}`)
        if (res.finalUrl !== c.url)
            console.log(`        -> ${res.status} ${res.finalUrl}`)
    }
    console.log(
        failed ? `\n${failed} self-test(s) failed.` : "\nSelf-tests passed.",
    )
    process.exit(failed ? 1 : 0)
}

if (SELF_TEST) selfTest()
else run()
