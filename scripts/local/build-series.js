#!/usr/bin/env node
/**
 * Fork-only. Not part of any upstream pull request.
 *
 * Builds the pull request series planned by slice-series.js: one branch per
 * slice, each based on the one before it, so every pull request adds only its
 * own entries and renders without a "Load diff" click.
 *
 * The branches are built with plumbing rather than checkouts. Every commit is
 * assembled in a throwaway index under GIT_INDEX_FILE, so the working tree and
 * the real index are never touched and the run is safe to repeat with
 * uncommitted work in progress.
 *
 * Two files move. src/mimeData.json gains the slice, appended textually the way
 * apply-batch.js does it, so no JSON round-trip rewrites unrelated lines.
 * scripts/validate-data.js arrives in the first commit with the dangling-link
 * check, at a baseline of 3, and drops to 2 in the slice that adds audio/3gpp,
 * which is the entry that fixes four of those links. Getting that order wrong
 * makes an intermediate pull request fail its own CI.
 *
 * Verification runs the real validator against each intermediate state by
 * writing it into the working tree, checking it, and restoring the tree. That
 * is the only way to be sure every pull request in the series passes on its
 * own rather than only at the end.
 *
 * Usage:
 *   node scripts/local/build-series.js              # build and verify
 *   node scripts/local/build-series.js --no-verify  # build only
 *   node scripts/local/build-series.js --prefix pr/ # branch name prefix
 */

const { execFileSync } = require("child_process")
const {
    readFileSync,
    writeFileSync,
    readdirSync,
    mkdtempSync,
    rmSync,
} = require("fs")
const os = require("os")
const path = require("path")

const ROOT = path.join(__dirname, "..", "..")
const SERIES = path.join(__dirname, "series")
const DATA = path.join(ROOT, "src", "mimeData.json")
const VALIDATOR = path.join(ROOT, "scripts", "validate-data.js")

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const value = name => {
    const i = argv.indexOf(name)
    if (i === -1) return null
    const next = argv[i + 1]
    return next === undefined || next.startsWith("--") ? null : next
}

const BASE = value("--base") ?? "upstream/master"
const PREFIX = value("--prefix") ?? "pr/"

/**
 * The commit that first added the dangling-link check, at a baseline of 3, and
 * the entry whose arrival lets it drop to 2.
 */
const VALIDATOR_AT_THREE = "9eba8fc"
const VALIDATOR_AT_TWO = "HEAD"
const LOWERS_THE_BASELINE = "audio/3gpp"

const git = (args, opts = {}) =>
    execFileSync("git", args, { cwd: ROOT, maxBuffer: 1e9, ...opts })
const gitText = (args, opts = {}) =>
    git(args, { encoding: "utf8", ...opts }).trim()

const show = ref => git(["show", ref])

const hashBlob = buffer =>
    gitText(["hash-object", "-w", "--stdin"], { input: buffer })

/**
 * Appends entries to a mimeData.json buffer the way apply-batch.js does.
 *
 * Key order and indentation follow the file's own convention so a new entry is
 * indistinguishable from a hand-written one.
 */
const append = (buffer, entries) => {
    const raw = buffer.toString("utf8")
    const closing = raw.lastIndexOf("]")
    if (closing === -1) throw new Error("mimeData.json has no closing bracket")
    const block = entries
        .map(entry =>
            JSON.stringify(
                {
                    name: entry.name,
                    description: entry.description,
                    links: {
                        deprecates: entry.links.deprecates ?? [],
                        relatedTo: entry.links.relatedTo ?? [],
                        parentOf: entry.links.parentOf ?? [],
                        alternativeTo: entry.links.alternativeTo ?? [],
                    },
                    fileTypes: entry.fileTypes ?? [],
                    furtherReading: entry.furtherReading ?? [],
                    notices: {
                        hasNoOfficial: entry.notices?.hasNoOfficial ?? false,
                        communityContributed:
                            entry.notices?.communityContributed ?? false,
                        popularUsage: entry.notices?.popularUsage ?? null,
                    },
                },
                null,
                2,
            )
                .split("\n")
                .map(line => `  ${line}`)
                .join("\n"),
        )
        .join(",\n")
    return Buffer.from(`${raw.slice(0, closing).trimEnd()},\n${block}\n]\n`)
}

const slices = readdirSync(SERIES)
    .filter(f => f.endsWith(".json"))
    .sort()
    .map(file => ({
        file,
        name: file.replace(/\.json$/, ""),
        entries: JSON.parse(readFileSync(path.join(SERIES, file), "utf8")),
    }))

if (!slices.length) {
    console.error("scripts/local/series is empty. Run slice-series.js first.")
    process.exit(1)
}

const validatorThree = show(`${VALIDATOR_AT_THREE}:scripts/validate-data.js`)
const validatorTwo = show(`${VALIDATOR_AT_TWO}:scripts/validate-data.js`)
const lowersAt = slices.findIndex(s =>
    s.entries.some(e => e.name === LOWERS_THE_BASELINE),
)
if (lowersAt === -1) throw new Error(`no slice adds ${LOWERS_THE_BASELINE}`)

const tmp = mkdtempSync(path.join(os.tmpdir(), "mimetype-series-"))
const indexFile = path.join(tmp, "index")

let parent = gitText(["rev-parse", BASE])
let data = show(`${BASE}:src/mimeData.json`)
const built = []

for (const [i, slice] of slices.entries()) {
    data = append(data, slice.entries)
    const validator = i < lowersAt ? validatorThree : validatorTwo

    const dataBlob = hashBlob(data)
    const validatorBlob = hashBlob(validator)

    const env = { ...process.env, GIT_INDEX_FILE: indexFile }
    git(["read-tree", parent], { env })
    git(
        [
            "update-index",
            "--cacheinfo",
            `100644,${dataBlob},src/mimeData.json`,
            "--cacheinfo",
            `100644,${validatorBlob},scripts/validate-data.js`,
        ],
        { env },
    )
    const tree = gitText(["write-tree"], { env })

    const kinds = [...new Set(slice.entries.map(e => e.name.split("/")[0]))]
    const message =
        `feat: add ${slice.entries.length} ${kinds.join(" and ")} types\n\n` +
        slice.entries.map(e => `  ${e.name}`).join("\n") +
        `\n\nSlice ${i + 1} of ${slices.length}. Sized so the diff renders without\n` +
        `a "Load diff" click, and ordered so every relatedTo target already has\n` +
        `a page by the time this lands.\n`

    const commit = gitText(["commit-tree", tree, "-p", parent, "-m", message])
    const branch = `${PREFIX}${slice.name}`
    git(["branch", "-f", branch, commit])
    built.push({ branch, commit, parent, slice })
    parent = commit
}

rmSync(tmp, { recursive: true, force: true })

console.log(`Built ${built.length} branch(es) on ${BASE}:\n`)
for (const b of built) {
    const stat = gitText([
        "diff",
        "--numstat",
        b.parent,
        b.commit,
        "--",
        "src/mimeData.json",
    ])
    const [added, removed] = stat.split("\t")
    // The collapse threshold is per file, not per pull request, so the number
    // that matters is the largest single file rather than the total.
    const files = gitText(["diff", "--name-only", b.parent, b.commit])
        .split("\n")
        .filter(Boolean)
    const diffLines = Math.max(
        ...files.map(
            f =>
                git(["diff", b.parent, b.commit, "--", f])
                    .toString("utf8")
                    .split("\n").length - 1,
        ),
    )
    const collapses = diffLines > 400
    console.log(
        `  ${b.branch.padEnd(24)} ${String(b.slice.entries.length).padStart(2)} entries  ` +
            `+${String(added).padStart(3)} -${removed}  ${String(diffLines).padStart(4)} lines in its largest file` +
            (collapses ? "   COLLAPSES" : ""),
    )
}

if (flag("--no-verify")) process.exit(0)

console.log(`\nVerifying each state with the real validator.`)
const originalData = readFileSync(DATA)
const originalValidator = readFileSync(VALIDATOR)
let ok = true
try {
    for (const [i, b] of built.entries()) {
        writeFileSync(DATA, show(`${b.commit}:src/mimeData.json`))
        writeFileSync(VALIDATOR, show(`${b.commit}:scripts/validate-data.js`))
        try {
            execFileSync("node", ["scripts/validate-data.js"], {
                cwd: ROOT,
                stdio: "pipe",
            })
            console.log(`  ok    ${b.branch}`)
        } catch (e) {
            ok = false
            const out =
                (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "")
            console.log(
                `  FAIL  ${b.branch}\n${out.split("\n").slice(-12).join("\n")}`,
            )
        }
    }
} finally {
    writeFileSync(DATA, originalData)
    writeFileSync(VALIDATOR, originalValidator)
}

const finalNames = JSON.parse(
    show(`${parent}:src/mimeData.json`).toString("utf8"),
).map(e => e.name)
const branchNames = JSON.parse(
    show("HEAD:src/mimeData.json").toString("utf8"),
).map(e => e.name)
const missing = branchNames.filter(n => !finalNames.includes(n))
const extra = finalNames.filter(n => !branchNames.includes(n))
console.log(
    `\nFinal state: ${finalNames.length} entries against ${branchNames.length} on HEAD, ` +
        `${missing.length} missing, ${extra.length} unexpected.`,
)
if (missing.length) console.log(`  missing: ${missing.join(", ")}`)
if (extra.length) console.log(`  unexpected: ${extra.join(", ")}`)

process.exit(ok && !missing.length && !extra.length ? 0 : 1)
