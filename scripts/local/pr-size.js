#!/usr/bin/env node
/**
 * Fork-only. Not part of any upstream pull request.
 *
 * Measures a proposed pull request against the limits GitHub documents at
 * https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits
 *
 * Past those limits GitHub stops rendering the diff, which for this work would
 * be fatal: the maintainer closed PR #68 because 22,189 lines were not
 * reviewable, and a PR he cannot open at all is worse. The soft threshold
 * matters as much as the hard one. A file over 400 lines or 20 KB arrives
 * collapsed behind a "Load diff" button, so it is reported too.
 *
 * The line counts here are the whole unified diff, context included, because
 * that is what GitHub renders. `git diff --numstat` counts only changed lines
 * and reads about 15% lower on this repository.
 *
 * Usage:
 *   node scripts/local/pr-size.js                    # the branch as one PR
 *   node scripts/local/pr-size.js --per-commit       # each commit as its own PR
 *   node scripts/local/pr-size.js --range upstream/master..HEAD
 *   node scripts/local/pr-size.js --include-local    # count scripts/local too
 */

const { execFileSync } = require("child_process")
const path = require("path")

const ROOT = path.join(__dirname, "..", "..")

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const value = name => {
    const i = argv.indexOf(name)
    if (i === -1) return null
    const next = argv[i + 1]
    return next === undefined || next.startsWith("--") ? null : next
}

/** Documented 2026-08-11. Numbers here, reasoning in the report below. */
const LIMITS = {
    totalLines: 20000,
    totalBytes: 1024 * 1024,
    fileLines: 20000,
    fileBytes: 500 * 1024,
    files: 300,
    renderableFiles: 25,
    commits: 250,
}

/** Past these a file arrives collapsed. Not a failure, just worth knowing. */
const AUTOLOAD_LINES = 400
const AUTOLOAD_BYTES = 20 * 1024

/** Extensions GitHub renders rather than diffs as text. */
const RENDERABLE =
    /\.(png|jpe?g|gif|bmp|tiff?|svg|pdf|geojson|topojson|psd|ai|stl|ipynb)$/i

const EXCLUDE_LOCAL = ":(exclude)scripts/local"

/**
 * Arguments go as an array, never as a command string. A pathspec such as
 * `:(exclude)scripts/local` has to reach git unquoted, and cmd.exe does not
 * strip the quotes a POSIX shell would.
 */
const git = (args, opts = {}) =>
    execFileSync("git", args, {
        cwd: ROOT,
        maxBuffer: 1e9,
        ...opts,
    })

const gitText = args => git(args, { encoding: "utf8" })

const pathspec = () =>
    flag("--include-local") ? [] : ["--", ".", EXCLUDE_LOCAL]

/**
 * One file's contribution to the diff, measured the way GitHub sees it.
 *
 * Bytes come from the raw buffer rather than a string length, because the
 * data file is not ASCII and a character count would under-report it.
 */
const measureFile = (revs, file) => {
    const buf = git(["diff", ...revs, "--", file])
    const text = buf.toString("utf8")
    return {
        file,
        bytes: buf.length,
        lines: text.split("\n").length - 1,
        renderable: RENDERABLE.test(file),
    }
}

const measure = revs => {
    const numstat = gitText(["diff", "--numstat", ...revs, ...pathspec()])
        .split("\n")
        .filter(Boolean)
    const files = numstat.map(line => {
        const [added, removed, ...rest] = line.split("\t")
        const file = rest.join("\t")
        return {
            file,
            added: Number(added) || 0,
            removed: Number(removed) || 0,
        }
    })
    const measured = files.map(f => ({ ...f, ...measureFile(revs, f.file) }))
    return {
        files: measured,
        totalBytes: measured.reduce((a, f) => a + f.bytes, 0),
        totalLines: measured.reduce((a, f) => a + f.lines, 0),
        renderable: measured.filter(f => f.renderable).length,
        commits: Number(
            gitText(["rev-list", "--count", `${revs[0]}..${revs[1]}`]).trim(),
        ),
    }
}

const kb = n => `${(n / 1024).toFixed(1)} KiB`

const check = (label, actual, limit, format = String) => {
    const pct = (actual / limit) * 100
    const state = actual > limit ? "OVER" : pct >= 80 ? "near" : "ok"
    return {
        label,
        actual,
        limit,
        pct,
        state,
        line: `  ${state === "OVER" ? "OVER" : state === "near" ? "near" : "ok  "}  ${label.padEnd(34)} ${format(actual).padStart(12)} of ${format(limit).padStart(12)}   ${pct.toFixed(1).padStart(5)}%`,
    }
}

const report = m => {
    const checks = [
        check("total diff, lines", m.totalLines, LIMITS.totalLines),
        check("total diff, raw bytes", m.totalBytes, LIMITS.totalBytes, kb),
        check("files changed", m.files.length, LIMITS.files),
        check("renderable files", m.renderable, LIMITS.renderableFiles),
        check("commits listed", m.commits, LIMITS.commits),
    ]

    const worstFileLines = m.files.reduce(
        (a, f) => (f.lines > a.lines ? f : a),
        { lines: 0, file: "(none)" },
    )
    const worstFileBytes = m.files.reduce(
        (a, f) => (f.bytes > a.bytes ? f : a),
        { bytes: 0, file: "(none)" },
    )
    checks.push(
        check(`largest file, lines`, worstFileLines.lines, LIMITS.fileLines),
        check(
            `largest file, raw bytes`,
            worstFileBytes.bytes,
            LIMITS.fileBytes,
            kb,
        ),
    )

    for (const c of checks) console.log(c.line)
    console.log(
        `        largest by lines: ${worstFileLines.file}\n        largest by bytes: ${worstFileBytes.file}`,
    )

    const collapsed = m.files.filter(
        f => f.lines > AUTOLOAD_LINES || f.bytes > AUTOLOAD_BYTES,
    )
    if (collapsed.length) {
        console.log(
            `\n  ${collapsed.length} file(s) arrive collapsed behind "Load diff" (over ${AUTOLOAD_LINES} lines or ${kb(AUTOLOAD_BYTES)}):`,
        )
        for (const f of collapsed)
            console.log(
                `        ${f.file.padEnd(30)} ${String(f.lines).padStart(6)} lines  ${kb(f.bytes).padStart(10)}`,
            )
    }

    return {
        ok: checks.every(c => c.state !== "OVER"),
        checks,
        collapsed: collapsed.length,
    }
}

const main = () => {
    const range = value("--range") ?? "upstream/master..HEAD"
    const [base, head] = range.split("..")

    if (!flag("--per-commit")) {
        console.log(
            `One pull request: ${range}${flag("--include-local") ? "" : ", excluding scripts/local"}\n`,
        )
        const { ok } = report(measure([base, head]))
        console.log(ok ? "\nWithin every documented limit." : "\nOVER a limit.")
        process.exit(ok ? 0 : 1)
    }

    const commits = gitText(["rev-list", "--reverse", range])
        .split("\n")
        .filter(Boolean)
    console.log(
        `Each commit as its own pull request, ${commits.length} of them, each against ${base}.\n`,
    )
    let allOk = true
    let previous = base
    let worst = { pct: 0, label: "(none)", sha: "" }
    let collapsedAnywhere = 0
    for (const sha of commits) {
        const subject = gitText(["log", "-1", "--format=%s", sha]).trim()
        const m = measure([previous, sha])
        if (!m.files.length) {
            console.log(
                `  skip  ${sha.slice(0, 7)}  ${subject}  (nothing outside scripts/local)`,
            )
            previous = sha
            continue
        }
        console.log(`  ${sha.slice(0, 7)}  ${subject}`)
        const { ok, checks, collapsed } = report(m)
        allOk = ok && allOk
        collapsedAnywhere += collapsed
        for (const c of checks)
            if (c.pct > worst.pct)
                worst = { pct: c.pct, label: c.label, sha: sha.slice(0, 7) }
        console.log()
        previous = sha
    }
    console.log(
        `Worst case across all of them: ${worst.pct.toFixed(1)}% of the ${worst.label} limit, in ${worst.sha}.`,
    )
    console.log(
        collapsedAnywhere
            ? `${collapsedAnywhere} file(s) across these pull requests arrive collapsed.`
            : `No file in any of them arrives collapsed; every diff renders inline.`,
    )
    console.log(
        allOk
            ? "Every one is within the documented limits."
            : "At least one is OVER.",
    )
    process.exit(allOk ? 0 : 1)
}

main()
