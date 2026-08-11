#!/usr/bin/env node
/**
 * Fork-only. Not part of any upstream pull request.
 *
 * Checks our descriptions against WCAG 3 guideline 2.2.3, Clear language,
 * https://www.w3.org/TR/wcag-3.0/#clear-language: "Users can understand the
 * content without having to process complex or unclear language."
 *
 * Core requirements:
 *   - "Abbreviations explained when first used"
 *   - "Diacritics required to identify the correct meaning of each word are
 *      available" (not checked; our descriptions are English and unaccented)
 *
 * Supplemental requirements:
 *   - "Explanations or unambiguous alternatives are available in text content
 *      for non-literal language, such as idioms and metaphors"
 *   - "Sentences do not include nested clauses"
 *   - "Sentences do not include unnecessary words"
 *
 * The guideline also allows assertions in place of tests, one of which is a
 * clear language review. This tool is the mechanical half; the reading is the
 * other half and no script does it.
 *
 * WCAG 3 is a draft and gives no numbers, so the thresholds here are ours and
 * are stated rather than implied. A sentence over 25 words is reported, over 32
 * is a failure. That is a proxy for nested clauses, which cannot be detected
 * reliably, and it is deliberately a proxy: the fix for a 40-word sentence is
 * almost always to split it, which is what the outcome is asking for.
 *
 * Abbreviations are the awkward one. This is a reference site for media types,
 * so a reader already has JSON, XML and HTTP. Expanding those every time would
 * be noise, not clarity. ASSUMED holds the ones we take as read; everything
 * else has to be spelled out on first use in its own description.
 *
 * The checker is advisory, not a gate. `npm test` does not run it, because
 * "this sentence is too long" is a judgement about writing and the right
 * response is sometimes to leave it alone and say why.
 *
 * Usage:
 *   node scripts/local/plain-language.js               # summary
 *   node scripts/local/plain-language.js --show        # every finding
 *   node scripts/local/plain-language.js --name image/jp2
 *   node scripts/local/plain-language.js --data        # check src/mimeData.json
 */

const { readFileSync, readdirSync } = require("fs")
const path = require("path")

const ROOT = path.join(__dirname, "..", "..")
const BATCHES = path.join(__dirname, "batches")

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const value = name => {
    const i = argv.indexOf(name)
    if (i === -1) return null
    const next = argv[i + 1]
    return next === undefined || next.startsWith("--") ? null : next
}

const SOFT_WORDS = 25
const HARD_WORDS = 32

/** Abbreviations a reader of a media type reference is assumed to have. */
const ASSUMED = new Set([
    "MIME",
    "IANA",
    "RFC",
    "ISO",
    "IEC",
    "ITU",
    "W3C",
    "IETF",
    "WHATWG",
    "OASIS",
    "ECMA",
    "ANSI",
    "URL",
    "URI",
    "IRI",
    "HTTP",
    "HTTPS",
    "SMTP",
    "HTML",
    "XML",
    "JSON",
    "CSS",
    "API",
    "APIs",
    "UTF",
    "ASCII",
    "CPU",
    "GPU",
    "OS",
    "ID",
    "IDs",
    "PDF",
    "ZIP",
    "TV",
    "3D",
    "2D",
    "AI",
    "PS3",
    "US",
    "UK",
    "SQL",
    "CBOR",
    "CSV",
    "TLS",
    "SSL",
    "DNS",
    "IP",
    "TCP",
    "UDP",
    "RTP",
    "MP3",
    "MP4",
    "JPEG",
    "PNG",
    "GIF",
    "SVG",
    "DICOM",
    "OAuth",
    // Expanding to three surnames tells a reader nothing they can use.
    "RSA",
    "REST",
    "CD",
    "DVD",
    "RGB",
    "CMYK",
    "DPI",
    "FPS",
    "HD",
    "RAM",
    "OK",
    "N/A",
    "PC",
])

/**
 * Non-literal language found in our own text, not a general idiom list.
 * Each one is a phrase a reader has to interpret rather than read.
 */
const NON_LITERAL = [
    "catches people out",
    "catches you out",
    "caught out",
    "in the wild",
    "sticking point",
    "flag day",
    "out of band",
    "worth reading twice",
    "the whole point",
    "the point of it",
    "under a more obvious name",
    "one character apart",
    "has outlived",
    "dates from",
    "spread through",
    "never displaced",
    "hands the payload",
    "sits behind",
    "the tail of",
    "on the wire",
    "turns up",
    "you meet it",
    "lives in",
    "rides along",
    "travels with",
    "the odd name",
    "reads as",
    "hostage",
    "earns its place",
    "the JPEG of",
    "does the heavy lifting",
    "under the hood",
    "a second copy",
    "not much use",
    "bite",
    "hold up",
    "stand in the same relation",
]

/** Words that carry no information in a sentence that already says the thing. */
const FILLER = [
    "actually",
    "genuinely",
    "deliberately",
    "essentially",
    "effectively",
    "simply",
    "just",
    "quite",
    "rather more",
    "of course",
    "in practice",
    "it is worth noting",
    "it should be noted",
    "needless to say",
    "the fact that",
    "in order to",
    "at the end of the day",
]

const loadEntries = () => {
    if (flag("--data")) {
        return JSON.parse(
            readFileSync(path.join(ROOT, "src", "mimeData.json"), "utf8"),
        )
    }
    const out = []
    for (const file of readdirSync(BATCHES).sort()) {
        if (!file.endsWith(".json")) continue
        out.push(...JSON.parse(readFileSync(path.join(BATCHES, file), "utf8")))
    }
    return out
}

/** Strips markdown links and code spans so prose is measured, not syntax. */
const prose = text =>
    text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/`([^`]+)`/g, "$1")

/**
 * Removes code spans outright rather than unwrapping them, for the checks that
 * ask what a reader has to interpret. A backticked `FN` or `BEGIN:VCARD` is a
 * literal quoted from the format, not an abbreviation the prose owes anyone an
 * expansion for, and treating it as one asked text/vcard to gloss six property
 * names it was only naming.
 */
const proseWithoutCode = text =>
    text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/`[^`]+`/g, " ")

/**
 * Splits on any sentence end, not only one followed by a capital. A sentence
 * starting with a linked type name begins lowercase once the markdown is
 * stripped, and requiring a capital silently merged it with the sentence
 * before, reporting a 40-word sentence that was really two of twenty.
 *
 * The lookahead also allows a leading dot so a sentence opening with a file
 * extension starts a sentence. Requiring a letter merged ".webmanifest is the
 * registered extension" into the sentence before it. The dot must be followed
 * by a letter or digit, which keeps "section 5.1, so ..." from splitting.
 */
const sentencesOf = text =>
    prose(text)
        .replace(/\n+/g, " ")
        .split(/(?<=[.!?])\s+(?=[A-Za-z\d]|\.[A-Za-z\d])/)
        .map(s => s.trim())
        .filter(Boolean)

const wordCount = s => s.split(/\s+/).filter(Boolean).length

/**
 * Names that are not abbreviations even though they are written in capitals.
 * A format called JP2 is not short for anything a reader could be told, and
 * an HTTP method name is a keyword rather than an initialism.
 */
const NOT_ABBREVIATIONS = new Set([
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
    "TRACE",
    "FETCH",
    "CONNECT",
    "MPEG",
    "RIFF",
    "GZIP",
    "COLLADA",
    "TOML",
    "YAML",
    "EXIF",
    "XMP",
    "PACKBITS",
    "LOCO",
    "BMP",
    "TIFF",
    "WEBP",
    "AVIF",
    "HEIC",
    "ICO",
])

/**
 * All-caps runs that look like an abbreviation a reader would need expanded.
 *
 * Tokens drawn from the entry's own media type name are skipped: the page for
 * `audio/evrc` is titled EVRC, so flagging EVRC inside it asks the description
 * to explain its own heading.
 */
const abbreviationsIn = (text, name) => {
    const own = name.toUpperCase().replace(/[^A-Z0-9]/g, "")
    const found = new Set()
    for (const m of proseWithoutCode(text).matchAll(
        /\b([A-Z][A-Z0-9]{1,7})\b/g,
    )) {
        const token = m[1]
        if (ASSUMED.has(token) || NOT_ABBREVIATIONS.has(token)) continue
        // A version number on the end does not make a new abbreviation: a
        // reader who has HTML has HTML5.
        if (ASSUMED.has(token.replace(/\d+$/, ""))) continue
        if (/^\d/.test(token)) continue
        if (own.includes(token.replace(/[^A-Z0-9]/g, ""))) continue
        found.add(token)
    }
    return [...found]
}

/**
 * An abbreviation counts as explained when the description spells it out
 * somewhere: either "Sensor Measurement Lists (SenML)" or the reverse.
 */
const isExplained = (abbr, text) => {
    const letters = abbr.replace(/[^A-Z]/g, "").split("")
    if (letters.length < 2) return true
    const body = prose(text)

    // How an expansion is actually written, in any of the shapes we use:
    // "MXF (Material Exchange Format)", "(RGBE)", "HEIF, the High Efficiency
    // Image File Format", "JBIG is the Joint Bi-level ... scheme".
    const written = new RegExp(
        `(\\(${abbr}\\)|${abbr}\\s*\\(|${abbr},?\\s+(the|is|stands|short)\\b)`,
    )
    if (written.test(body)) return true

    // Otherwise fall back to initials in order, which catches "Flexible Image
    // Transport System" for FITS but not expansions that skip a letter.
    const initials = letters.map(c => `\\b${c}\\w+`).join("[\\s\\-]+")
    return new RegExp(initials, "i").test(body)
}

const findings = []
const entries = loadEntries()
const only = value("--name")

for (const entry of entries) {
    if (only && entry.name !== only) continue
    if (!entry.description) continue
    const text = entry.description
    const add = (kind, detail) =>
        findings.push({ name: entry.name, kind, detail })

    for (const sentence of sentencesOf(text)) {
        const words = wordCount(sentence)
        if (words > HARD_WORDS)
            add("long sentence", `${words} words: ${sentence.slice(0, 90)}`)
        else if (words > SOFT_WORDS)
            add("longish sentence", `${words} words: ${sentence.slice(0, 90)}`)
    }

    const lower = prose(text).toLowerCase()
    // Lowercased at comparison rather than trusting the list to be lowercase:
    // "the JPEG of" carries capitals from the format it names, and against an
    // already-lowercased haystack it could never match.
    //
    // Matched on word boundaries rather than as a substring, which is how
    // "bite" was being reported inside "prohibited".
    for (const phrase of NON_LITERAL) {
        const escaped = phrase
            .toLowerCase()
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        if (new RegExp(`\\b${escaped}\\b`).test(lower))
            add("non-literal", `"${phrase}"`)
    }
    for (const word of FILLER) {
        const re = new RegExp(`\\b${word}\\b`, "gi")
        const hits = lower.match(re)
        if (hits) add("filler", `"${word}" x${hits.length}`)
    }

    for (const abbr of abbreviationsIn(text, entry.name))
        if (!isExplained(abbr, text)) add("unexplained abbreviation", abbr)
}

const byKind = {}
for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1

console.log(
    `${entries.length} description(s) checked against WCAG 3 guideline 2.2.3.\n`,
)
for (const [kind, count] of Object.entries(byKind).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(count).padStart(4)}  ${kind}`)

const worst = {}
for (const f of findings) worst[f.name] = (worst[f.name] ?? 0) + 1
const ranked = Object.entries(worst).sort((a, b) => b[1] - a[1])
console.log(`\n${ranked.length} description(s) with at least one finding.`)
console.log(`\nWorst ten:`)
for (const [name, count] of ranked.slice(0, 10))
    console.log(`  ${String(count).padStart(3)}  ${name}`)

if (flag("--show") || only) {
    console.log()
    for (const f of findings)
        console.log(`  ${f.kind.padEnd(24)} ${f.name.padEnd(34)} ${f.detail}`)
}

process.exit(0)
