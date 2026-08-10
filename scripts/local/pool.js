#!/usr/bin/env node
/**
 * Fork-only. Not part of any upstream pull request.
 *
 * Reports which of the 916 types proposed in PR #68 are still eligible to be
 * added, by subtracting everything the current src/mimeData.json already
 * publishes -- both canonical entries and the stub pages generated from
 * `deprecates`, `parentOf` and `alternativeTo`.
 *
 * That subtraction is the whole point: the PR was closed because entries
 * appended at the end of the array silently overwrote pages that other entries
 * had already claimed.
 *
 * Usage:
 *   node scripts/local/pool.js              # summary
 *   node scripts/local/pool.js --list       # every eligible name
 *   node scripts/local/pool.js --prefix image/
 *   node scripts/local/pool.js --json image/jxl image/apng
 */

const { execSync } = require("child_process")
const { readFileSync } = require("fs")
const path = require("path")

/** The head of the closed PR #68 branch, our source of extracted data. */
const PR_REV = "c52ef8c"

const CURRENT = path.join(__dirname, "..", "..", "src", "mimeData.json")

const gitJson = rev =>
    JSON.parse(
        execSync(`git show ${rev}:src/mimeData.json`, {
            cwd: path.join(__dirname, "..", ".."),
            maxBuffer: 128 * 1024 * 1024,
        }).toString(),
    )

const current = JSON.parse(readFileSync(CURRENT, "utf8"))
const proposed = gitJson(PR_REV)

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

const currentNames = new Set(current.map(e => e.name.toLowerCase()))
const additions = proposed.filter(e => !currentNames.has(e.name.toLowerCase()))

const conflicts = []
const eligible = []
for (const entry of additions) {
    const owners =
        claimed.get(entry.name) ?? claimed.get(entry.name.toLowerCase())
    if (owners) conflicts.push({ entry, owners })
    else eligible.push(entry)
}

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const named = args.filter(a => !a.startsWith("--"))

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
    console.log(JSON.stringify(picked, null, 2))
    process.exit(0)
}

const prefixArg = args.indexOf("--prefix")
const prefix = prefixArg !== -1 ? args[prefixArg + 1] : null

console.log(`Current data:   ${current.length} entries, ${claimed.size} pages`)
console.log(`PR #68 branch:  ${proposed.length} entries`)
console.log(`Not yet added:  ${additions.length}`)
console.log(`Eligible:       ${eligible.length}`)
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
for (const [k, v] of Object.entries(byTopLevel).sort((a, b) => b[1] - a[1])) {
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
        console.log(`  ${e.name.padEnd(56)} ${e.fileTypes.join(" ")}`)
    }
}
