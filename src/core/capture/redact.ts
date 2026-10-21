/**
 * The only way to turn a local capture into one that may leave the machine.
 *
 * Secrets become per-export placeholders (`[REDACTED_1]`, `[REDACTED_2]`...): equal secrets get the same placeholder
 * within one export, and nothing in a placeholder is derived from the secret (no hash prefix, no length-preserving
 * mask, both of which leak information). Stream text is redacted as ONE decoded string per connection and only then
 * cut back at the original chunk boundaries, so a secret that was split across two network chunks is still found.
 * Chunk records keep their original byte counts, so buffering analysis still works on the sanitized copy.
 *
 * What it cannot do: recognise a secret that looks like ordinary data (a random-looking id in a payload). The residual
 * scan reports those so the user can look before sharing; it never prints a value.
 */

import { redactUrl } from '../observe/redactUrl'
import { base64ToBytes } from './base64'
import { capabilitiesOf, type Capture, type CaptureRecord, type CaptureFooter, type CaptureHeader } from './format'
import { markRedacted, type RedactedCapture } from './redacted'
import { SAFE_REQUEST_HEADERS, SECRET_PATTERNS, hasPlaceholder, isSensitiveName, looksLikeRandomToken } from './secrets'
import { framesOf } from './streamText'

export interface RedactionPolicy {
    /** Extra payload key names to treat as secret, beside the built-in list. */
    extraKeys?: string[] | undefined
    /** Extra patterns; the whole match is replaced, or the first capture group when there is one. */
    extraPatterns?: Array<{ name: string; pattern: string; flags?: string | undefined }> | undefined
    /** Request header names whose values may stay in the clear, beside the built-in safe list. */
    keepHeaders?: string[] | undefined
    /** Replace partition keys (extracted from payloads) with placeholders. Default true. */
    redactPartitions?: boolean | undefined
}

export const REDACTION_POLICY_NAME = 'default'
export const REDACTION_POLICY_VERSION = 1

export interface ResidualHit {
    /** Where, in words a person can find: `record 12 (comment) text`. Never contains the value. */
    where: string
    rule: string
}

export interface RedactionReport {
    placeholders: number
    byRule: Record<string, number>
    /** Things that still look secret after redaction. Sharing should wait until a person has looked at them. */
    residual: ResidualHit[]
    /** Event ids that look like secrets: replaced when they match a known secret format, otherwise kept and flagged. */
    idWarnings: string[]
}

export interface RedactionResult {
    capture: RedactedCapture
    report: RedactionReport
}

export class RedactionError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'RedactionError'
    }
}

interface Span { start: number; end: number; rule: string; quote: boolean }

// flag d (match indices) is built at run time: the regex literal needs a newer compile target than the core uses
const JSON_PAIR = new RegExp(/"([^"\\\r\n]{1,64})"\s*:\s*("(?:[^"\\\r\n]|\\.)*"|-?\d[\w.+-]*|true|false|\[[^[\]]{0,2000}\]|\{[^{}]{0,2000}\})/g.source, 'gd')
// A value that starts with // is the rest of a URL (https://host/?token=x), not the value of a pair named `https`: skipping it lets the
// pair inside the URL be found. Any single-word scheme after Authorization (Token x, Digest x) is skipped like Bearer and Basic.
const PLAIN_PAIR = new RegExp(/\b([A-Za-z][A-Za-z0-9_.-]{1,40})\s*[=:]\s*(?!\/\/)(?:(?:Bearer|Basic|Token|Digest|ApiKey)\s+)?([^\s'",;&<>{}()[\]]{4,})/g.source, 'gd')
// the same pairs as they appear inside a JSON string (double-encoded JSON), and in a Python repr with single quotes
const ESCAPED_JSON_PAIR = new RegExp(/\\"([^"\\\r\n]{1,64})\\"\s*:\s*\\"((?:[^"\\]|\\(?!"))*?)\\"/g.source, 'gd')
const SINGLE_QUOTE_PAIR = new RegExp(/'([^'\\\r\n]{1,64})'\s*:\s*'([^'\\\r\n]*)'/g.source, 'gd')

/**
 * Skipped when walking records because they are structural or already opaque. Event ids are NOT skipped: an ordinary id
 * (a number, a uuid) matches no pattern and stays readable for sequence analysis, but an id that is a token is replaced,
 * the same way it is in the stream text.
 */
const KEEP_KEYS = new Set(['kind', 'seq', 't', 'conn', 'domain', 'dataHash', 'b64', 'captureId'])

class Redactor {
    private readonly values = new Map<string, string>()
    readonly counts: Record<string, number> = {}
    private readonly extra: Array<{ name: string; regex: RegExp }>

    constructor(readonly policy: RedactionPolicy = {}) {
        this.extra = (policy.extraPatterns ?? []).map((p) => ({ name: p.name, regex: new RegExp(p.pattern, [...new Set(`${p.flags ?? ''}gd`)].join('')) }))
    }

    get size(): number { return this.values.size }

    placeholder(value: string, rule: string): string {
        let p = this.values.get(value)
        if (p === undefined) {
            p = `[REDACTED_${this.values.size + 1}]`
            this.values.set(value, p)
        }
        this.counts[rule] = (this.counts[rule] ?? 0) + 1
        return p
    }

    /** Non-overlapping spans of `text` that hold secrets, in order. Pure: assigns no placeholders. */
    spans(text: string): Span[] {
        const found: Span[] = []
        const add = (start: number, end: number, rule: string, quote = false) => {
            if (end > start && !hasPlaceholder(text.slice(start, end))) found.push({ start, end, rule, quote })
        }
        const regexes = [...SECRET_PATTERNS.map((p) => ({ name: p.name, regex: p.regex, group: p.group })), ...this.extra.map((e) => ({ name: e.name, regex: e.regex, group: 1 }))]
        for (const { name, regex, group } of regexes) {
            const flags = regex.flags.includes('d') ? regex.flags : `${regex.flags}d`
            for (const m of text.matchAll(new RegExp(regex.source, flags))) {
                const span = (m as RegExpMatchArray & { indices?: Array<[number, number] | undefined> }).indices?.[group] ?? (group === 0 ? [m.index, m.index + m[0].length] : undefined)
                if (span) add(span[0], span[1], name)
                else if (group > 0 && m[0].length > 0) add(m.index, m.index + m[0].length, name) // the pattern had no group: the whole match
            }
        }
        for (const m of text.matchAll(JSON_PAIR)) {
            if (!isSensitiveName(m[1]!, this.policy.extraKeys)) continue
            const indices = (m as RegExpMatchArray & { indices: Array<[number, number]> }).indices[2]!
            const raw = m[2]!
            if (raw.startsWith('"')) add(indices[0] + 1, indices[1] - 1, 'secret-key') // inside the quotes, so the JSON stays valid
            else add(indices[0], indices[1], 'secret-key', true)
        }
        for (const m of text.matchAll(ESCAPED_JSON_PAIR)) {
            if (!isSensitiveName(m[1]!, this.policy.extraKeys)) continue
            const indices = (m as RegExpMatchArray & { indices: Array<[number, number]> }).indices[2]!
            add(indices[0], indices[1], 'secret-key')
        }
        for (const m of text.matchAll(SINGLE_QUOTE_PAIR)) {
            if (!isSensitiveName(m[1]!, this.policy.extraKeys)) continue
            const indices = (m as RegExpMatchArray & { indices: Array<[number, number]> }).indices[2]!
            add(indices[0], indices[1], 'secret-key')
        }
        // A pair whose name is harmless (Location: https://h/?token=x) can hold a pair that is not, so after a miss the search
        // goes on from inside its value instead of past it.
        const plain = new RegExp(PLAIN_PAIR.source, PLAIN_PAIR.flags)
        for (let m = plain.exec(text); m !== null; m = plain.exec(text)) {
            if (!isSensitiveName(m[1]!, this.policy.extraKeys)) { plain.lastIndex = m.index + m[1]!.length + 1; continue }
            const indices = (m as RegExpMatchArray & { indices: Array<[number, number]> }).indices[2]!
            // `Authorization: Bearer [REDACTED_1]` (already redacted): the scheme word is not the secret
            if (/^(?:Bearer|Basic|Token|Digest|ApiKey)$/i.test(m[2]!) && /^\s+\[REDACTED_/.test(text.slice(indices[1], indices[1] + 14))) continue
            add(indices[0], indices[1], 'secret-key')
        }
        found.sort((a, b) => a.start - b.start || b.end - a.end)
        const merged: Span[] = []
        for (const s of found) {
            const last = merged[merged.length - 1]
            if (!last || s.start >= last.end) merged.push(s)
        }
        return merged
    }

    /** The text with every span replaced, and a function mapping an offset in the original to one in the result. */
    rebuild(text: string, spans: Span[]): { out: string; map: (offset: number) => number } {
        let out = ''
        let cursor = 0
        const replacements: Array<{ start: number; end: number; newEnd: number; shift: number }> = []
        for (const s of spans) {
            out += text.slice(cursor, s.start)
            const placeholder = this.placeholder(text.slice(s.start, s.end), s.rule)
            const replacement = s.quote ? `"${placeholder}"` : placeholder
            const newStart = out.length
            out += replacement
            replacements.push({ start: s.start, end: s.end, newEnd: newStart + replacement.length, shift: newStart + replacement.length - s.end })
            cursor = s.end
        }
        out += text.slice(cursor)
        // Chunk boundaries are asked for in increasing order, so one cursor walks the replacements once. Searching from the
        // start for every boundary made redaction quadratic in the number of chunks times the number of secrets.
        let next = 0
        let shift = 0
        const map = (offset: number): number => {
            while (next < replacements.length && offset >= replacements[next]!.end) { shift = replacements[next]!.shift; next++ }
            const r = replacements[next]
            if (r && offset > r.start) return r.newEnd // inside a replaced value: cut after the placeholder
            return offset + shift
        }
        return { out, map }
    }

    text(text: string): string {
        const spans = this.spans(text)
        return spans.length === 0 ? text : this.rebuild(text, spans).out
    }
}

/** Decoded text of each chunk of one connection, in order. Pieces split inside a character are carried over by the decoder. */
function chunkPieces(chunks: Array<{ b64?: string; text?: string }>): string[] | null {
    const decoder = new TextDecoder('utf-8')
    const pieces: string[] = []
    let any = false
    for (const c of chunks) {
        if (typeof c.text === 'string') { pieces.push(c.text); any = true } else if (typeof c.b64 === 'string') { pieces.push(decoder.decode(base64ToBytes(c.b64), { stream: true })); any = true } else pieces.push('')
    }
    return any ? pieces : null
}

function redactChunks(records: readonly CaptureRecord[], redactor: Redactor): Map<number, CaptureRecord> {
    const byConn = new Map<number, Array<CaptureRecord & { kind: 'chunk' }>>()
    for (const r of records) if (r.kind === 'chunk') (byConn.get(r.conn) ?? byConn.set(r.conn, []).get(r.conn)!).push(r as CaptureRecord & { kind: 'chunk' })
    const replaced = new Map<number, CaptureRecord>()
    for (const conn of [...byConn.keys()].sort((a, b) => a - b)) {
        const chunks = byConn.get(conn)!
        const pieces = chunkPieces(chunks as unknown as Array<{ b64?: string; text?: string }>)
        if (!pieces) {
            for (const c of chunks) replaced.set(c.seq, c)
            continue
        }
        const full = pieces.join('')
        const { out, map } = redactor.rebuild(full, redactor.spans(full))
        let offset = 0
        let previous = 0
        chunks.forEach((chunk, i) => {
            offset += pieces[i]!.length
            const boundary = i === chunks.length - 1 ? out.length : map(offset)
            const { b64: _dropped, ...rest } = chunk as typeof chunk & { b64?: string }
            void _dropped
            replaced.set(chunk.seq, { ...rest, text: out.slice(previous, boundary) } as CaptureRecord)
            previous = boundary
        })
    }
    return replaced
}

function redactHeaders(headers: Record<string, string>, redactor: Redactor, allow: Set<string> | null): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase()
        if (isSensitiveName(name, redactor.policy.extraKeys) || lower === 'cookie' || lower === 'set-cookie') out[name] = redactor.placeholder(value, 'header')
        else if (allow && !allow.has(lower)) out[name] = redactor.placeholder(value, 'header')
        else out[name] = redactor.text(value)
    }
    return out
}

function walk(value: unknown, key: string, redactor: Redactor, partitions: boolean): unknown {
    if (typeof value === 'string') {
        if (KEEP_KEYS.has(key)) return value
        if (key === 'url' || key === 'finalUrl') return redactUrl(value)
        if (key === 'partition' && partitions) return redactor.placeholder(value, 'partition')
        return redactor.text(value)
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, key, redactor, partitions))
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (k === 'headers' && v && typeof v === 'object' && !Array.isArray(v)) out[k] = redactHeaders(v as Record<string, string>, redactor, null)
            else out[k] = walk(v, k, redactor, partitions)
        }
        return out
    }
    return value
}

const looksLikeSecretId = (id: string): boolean => SECRET_PATTERNS.some((p) => new RegExp(p.regex.source, p.regex.flags).test(id)) || looksLikeRandomToken(id)

function sameShape(before: Capture, after: Capture): void {
    const a = framesOf(before)
    const b = framesOf(after)
    if (a.length !== b.length) throw new RedactionError(`redaction changed the number of events (${a.length} before, ${b.length} after); nothing was produced`)
    a.forEach((frame, i) => {
        const other = b[i]!
        if (frame.event !== other.event && !hasPlaceholder(other.event)) throw new RedactionError(`redaction changed the name of event ${i + 1}; nothing was produced`)
        if (frame.id !== other.id && !hasPlaceholder(other.id)) throw new RedactionError(`redaction changed the id of event ${i + 1}; nothing was produced`)
    })
}

/** Turns a capture into one that is safe to share. Does not change its input. Throws RedactionError if the result would not mean the same thing. */
export function redactCapture(capture: Capture, policy: RedactionPolicy = {}): RedactionResult {
    const redactor = new Redactor(policy)
    const partitions = policy.redactPartitions !== false
    const allow = new Set([...SAFE_REQUEST_HEADERS, ...(policy.keepHeaders ?? []).map((h) => h.toLowerCase())])

    const chunks = redactChunks(capture.records, redactor)
    const records = capture.records.map((r) => {
        if (r.kind === 'chunk') return chunks.get(r.seq) ?? r
        return walk(r, '', redactor, partitions) as CaptureRecord
    })

    const request = capture.header.request
    const header: CaptureHeader = {
        ...capture.header,
        kind: 'sanitized',
        request: request ? { ...request, url: redactUrl(request.url), headers: redactHeaders(request.headers, redactor, allow) } : undefined,
        profile: capture.header.profile ? (walk(capture.header.profile, 'profile', redactor, false) as CaptureHeader['profile']) : undefined,
        redaction: { policy: REDACTION_POLICY_NAME, version: REDACTION_POLICY_VERSION, applied: [], placeholders: 0 },
        capabilities: capture.header.capabilities.length ? capture.header.capabilities : capabilitiesOf(records),
    }
    if (header.request === undefined) delete header.request
    if (header.profile === undefined) delete header.profile

    const footer: CaptureFooter | undefined = capture.footer ? { ...capture.footer } : undefined
    if (footer) delete footer.integrity // the integrity hash of the original means nothing for the sanitized body; serializing writes a new one

    const redacted: Capture = { header, records, footer }
    sameShape(capture, redacted)

    const byRule = { ...redactor.counts }
    header.redaction = { policy: REDACTION_POLICY_NAME, version: REDACTION_POLICY_VERSION, applied: Object.keys(byRule).sort(), placeholders: redactor.size }
    const brand = markRedacted(redacted)
    const secretIds = new Set(framesOf(capture).map((f) => f.id).filter((id) => id && looksLikeSecretId(id)))
    const idWarnings = [...secretIds].map((id, i) => (redactor.text(id) === id
        ? `event id #${i + 1} looks like a random token but matches no known secret format, so it was kept; check it before sharing`
        : `event id #${i + 1} was a credential and was replaced; sequence checks on this stream cannot use ids`))
    return { capture: brand, report: { placeholders: redactor.size, byRule, residual: scanResidual(brand, policy), idWarnings } }
}

/** What still looks like a secret in a capture. Values are never included in the result. */
export function scanResidual(capture: Capture, policy: RedactionPolicy = {}): ResidualHit[] {
    const redactor = new Redactor(policy)
    const hits: ResidualHit[] = []
    const scan = (text: string, where: string) => {
        for (const s of redactor.spans(text)) hits.push({ where, rule: s.rule })
        for (const token of text.split(/[\s"'`,;:=&?()[\]{}<>|\\/]+/)) if (looksLikeRandomToken(token)) hits.push({ where, rule: 'random-token' })
    }
    const scanValue = (value: unknown, key: string, where: string) => {
        if (typeof value === 'string') { if (!KEEP_KEYS.has(key)) scan(value, `${where} ${key}`.trimEnd()) } else if (Array.isArray(value)) value.forEach((v) => scanValue(v, key, where))
        else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value as Record<string, unknown>)) scanValue(v, k, where)
    }
    if (capture.header.request) scanValue({ ...capture.header.request, headers: Object.fromEntries(Object.entries(capture.header.request.headers).filter(([, v]) => !hasPlaceholder(v))) }, 'request', 'header')

    const byConn = new Map<number, Array<{ b64?: string; text?: string }>>()
    for (const r of capture.records) {
        if (r.kind === 'chunk') (byConn.get(r.conn) ?? byConn.set(r.conn, []).get(r.conn)!).push(r as unknown as { b64?: string; text?: string })
        else scanValue(r, '', `record ${r.seq} (${r.kind})`)
    }
    for (const [conn, chunks] of byConn) {
        const pieces = chunkPieces(chunks)
        if (pieces) scan(pieces.join(''), `stream text of connection ${conn}`)
    }
    return hits
}
