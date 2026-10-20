/**
 * The `.sse-capture` v2 file: newline-delimited JSON, so a crash leaves a valid prefix, a long capture can be appended
 * to, and a reader can stream it.
 *
 *   line 1      header   { format: 'sse-capture', version: '2.0', ... }
 *   lines 2..n  records  one observation each (unknown kinds are kept as they are)
 *   last line   footer   { footer: { counts, endReason, integrity } }   (missing in a crashed file)
 *
 * Major version bump = breaking, minor = additive. Readers must ignore header fields and record kinds they do not know
 * and keep them when they write the file again.
 */

import type { EngineInput } from '../diagnostics/streamModel'
import { CAPABILITY_EVIDENCE, type Capability } from '../diagnostics/rule'
import type { StreamProfile } from '../diagnostics/thresholds'
import type { ObservationKind } from '../observe/observation'
import { sha256Hex } from './sha256'

export const CAPTURE_FORMAT = 'sse-capture'
export const CAPTURE_VERSION = '2.0'
const SUPPORTED_MAJOR = 2

/** `local-full` may hold secrets and wire bytes and is never shared; `sanitized` came out of `redactCapture()`. */
export type CaptureKind = 'local-full' | 'sanitized'

export interface CaptureHeader {
    format: typeof CAPTURE_FORMAT
    version: string
    createdAt: string
    kind: CaptureKind
    tool: { name: string; version: string }
    analyzer?: { version: string; rules: Record<string, number> } | undefined
    source: {
        kind: 'browser-app' | 'cli' | 'fixture' | 'import-v1'
        /** What produced the bytes, for example `browser-fetch` or `node-undici`; they chunk and decode differently. */
        client?: string | undefined
        /** True when the timeline was rebuilt rather than measured (an imported v1 recording). */
        synthetic?: boolean | undefined
    }
    clock: { origin: 'monotonic'; startedAtEpochMs?: number | undefined }
    /** What the recorder could record. Informational: the engine decides coverage from the records themselves. */
    capabilities: string[]
    request?: { url: string; method: string; headers: Record<string, string>; viaProxy?: boolean | undefined } | undefined
    profile?: StreamProfile | undefined
    redaction?: { policy: string; version: number; applied: string[]; placeholders: number } | undefined
    limits?: { capBytes?: number | undefined; truncated?: boolean | undefined } | undefined
    /** Lanes of one Multi-Stream session share a group and an epoch base, so they can be compared later. */
    group?: { groupId: string; laneIndex: number } | undefined
    captureId?: string | undefined
}

export interface CaptureFooter {
    endReason: 'completed' | 'stopped' | 'failed' | 'crashed' | 'import' | (string & {})
    counts: Record<string, number>
    overhead?: Record<string, number> | undefined
    integrity?: { algorithm: 'sha256'; value: string } | undefined
}

/** A record kind this version does not know. It is kept and written back unchanged. */
export interface UnknownRecord { seq: number; t: number; conn: number; kind: string; [extra: string]: unknown }

export type CaptureRecord = EngineInput | UnknownRecord

export interface Capture {
    header: CaptureHeader
    records: CaptureRecord[]
    footer?: CaptureFooter | undefined
}

export class CaptureFormatError extends Error {
    constructor(message: string, readonly line?: number) {
        super(line === undefined ? message : `line ${line}: ${message}`)
        this.name = 'CaptureFormatError'
    }
}

export function countByKind(records: readonly CaptureRecord[]): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const r of records) counts[r.kind] = (counts[r.kind] ?? 0) + 1
    return counts
}

export function capabilitiesOf(records: readonly CaptureRecord[]): Capability[] {
    const seen = new Set<string>(records.map((r) => r.kind))
    return (Object.keys(CAPABILITY_EVIDENCE) as Capability[]).filter((cap) => CAPABILITY_EVIDENCE[cap].some((kind: ObservationKind) => seen.has(kind)))
}

export function newHeader(init: Partial<CaptureHeader> & Pick<CaptureHeader, 'kind' | 'source'>): CaptureHeader {
    return {
        format: CAPTURE_FORMAT,
        version: CAPTURE_VERSION,
        createdAt: new Date().toISOString(),
        tool: { name: 'sse-observatory', version: 'dev' },
        clock: { origin: 'monotonic' },
        capabilities: [],
        ...init,
    }
}

/** The body lines exactly as they appear in the file; the footer's hash covers these. */
export function integrityOf(lines: readonly string[]): string {
    return sha256Hex(lines.join('\n'))
}

/**
 * Writes the file. The footer is filled in here (counts, hash) unless the caller already set the counts. The hash is
 * tamper-evidence for a report that travels between people, not a security control: anyone can recompute it.
 */
export function serializeCapture(capture: Capture): string {
    const lines = capture.records.map((r) => JSON.stringify(r))
    const footer: CaptureFooter = {
        endReason: 'completed',
        ...capture.footer,
        counts: capture.footer?.counts ?? countByKind(capture.records),
        integrity: { algorithm: 'sha256', value: integrityOf(lines) },
    }
    const header = { ...capture.header, capabilities: capture.header.capabilities.length ? capture.header.capabilities : capabilitiesOf(capture.records) }
    return [JSON.stringify(header), ...lines, JSON.stringify({ footer })].join('\n') + '\n'
}

export type IntegrityStatus = 'ok' | 'mismatch' | 'absent'

export interface ParsedCapture {
    capture: Capture
    integrity: IntegrityStatus
    /** Things a reader should tell the user: a cut-off last line, a missing footer, a newer minor version. */
    warnings: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads a capture. A damaged or unfinished file is read as far as it goes, with warnings; a file that is not a capture throws. */
export function parseCapture(text: string): ParsedCapture {
    // A file that went through an editor, git on Windows or a PowerShell redirect may carry a byte order mark and CRLF line
    // endings. Neither is part of the format, and neither may make a good file look tampered with.
    const raw = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    while (raw.length > 0 && raw[raw.length - 1]!.trim() === '') raw.pop()
    if (raw.length === 0) throw new CaptureFormatError('the file is empty')

    let header: unknown
    try { header = JSON.parse(raw[0]!) } catch { throw new CaptureFormatError('the first line is not JSON; this is not an .sse-capture file', 1) }
    if (!isObject(header) || header.format !== CAPTURE_FORMAT) throw new CaptureFormatError('the first line is not an sse-capture header', 1)
    const version = typeof header.version === 'string' ? header.version : ''
    const major = Number(version.split('.')[0])
    if (!Number.isInteger(major) || major !== SUPPORTED_MAJOR) throw new CaptureFormatError(`unsupported capture version "${version}" (this reader understands ${SUPPORTED_MAJOR}.x)`, 1)

    const warnings: string[] = []
    const bodyRaw: string[] = []
    const records: CaptureRecord[] = []
    let footer: CaptureFooter | undefined
    for (let i = 1; i < raw.length; i++) {
        const line = raw[i]!
        if (line.trim() === '') continue
        let value: unknown
        try { value = JSON.parse(line) } catch {
            if (i === raw.length - 1) { warnings.push(`line ${i + 1} is cut off (the capture was probably interrupted); it was ignored`); continue }
            throw new CaptureFormatError('not valid JSON', i + 1)
        }
        if (!isObject(value)) throw new CaptureFormatError('a record must be a JSON object', i + 1)
        if (isObject(value.footer)) { footer = value.footer as unknown as CaptureFooter; continue }
        if (typeof value.kind !== 'string' || typeof value.seq !== 'number' || typeof value.t !== 'number') {
            throw new CaptureFormatError('a record needs "kind", "seq" and "t"', i + 1)
        }
        records.push(value as unknown as CaptureRecord)
        bodyRaw.push(line)
    }
    if (!footer) warnings.push('the capture has no footer (it was not finished); counts and the integrity check are unavailable')
    if (version !== CAPTURE_VERSION) warnings.push(`the capture is version ${version}; this reader writes ${CAPTURE_VERSION}. Fields it does not know are kept.`)

    let integrity: IntegrityStatus = 'absent'
    if (footer?.integrity) integrity = footer.integrity.value === integrityOf(bodyRaw) ? 'ok' : 'mismatch'
    if (integrity === 'mismatch') warnings.push('the integrity hash does not match: the records were changed after the capture was written')
    return { capture: { header: header as unknown as CaptureHeader, records, footer }, integrity, warnings }
}
