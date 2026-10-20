/**
 * Reads the few values a rule needs out of an event's payload, once, when the event is recorded.
 *
 * Observation records carry metadata only. Rules need things from the payload (the sequence number to check gaps, a
 * producer timestamp to judge buffering, a partition key, whether it is a heartbeat), so the probe extracts exactly the
 * fields the stream profile names and nothing else. Raw payload text never enters an observation; rules read only
 * `extracted`.
 */

import { getJsonPath } from './jsonPath'
import type { Extracted } from './observation'

export interface PayloadProbeConfig {
    /** Where the sequence number lives: a JSON path in the payload, or the SSE `id:` field. */
    sequence?: { field?: string | undefined; useSseId?: boolean | undefined } | undefined
    /** JSON path of a producer timestamp (epoch milliseconds, or an ISO date string). */
    timestampField?: string | undefined
    /** JSON path whose value partitions the sequence, or '$event' to partition by event name. */
    partitionBy?: string | undefined
    /** What counts as a heartbeat: these event names, or data matching the pattern. */
    heartbeat?: { events?: string[] | undefined; dataPattern?: string | undefined } | undefined
    /** Payloads longer than this many characters are not parsed (default 65,536) and are marked truncated. */
    maxChars?: number | undefined
}

export interface ProbeInput { event: string; data: string; id: string }

export interface ProbeResult {
    /** Equality hash, salted per capture: lets duplicates be found within one capture, and can't be looked up elsewhere. */
    dataHash: string
    extracted?: Extracted
    payloadTruncated?: true
}

const DEFAULT_MAX_CHARS = 64 * 1024

/** cyrb53: a fast 53-bit string hash. Not cryptographic; it is only for equality within a capture. */
function hash53(text: string, seed: number): number {
    let h1 = 0xdeadbeef ^ seed
    let h2 = 0x41c6ce57 ^ seed
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        h1 = Math.imul(h1 ^ c, 2654435761)
        h2 = Math.imul(h2 ^ c, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

export class PayloadProbe {
    private readonly maxChars: number
    private readonly salt: number
    private readonly pattern: RegExp | null
    private readonly needsPayload: boolean

    /** `salt` is random per capture unless a test pins it. */
    constructor(private readonly config: PayloadProbeConfig = {}, salt: number = Math.floor(Math.random() * 0x7fffffff)) {
        this.maxChars = config.maxChars ?? DEFAULT_MAX_CHARS
        this.salt = salt
        this.pattern = config.heartbeat?.dataPattern ? safeRegExp(config.heartbeat.dataPattern) : null
        this.needsPayload = Boolean(config.sequence?.field || config.timestampField || (config.partitionBy && config.partitionBy !== '$event'))
    }

    probe(input: ProbeInput): ProbeResult {
        const truncated = input.data.length > this.maxChars
        // The hash covers the first maxChars characters plus the total length, so huge payloads stay cheap.
        const hashed = truncated ? `${input.data.slice(0, this.maxChars)}\u0000${input.data.length}` : input.data
        const result: ProbeResult = { dataHash: hash53(hashed, this.salt).toString(16) }
        if (truncated) result.payloadTruncated = true

        const extracted = this.extract(input, truncated)
        if (extracted) result.extracted = extracted
        return result
    }

    private extract(input: ProbeInput, truncated: boolean): Extracted | undefined {
        const { config } = this
        const out: Extracted = {}
        let payload: unknown
        let parsed = false
        if (this.needsPayload && !truncated) {
            try { payload = JSON.parse(input.data); parsed = true } catch { /* not JSON: only the non-payload fields apply */ }
        }

        if (config.sequence?.useSseId && input.id !== '') out.seq = /^\d{1,15}$/.test(input.id) ? Number(input.id) : input.id
        if (config.sequence?.field && parsed) {
            const value = getJsonPath(payload, config.sequence.field)
            if (typeof value === 'number' && Number.isFinite(value)) out.seq = value
            else if (typeof value === 'string' && value !== '') out.seq = value
        }
        if (config.timestampField && parsed) {
            const value = getJsonPath(payload, config.timestampField)
            if (typeof value === 'number' && Number.isFinite(value)) out.ts = value
            else if (typeof value === 'string') { const ms = Date.parse(value); if (Number.isFinite(ms)) out.ts = ms }
        }
        if (config.partitionBy === '$event') out.partition = input.event
        else if (config.partitionBy && parsed) {
            const value = getJsonPath(payload, config.partitionBy)
            if (typeof value === 'string' || typeof value === 'number') out.partition = String(value)
        }
        if (config.heartbeat) {
            out.isHeartbeat = (config.heartbeat.events?.includes(input.event) ?? false) || (this.pattern?.test(input.data) ?? false)
        }
        return Object.keys(out).length > 0 ? out : undefined
    }
}

function safeRegExp(source: string): RegExp | null {
    try { return new RegExp(source) } catch { return null }
}
