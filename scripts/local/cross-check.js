#!/usr/bin/env node
/**
 * Fork-only. Not part of any upstream pull request.
 *
 * Checks furtherReading URLs without fetching them.
 *
 * This exists because check-links.js needs to reach iana.org and
 * rfc-editor.org, and some environments deny both. It is a weaker check and
 * not a replacement: it confirms that a type is registered and that the URL we
 * cite is the one the registry uses, but it cannot tell whether the page loads
 * today. Run check-links.js as well wherever the network allows it.
 *
 * The evidence is jshttp/mime-db's copy of the IANA registry, which is
 * generated from the registry itself and records, per type, the registry URL
 * and the RFC that registered it. It is served from raw.githubusercontent.com,
 * which tends to be reachable where iana.org is not.
 *
 * Usage: node scripts/local/cross-check.js [baseRev]
 */

const { execSync } = require("child_process")
const { readFileSync } = require("fs")
const path = require("path")

const ROOT = path.join(__dirname, "..", "..")
const BASE_REV = process.argv[2] ?? process.env.BASE_REV ?? "upstream/master"
const MIRROR =
    "https://raw.githubusercontent.com/jshttp/mime-db/master/src/iana-types.json"

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

const run = async () => {
    let mirror
    try {
        const res = await fetch(MIRROR, { signal: AbortSignal.timeout(60000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        mirror = await res.json()
    } catch (e) {
        console.error(`Could not fetch the registry mirror: ${e.message}`)
        console.error(MIRROR)
        process.exit(1)
    }

    console.log(
        `Cross-checking ${added.length} new entr(ies) against the IANA registry mirror.\n`,
    )

    const unregistered = []
    const urlMismatch = []
    const rfcConfirmed = []
    const rfcUnconfirmed = []
    const unknownHost = []

    for (const entry of added) {
        const record = mirror[entry.name]
        const sources = record?.sources ?? []

        if (!record) unregistered.push(entry.name)

        for (const ref of entry.furtherReading ?? []) {
            const { url } = ref

            if (url.includes("iana.org")) {
                if (!sources.includes(url)) {
                    urlMismatch.push(
                        `${entry.name}\n    ours:   ${url}\n    mirror: ${sources.filter(s => s.includes("iana.org")).join(", ") || "(none)"}`,
                    )
                }
                continue
            }

            const rfc = url.match(/rfc(\d+)/i)
            if (rfc) {
                const cited = sources.some(s =>
                    s.toLowerCase().includes(`rfc${rfc[1]}.`),
                )
                const line = `${entry.name} -> RFC ${rfc[1]}`
                if (cited) rfcConfirmed.push(line)
                else rfcUnconfirmed.push(line)
                continue
            }

            unknownHost.push(`${entry.name}  ${url}`)
        }
    }

    const report = (label, list) => {
        if (!list.length) return
        console.log(`${label} (${list.length}):`)
        for (const item of list) console.log(`  - ${item}`)
        console.log()
    }

    console.log(
        `RFC citations corroborated by the mirror: ${rfcConfirmed.length}`,
    )
    for (const line of rfcConfirmed) console.log(`  - ${line}`)
    console.log()

    report("Types the mirror does not list as IANA-registered", unregistered)
    report("IANA URLs that differ from the registry's own", urlMismatch)
    report(
        "RFC citations the mirror does not corroborate - check these by hand",
        rfcUnconfirmed,
    )
    report("Links to hosts this check cannot verify", unknownHost)

    const hard = unregistered.length + urlMismatch.length
    if (hard) {
        console.error(
            `${hard} problem(s) the mirror positively contradicts. Fix before shipping.`,
        )
        process.exit(1)
    }

    console.log(
        "No contradictions found. This is not proof the pages load - " +
            "run scripts/local/check-links.js where the network permits.",
    )
}

run()
