#!/usr/bin/env node
/**
 * Fork-only. Not part of any upstream pull request.
 *
 * Two checks that scripts/validate-data.js does not make, run against the
 * working copy of src/mimeData.json:
 *
 *   1. Which pages are claimed more than once, and by whom. validate-data.js
 *      reports a count against COLLISION_BASELINE; this prints the diff against
 *      upstream so a new collision is attributable to a specific entry.
 *
 *   2. Dangling `relatedTo` targets. app/[...mimetype]/page.tsx sets
 *      dynamicParams = false and renders every relatedTo target as a <Link>, so
 *      a target with neither an entry nor a generated page is a hard 404.
 *      Nothing in the upstream suite catches this; upstream ships six today.
 *
 * Exits non-zero if the batch adds a collision or a dangling link.
 */

const { execSync } = require("child_process")
const { readFileSync } = require("fs")
const path = require("path")

const ROOT = path.join(__dirname, "..", "..")
const BASE_REV = process.env.BASE_REV ?? "upstream/master"

const load = rev =>
    rev === null
        ? JSON.parse(
              readFileSync(path.join(ROOT, "src", "mimeData.json"), "utf8"),
          )
        : JSON.parse(
              execSync(`git show ${rev}:src/mimeData.json`, {
                  cwd: ROOT,
                  maxBuffer: 128 * 1024 * 1024,
              }).toString(),
          )

/** Mirrors lib/pages.ts buildPages(). relatedTo does not generate a page. */
const analyse = data => {
    const owners = new Map()
    const claim = (p, owner, via) => {
        if (!owners.has(p)) owners.set(p, [])
        owners.get(p).push(`${owner} (${via})`)
    }
    for (const entry of data) {
        claim(entry.name, entry.name, "canonical")
        for (const key of ["deprecates", "parentOf", "alternativeTo"]) {
            for (const t of entry.links[key] ?? []) claim(t, entry.name, key)
        }
    }

    /**
     * Counted per missing page, not per broken link, so this agrees with
     * DANGLING_BASELINE in scripts/validate-data.js. One missing page can be
     * linked from several entries -- audio/3gpp accounts for four of the six
     * broken links upstream but is a single missing page.
     */
    const dangling = new Map()
    for (const entry of data) {
        for (const t of entry.links.relatedTo ?? []) {
            if (owners.has(t)) continue
            if (!dangling.has(t)) dangling.set(t, [])
            dangling.get(t).push(entry.name)
        }
    }

    return {
        pages: owners.size,
        collisions: [...owners.entries()].filter(([, v]) => v.length > 1),
        dangling: [...dangling.entries()].map(
            ([target, from]) => `${target} (from ${from.join(", ")})`,
        ),
        danglingLinks: [...dangling.values()].reduce((n, f) => n + f.length, 0),
        owners,
    }
}

const base = analyse(load(BASE_REV))
const head = analyse(load(null))

const fmt = list => new Set(list.map(([p]) => p))
const baseCollided = fmt(base.collisions)
const headCollided = fmt(head.collisions)

const summarise = (label, r) =>
    `${label} ${r.pages} pages, ${r.collisions.length} collisions, ` +
    `${r.dangling.length} missing relatedTo page(s) across ${r.danglingLinks} link(s)`

console.log(summarise(`base (${BASE_REV}): `, base))
console.log(summarise("working copy:      ", head))

const failures = []

const newCollisions = head.collisions.filter(([p]) => !baseCollided.has(p))
if (newCollisions.length) {
    failures.push(`${newCollisions.length} new page collision(s)`)
    console.log(`\nNEW collisions:`)
    for (const [p, who] of newCollisions)
        console.log(`  /${p}  <-  ${who.join(", ")}`)
}

const fixedCollisions = base.collisions.filter(([p]) => !headCollided.has(p))
if (fixedCollisions.length) {
    console.log(`\nResolved collisions:`)
    for (const [p] of fixedCollisions) console.log(`  /${p}`)
}

const baseDangling = new Set(base.dangling)
const newDangling = head.dangling.filter(d => !baseDangling.has(d))
if (newDangling.length) {
    failures.push(`${newDangling.length} new dangling relatedTo link(s)`)
    console.log(`\nNEW dangling relatedTo (these render as hard 404s):`)
    for (const d of newDangling) console.log(`  ${d}`)
}

if (base.dangling.length) {
    console.log(`\nPre-existing dangling relatedTo (upstream, not ours):`)
    for (const d of base.dangling) console.log(`  ${d}`)
}

if (failures.length) {
    console.error(`\nFAILED: ${failures.join("; ")}`)
    process.exit(1)
}

console.log(`\nAudit passed: no new collisions, no new dangling links.`)
