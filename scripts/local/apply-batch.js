#!/usr/bin/env node
/**
 * Fork-only. Not part of any upstream pull request.
 *
 * Merges a curated batch file into src/mimeData.json.
 *
 * Entries are appended as one contiguous block rather than interleaved by name.
 * The maintainer's objection to PR #68 was that a 22,189-line diff was not
 * reviewable; a contiguous block keeps the diff to the batch's own lines.
 *
 * Key order and indentation are normalised to the file's dominant convention
 * (2 spaces; name, description, links, fileTypes, furtherReading, notices) so
 * new entries are indistinguishable from hand-written ones. src/mimeData.json
 * is in .prettierignore, so nothing else will reformat it.
 *
 * Usage: node scripts/local/apply-batch.js scripts/local/batches/01-image.json
 */

const { readFileSync, writeFileSync } = require("fs")
const path = require("path")

const ROOT = path.join(__dirname, "..", "..")
const DATA = path.join(ROOT, "src", "mimeData.json")

const batchPath = process.argv[2]
if (!batchPath) {
    console.error("usage: node scripts/local/apply-batch.js <batch.json>")
    process.exit(1)
}

const data = JSON.parse(readFileSync(DATA, "utf8"))
const batch = JSON.parse(readFileSync(path.resolve(batchPath), "utf8"))

const existing = new Set(data.map(e => e.name.toLowerCase()))

/**
 * Paths the current data already publishes, including generated stub pages.
 * Adding an entry at one of these is the exact failure that closed PR #68.
 */
const claimed = new Set()
for (const entry of data) {
    claimed.add(entry.name)
    for (const key of ["deprecates", "parentOf", "alternativeTo"]) {
        for (const t of entry.links[key] ?? []) claimed.add(t)
    }
}

const problems = []
const normalised = []

for (const raw of batch) {
    const name = raw.name

    if (typeof name !== "string" || !name.trim()) {
        problems.push(`entry with no name: ${JSON.stringify(raw).slice(0, 80)}`)
        continue
    }
    if (name !== name.toLowerCase()) {
        problems.push(`${name}: uppercase name; validate-data.js rejects these`)
    }
    if (existing.has(name.toLowerCase())) {
        problems.push(`${name}: already an entry`)
    }
    if (claimed.has(name)) {
        problems.push(
            `${name}: already a generated page; adding it would overwrite`,
        )
    }
    if (!raw.description || !raw.description.trim()) {
        problems.push(
            `${name}: empty description; the batch exists to avoid these`,
        )
    }
    if (!Array.isArray(raw.fileTypes) || !raw.fileTypes.length) {
        problems.push(`${name}: no fileTypes`)
    }
    if (!raw.furtherReading?.length) {
        problems.push(`${name}: no furtherReading`)
    }

    normalised.push({
        name,
        description: raw.description ?? "",
        links: {
            deprecates: raw.links?.deprecates ?? [],
            relatedTo: raw.links?.relatedTo ?? [],
            parentOf: raw.links?.parentOf ?? [],
            alternativeTo: raw.links?.alternativeTo ?? [],
        },
        fileTypes: raw.fileTypes ?? [],
        furtherReading: raw.furtherReading ?? [],
        notices: {
            hasNoOfficial: raw.notices?.hasNoOfficial ?? false,
            communityContributed: raw.notices?.communityContributed ?? false,
            popularUsage: raw.notices?.popularUsage ?? null,
        },
    })
}

if (problems.length) {
    console.error(`${problems.length} problem(s) with ${batchPath}:`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
}

/**
 * Append textually rather than re-serialising the whole array.
 *
 * A JSON.stringify round-trip of the current file rewrites nine unrelated
 * lines, because a handful of entries are separated by a compact `},{`. Those
 * lines have nothing to do with the batch and would be noise in the diff, which
 * is precisely what the maintainer objected to.
 */
const raw = readFileSync(DATA, "utf8")
const closing = raw.lastIndexOf("]")
if (closing === -1) {
    console.error("src/mimeData.json has no closing bracket")
    process.exit(1)
}

const block = normalised
    .map(entry =>
        JSON.stringify(entry, null, 2)
            .split("\n")
            .map(line => `  ${line}`)
            .join("\n"),
    )
    .join(",\n")

const head = raw.slice(0, closing).trimEnd()
writeFileSync(DATA, `${head},\n${block}\n]\n`)

console.log(
    `Appended ${normalised.length} entr(ies). src/mimeData.json is now ${data.length + normalised.length} entries.`,
)
console.log(
    `Next: node scripts/validate-data.js && node scripts/local/audit.js`,
)
