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
 * Usage: node scripts/local/check-links.js [baseRev]
 */

const { execSync } = require("child_process")
const { readFileSync } = require("fs")
const path = require("path")

const ROOT = path.join(__dirname, "..", "..")
const BASE_REV = process.argv[2] ?? process.env.BASE_REV ?? "upstream/master"
const CONCURRENCY = 6

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

/**
 * HEAD first, then GET on anything that isn't a clean 2xx: a number of spec
 * hosts (ITU, ISO) reject HEAD outright but serve GET fine, and reporting those
 * as broken would train us to ignore the output.
 */
const probe = async url => {
    for (const method of ["HEAD", "GET"]) {
        try {
            const res = await fetch(url, {
                method,
                redirect: "follow",
                signal: AbortSignal.timeout(20000),
                headers: { "user-agent": "mimetype.io-link-check" },
            })
            if (res.ok) return { ok: true, status: res.status, method }
            if (method === "GET")
                return { ok: false, status: res.status, method }
        } catch (e) {
            if (method === "GET")
                return { ok: false, status: e.name ?? "error", method }
        }
    }
    return { ok: false, status: "unknown", method: "GET" }
}

const run = async () => {
    const results = []
    let cursor = 0
    const worker = async () => {
        while (cursor < jobs.length) {
            const job = jobs[cursor++]
            const res = await probe(job.url)
            results.push({ ...job, ...res })
            process.stdout.write(res.ok ? "." : "x")
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    process.stdout.write("\n")

    const broken = results.filter(r => !r.ok)
    if (broken.length) {
        console.error(`\n${broken.length} broken link(s):`)
        for (const b of broken) {
            console.error(`  ${b.name}\n    ${b.status}  ${b.url}`)
        }
        process.exit(1)
    }
    console.log(`\nAll ${results.length} links resolved.`)
}

run()
