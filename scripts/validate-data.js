#!/usr/bin/env node
/**
 * Structural validation for src/mimeData.json.
 *
 * gatsby-node.js creates a page for every string listed under a type's
 * `deprecates`, `parentOf` and `alternativeTo` links. When one of those
 * collides with another entry's page, Gatsby's createPage silently overwrites
 * and the last write wins -- which has previously caused curated pages to be
 * replaced by empty stubs. The collision ratchet below exists to catch that in
 * review rather than in production.
 *
 * `relatedTo` is the one link key that does *not* generate a page. The template
 * still renders every one of its targets as a link, and the site serves only
 * pages built ahead of time, so a target nothing else publishes is a link
 * straight to a 404. The dangling ratchet catches those the same way.
 */

const fs = require("fs")
const path = require("path")

const DATA_PATH = path.join(__dirname, "..", "src", "mimeData.json")

/**
 * Known-good number of colliding page paths on master.
 *
 * These are the mutually-deprecating pairs tracked in issue #67. The check
 * fails if a change introduces *more* collisions, so the number may be lowered
 * as they are fixed but never raised without a deliberate edit here.
 */
const COLLISION_BASELINE = 15

/**
 * Known-good number of `relatedTo` targets that no page is generated for.
 *
 * Counted per missing page, matching the collision baseline above, which counts
 * paths rather than the claims on them. Two pages are missing today and two
 * links point at them: `text/x-log` from text/plain, and `mimetype/test` from
 * test/mimetype.
 *
 * As with collisions, the check fails only if a change adds more, so this may
 * be lowered as they are fixed but never raised without a deliberate edit here.
 * It started at 3. Adding an `audio/3gpp` entry fixed the four links that
 * video/3gpp, video/mp4, audio/mp4 and audio/mp4a-latm pointed at, so the
 * baseline came down with them.
 */
const DANGLING_BASELINE = 2

/**
 * Entries whose `name` is not a valid `type/subtype`.
 *
 * "gcode" predates this check and is live at /gcode, so renaming it would break
 * an indexed URL. It is allowed through deliberately; new malformed names are
 * still rejected. Remove from this list once the entry is given a real media
 * type and a redirect.
 */
const KNOWN_MALFORMED_NAMES = new Set(["gcode"])

const LINK_KEYS = ["deprecates", "relatedTo", "parentOf", "alternativeTo"]
const KNOWN_KEYS = new Set([
    "name",
    "description",
    "fileTypes",
    "links",
    "notices",
    "furtherReading",
])

const errors = []
const warnings = []

const err = (name, msg) => errors.push(`${name}: ${msg}`)
const warn = msg => warnings.push(msg)

let raw
try {
    raw = fs.readFileSync(DATA_PATH, "utf8")
} catch (e) {
    console.error(`Could not read ${DATA_PATH}: ${e.message}`)
    process.exit(1)
}

let data
try {
    data = JSON.parse(raw)
} catch (e) {
    console.error(`mimeData.json is not valid JSON: ${e.message}`)
    process.exit(1)
}

if (!Array.isArray(data)) {
    console.error("mimeData.json must contain a top-level array")
    process.exit(1)
}

// --- shape ---------------------------------------------------------------
for (const entry of data) {
    const name = entry && entry.name ? entry.name : "<unnamed entry>"

    if (typeof entry.name !== "string" || !entry.name.trim()) {
        err(name, "missing a string `name`")
        continue
    }
    if (
        !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-zA-Z0-9!#$&^_.+-]+$/.test(entry.name)
    ) {
        if (KNOWN_MALFORMED_NAMES.has(entry.name)) {
            warn(
                `${entry.name}: not a well-formed \`type/subtype\` (known, allowed)`,
            )
        } else {
            err(entry.name, "name is not a well-formed `type/subtype`")
        }
    }
    if (entry.name !== entry.name.toLowerCase()) {
        err(
            entry.name,
            "name contains uppercase; page paths are case-sensitive and every " +
                "other entry is lowercase",
        )
    }
    /**
     * Descriptions are Markdown, rendered to React elements on the server.
     *
     * They used to be raw HTML injected with dangerouslySetInnerHTML, which
     * made a malicious pull request against this file a stored-XSS route (#4).
     * The renderer no longer parses embedded HTML, so a tag here would show up
     * as literal text on the page rather than execute — but rejecting it
     * outright keeps the data honest and the intent obvious to contributors.
     */
    if (typeof entry.description === "string") {
        const tag = entry.description.match(/<\s*\/?\s*[a-zA-Z][^>]*>/)
        if (tag) {
            err(
                entry.name,
                `description contains HTML (${tag[0]}). Descriptions are ` +
                    "Markdown: use **bold**, `code`, [text](/link) and a blank " +
                    "line between paragraphs.",
            )
        }
    }

    if (!Array.isArray(entry.fileTypes)) {
        err(entry.name, "`fileTypes` must be an array")
    } else {
        for (const ext of entry.fileTypes) {
            if (!/^\.[A-Za-z0-9._+-]+$/.test(ext)) {
                err(
                    entry.name,
                    `file extension "${ext}" should look like ".ext"`,
                )
            }
        }
    }

    if (!entry.links || typeof entry.links !== "object") {
        err(entry.name, "`links` object is missing")
    } else {
        for (const key of LINK_KEYS) {
            if (!Array.isArray(entry.links[key])) {
                err(entry.name, `links.${key} must be an array`)
                continue
            }
            if (entry.links[key].includes(entry.name)) {
                err(entry.name, `links.${key} refers to itself`)
            }
        }
    }

    if (!entry.notices || typeof entry.notices !== "object") {
        err(entry.name, "`notices` object is missing")
    } else {
        for (const flag of ["hasNoOfficial", "communityContributed"]) {
            if (typeof entry.notices[flag] !== "boolean") {
                err(entry.name, `notices.${flag} must be a boolean`)
            }
        }
        if (!("popularUsage" in entry.notices)) {
            err(
                entry.name,
                "notices.popularUsage must be present (string or null)",
            )
        }
    }

    if (entry.furtherReading !== undefined) {
        if (!Array.isArray(entry.furtherReading)) {
            err(entry.name, "`furtherReading` must be an array")
        } else {
            for (const ref of entry.furtherReading) {
                if (
                    !ref ||
                    typeof ref.title !== "string" ||
                    typeof ref.url !== "string"
                ) {
                    err(
                        entry.name,
                        "furtherReading entries need a title and url",
                    )
                    continue
                }
                let url
                try {
                    url = new URL(ref.url)
                } catch {
                    err(
                        entry.name,
                        `furtherReading url is not a valid URL: ${ref.url}`,
                    )
                    continue
                }
                if (url.protocol !== "https:" && url.protocol !== "http:") {
                    err(
                        entry.name,
                        `furtherReading url must be http(s): ${ref.url}`,
                    )
                }
                if (url.username || url.password) {
                    err(
                        entry.name,
                        `furtherReading url must not embed credentials`,
                    )
                }
            }
        }
    }

    for (const key of Object.keys(entry)) {
        if (!KNOWN_KEYS.has(key)) {
            warn(`${entry.name}: unrecognised key "${key}"`)
        }
    }
}

// --- duplicate names -----------------------------------------------------
const seen = new Map()
for (const entry of data) {
    if (typeof entry.name !== "string") continue
    const key = entry.name.toLowerCase()
    if (seen.has(key)) {
        err(entry.name, `duplicate entry (also defined as "${seen.get(key)}")`)
    } else {
        seen.set(key, entry.name)
    }
}

// --- page path collisions ------------------------------------------------
const owners = new Map()
const claim = (pagePath, owner, via) => {
    if (!owners.has(pagePath)) owners.set(pagePath, [])
    owners.get(pagePath).push(`${owner} (${via})`)
}

for (const entry of data) {
    if (typeof entry.name !== "string" || !entry.links) continue
    claim(entry.name, entry.name, "canonical")
    for (const key of ["deprecates", "parentOf", "alternativeTo"]) {
        for (const target of entry.links[key] || []) {
            claim(target, entry.name, key)
        }
    }
}

const collisions = [...owners.entries()].filter(([, v]) => v.length > 1)

// --- dangling relatedTo targets ------------------------------------------
/**
 * `owners` is keyed by every path the site publishes, so anything a relatedTo
 * points at that is missing from it has no page and never will.
 */
const dangling = new Map()
for (const entry of data) {
    if (typeof entry.name !== "string" || !entry.links) continue
    for (const target of entry.links.relatedTo || []) {
        if (owners.has(target)) continue
        if (!dangling.has(target)) dangling.set(target, [])
        dangling.get(target).push(entry.name)
    }
}

// --- report --------------------------------------------------------------
console.log(`Validated ${data.length} mimetype entries.`)

if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`)
    for (const w of warnings) console.log(`  - ${w}`)
}

if (collisions.length) {
    console.log(
        `\n${collisions.length} page path(s) generated more than once ` +
            `(baseline ${COLLISION_BASELINE}):`,
    )
    for (const [pagePath, claimants] of collisions) {
        console.log(`  - /${pagePath}  <-  ${claimants.join(", ")}`)
    }
}

if (dangling.size) {
    console.log(
        `\n${dangling.size} relatedTo target(s) with no page ` +
            `(baseline ${DANGLING_BASELINE}):`,
    )
    for (const [target, referrers] of dangling) {
        console.log(`  - /${target}  <-  ${referrers.join(", ")}`)
    }
}

if (dangling.size > DANGLING_BASELINE) {
    errors.push(
        `dangling relatedTo targets rose from ${DANGLING_BASELINE} to ${dangling.size}. ` +
            `The template renders every relatedTo target as a link, but only ` +
            `"deprecates", "parentOf" and "alternativeTo" generate pages, so each ` +
            `of these is a link to a 404. Either give the target its own entry, or ` +
            `point the relatedTo at a type that already has a page.`,
    )
} else if (dangling.size < DANGLING_BASELINE) {
    console.log(
        `\nDangling relatedTo targets are down to ${dangling.size}. ` +
            `Lower DANGLING_BASELINE in this file to ${dangling.size} to hold the gain.`,
    )
}

if (collisions.length > COLLISION_BASELINE) {
    errors.push(
        `page path collisions rose from ${COLLISION_BASELINE} to ${collisions.length}. ` +
            `Each collision means one entry's page silently overwrites another's. ` +
            `Prefer "relatedTo" for cross-references between types that both have ` +
            `their own entry, since it does not generate pages.`,
    )
}

if (errors.length) {
    console.error(`\n${errors.length} error(s):`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
}

console.log("\nData validation passed.")
