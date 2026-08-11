#!/usr/bin/env node
/**
 * Fork-only. Not part of any upstream pull request.
 *
 * Cuts the shipped batches into pull-request-sized slices that render without
 * a "Load diff" click, and writes them to scripts/local/series/.
 *
 * GitHub loads 400 lines of a file automatically and collapses the rest. An
 * entry costs about 31 diff lines, so a pull request that a reviewer sees
 * immediately holds at most eleven. The four earliest batches are 21 to 28
 * entries and are over that; the rest already fit. See scripts/local/pr-size.js.
 *
 * Slicing is not just chopping the list into elevens. Two constraints bind:
 *
 *   1. A `relatedTo` target must already have a page, or validate-data.js sees
 *      a dangling link and the ratchet fails. So nothing may point forward
 *      across a slice boundary.
 *   2. Entries that reference each other both ways cannot be separated at all,
 *      so each cycle ships whole. The largest is seven, comfortably inside the
 *      ceiling.
 *
 * Cycles are found with Tarjan, ordered so dependencies land first, and packed
 * group by group at an even size. One cycle spans two batches: image/ktx and
 * image/ktx2 reference the glTF containers that carry them, and those reference
 * back. Those four travel together in one slice, which is why a slice of image
 * types also carries two model types.
 *
 * Usage:
 *   node scripts/local/slice-series.js            # write scripts/local/series/
 *   node scripts/local/slice-series.js --dry-run  # print the plan only
 *   node scripts/local/slice-series.js --max 9    # a tighter ceiling
 */

const { execFileSync } = require("child_process")
const {
    readFileSync,
    writeFileSync,
    mkdirSync,
    rmSync,
    existsSync,
} = require("fs")
const path = require("path")

const ROOT = path.join(__dirname, "..", "..")
const BATCHES = path.join(__dirname, "batches")
const SERIES = path.join(__dirname, "series")

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const value = name => {
    const i = argv.indexOf(name)
    if (i === -1) return null
    const next = argv[i + 1]
    return next === undefined || next.startsWith("--") ? null : next
}

const MAX = Number(value("--max") ?? 11)

/** In the order they shipped. The slices keep this order wherever they can. */
const FILES = [
    "01-image",
    "02-audio",
    "03-web",
    "04-model",
    "05-http",
    "06-jose",
    "07-rdf",
    "08-cbor",
    "09-coap",
    "10-senml",
]

/** What each slice is called, and so what its pull request is about. */
const TITLES = {
    "01-image": "image",
    "02-audio": "audio",
    "03-web": "web",
    "04-model": "model",
    "05-http": "http",
    "06-jose": "jose",
    "07-rdf": "rdf",
    "08-cbor": "cbor",
    "09-coap": "coap",
    "10-senml": "senml",
}

const order = []
const byName = new Map()
const batchOf = new Map()
for (const file of FILES)
    for (const entry of JSON.parse(
        readFileSync(path.join(BATCHES, `${file}.json`), "utf8"),
    )) {
        order.push(entry.name)
        byName.set(entry.name, entry)
        batchOf.set(entry.name, file)
    }

const pos = new Map(order.map((n, i) => [n, i]))
const known = new Set(order)
const refs = new Map(
    order.map(n => [
        n,
        byName.get(n).links.relatedTo.filter(t => known.has(t)),
    ]),
)

/** Tarjan. Each strongly connected component has to ship in one slice. */
const findCycles = () => {
    let counter = 0
    const index = new Map()
    const low = new Map()
    const onStack = new Set()
    const stack = []
    const found = []
    const visit = v => {
        index.set(v, counter)
        low.set(v, counter)
        counter++
        stack.push(v)
        onStack.add(v)
        for (const w of refs.get(v)) {
            if (!index.has(w)) {
                visit(w)
                low.set(v, Math.min(low.get(v), low.get(w)))
            } else if (onStack.has(w)) {
                low.set(v, Math.min(low.get(v), index.get(w)))
            }
        }
        if (low.get(v) === index.get(v)) {
            const group = []
            let w
            do {
                w = stack.pop()
                onStack.delete(w)
                group.push(w)
            } while (w !== v)
            found.push(group)
        }
    }
    for (const n of order) if (!index.has(n)) visit(n)
    return found
}

const cycles = findCycles()
const cycleOf = new Map()
cycles.forEach((c, i) => c.forEach(n => cycleOf.set(n, i)))

/**
 * A cycle belongs to the earliest batch any of its members came from, so the
 * one that spans two travels forward to meet its dependants rather than
 * dragging them backwards.
 */
const groupOf = cycles.map(c =>
    Math.min(...c.map(n => FILES.indexOf(batchOf.get(n)))),
)
const rank = cycles.map(c => Math.min(...c.map(n => pos.get(n))))

const needs = cycles.map(() => new Set())
const feeds = cycles.map(() => new Set())
for (const n of order)
    for (const t of refs.get(n)) {
        const a = cycleOf.get(n)
        const b = cycleOf.get(t)
        if (a !== b) {
            needs[a].add(b)
            feeds[b].add(a)
        }
    }

const outstanding = needs.map(s => s.size)
const ready = cycles.map((_, i) => i).filter(i => outstanding[i] === 0)
const ordered = []
while (ready.length) {
    ready.sort((a, b) => groupOf[a] - groupOf[b] || rank[a] - rank[b])
    const i = ready.shift()
    ordered.push(i)
    for (const j of feeds[i]) if (--outstanding[j] === 0) ready.push(j)
}
if (ordered.length !== cycles.length)
    throw new Error("the reference graph did not condense to a DAG")

const flat = ordered.flatMap(i =>
    cycles[i].slice().sort((a, b) => pos.get(a) - pos.get(b)),
)
const place = new Map(flat.map((n, i) => [n, i]))

/** A cut is only valid where nothing points forward across it. */
const blocked = new Array(flat.length).fill(false)
for (const n of flat)
    for (const t of refs.get(n)) {
        const from = place.get(n)
        const to = place.get(t)
        if (to > from) for (let i = from; i < to; i++) blocked[i] = true
    }
const cuts = new Set()
for (let i = 0; i < flat.length - 1; i++) if (!blocked[i]) cuts.add(i)

const groupAt = flat.map(n => groupOf[cycleOf.get(n)])

/**
 * Slice one group at a time, aiming for equal sizes inside it, so a group of
 * 24 becomes three eights rather than eleven, eleven and a stub.
 */
const slices = []
let g = 0
while (g < flat.length) {
    let last = g
    while (last + 1 < flat.length && groupAt[last + 1] === groupAt[g]) last++
    const size = last - g + 1
    const target = Math.ceil(size / Math.ceil(size / MAX))
    let start = g
    while (start <= last) {
        if (last - start + 1 <= MAX) {
            slices.push(flat.slice(start, last + 1))
            break
        }
        const options = []
        for (let i = start; i <= last; i++)
            if (cuts.has(i) && i - start + 1 <= MAX) options.push(i)
        if (!options.length)
            throw new Error(
                `no valid cut within ${MAX} entries after ${flat[start]}`,
            )
        options.sort(
            (a, b) =>
                Math.abs(a - start + 1 - target) -
                Math.abs(b - start + 1 - target),
        )
        slices.push(flat.slice(start, options[0] + 1))
        start = options[0] + 1
    }
    g = last + 1
}

/** Every reference must resolve by the time its slice lands. */
const shipped = new Set()
for (const [i, slice] of slices.entries()) {
    const arriving = new Set(slice)
    for (const n of slice)
        for (const t of refs.get(n))
            if (!shipped.has(t) && !arriving.has(t))
                throw new Error(
                    `slice ${i + 1}: ${n} points at ${t}, which lands later`,
                )
    for (const n of slice) shipped.add(n)
}
if (shipped.size !== order.length)
    throw new Error(`sliced ${shipped.size} entries of ${order.length}`)

const nameOf = (slice, i) => {
    const groups = [...new Set(slice.map(n => TITLES[batchOf.get(n)]))]
    return `${String(i + 1).padStart(2, "0")}-${groups.join("-")}`
}

console.log(
    `${order.length} entries, ${cycles.length} clusters, ${slices.length} slices, ceiling ${MAX}\n`,
)
slices.forEach((slice, i) => {
    console.log(
        `  ${nameOf(slice, i).padEnd(18)} ${String(slice.length).padStart(2)}  ${slice.join(", ")}`,
    )
})

if (flag("--dry-run")) process.exit(0)

if (existsSync(SERIES)) rmSync(SERIES, { recursive: true })
mkdirSync(SERIES, { recursive: true })
slices.forEach((slice, i) => {
    writeFileSync(
        path.join(SERIES, `${nameOf(slice, i)}.json`),
        JSON.stringify(
            slice.map(n => byName.get(n)),
            null,
            4,
        ) + "\n",
    )
})

/**
 * Formatted by the project's own Prettier rather than by matching its output
 * from here. `npm test` runs `prettier --check .` before anything else, so a
 * regenerated series has to agree with that binary exactly, and the surest way
 * to agree with it is to run it.
 */
execFileSync(
    process.execPath,
    [
        path.join(ROOT, "node_modules", "prettier", "bin", "prettier.cjs"),
        "--write",
        "--log-level",
        "warn",
        SERIES,
    ],
    { cwd: ROOT, stdio: "inherit" },
)

console.log(`\nWrote ${slices.length} file(s) to scripts/local/series/`)
console.log(`Build the branches with: node scripts/local/build-series.js`)
