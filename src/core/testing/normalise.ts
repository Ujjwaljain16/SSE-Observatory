/**
 * Findings with everything that legitimately differs between two observations of the same stream taken away, so that two runs
 * (a live run and its replay, or a replay and a second replay) can be compared by what they CONCLUDE.
 *
 * Left out on purpose: record sequence numbers and times (`seq`, `t`, `firstSeenT`, `lastSeenT`), the prose summary and title (they
 * carry measured numbers), `limits`, the next-check command, and the capture id. Measured quantities inside fact and deduction
 * wording ("4.2 s", "512 bytes") are masked as `#unit`; sequence numbers and id ranges are not, so a gap `5-7` survives.
 *
 * Evidence is mapped from "a record number" to "which record": its kind, its connection, and its place among the records of that kind
 * on that connection (plus the SSE id for an event). Two runs number their records differently; they do not point at different things.
 */

import type { Confidence, Evidence, Finding, Severity } from '../diagnostics/finding'

export interface EvidenceRef {
    kind: string
    conn: number
    /** Index among the records of the same kind on the same connection; -1 when the record is not in the capture. */
    ordinal: number
    sseId?: string
    note?: string
}

export interface NormalisedFinding {
    key: string
    ruleId: string
    ruleVersion: number
    severity: Severity
    status: 'open' | 'resolved'
    confidences: Confidence[]
    deductionStems: string[]
    factStems: string[]
    evidence: EvidenceRef[]
    occurrences: number
    data: { ranges?: unknown; truncated?: unknown }
}

/** The part of a record the normaliser reads. Any capture record satisfies it. */
export interface RecordLike { seq: number; conn: number; kind: string; sseId?: unknown }

const MEASURED = /\b\d+(?:\.\d+)?\s?(?:ms|s|min|KiB|MiB|bytes?|B)\b/g

/** Replaces a measured quantity with `#unit`. Plain numbers (counts, ids, ranges) stay. */
export const maskMeasured = (text: string): string => text.replace(MEASURED, '#unit')

/** A framing finding's evidence says which read a slip was noticed in ("chunk 3"). That number is how the bytes happened to be cut up, which differs between two reads of the same bytes, so it is masked. */
const maskChunkIndex = (note: string): string => note.replace(/\bchunk \d+\b/g, 'chunk #')

export function evidenceRefs(evidence: readonly Evidence[], records: readonly RecordLike[]): EvidenceRef[] {
    const bySeq = new Map<number, RecordLike & { ordinal: number }>()
    const seen = new Map<string, number>()
    for (const r of records) {
        const slot = `${r.conn}|${r.kind}`
        const ordinal = seen.get(slot) ?? 0
        seen.set(slot, ordinal + 1)
        bySeq.set(r.seq, { ...r, ordinal })
    }
    return evidence.map((e) => {
        const r = bySeq.get(e.seq)
        const note = e.note === undefined ? undefined : maskChunkIndex(maskMeasured(e.note))
        if (!r) return { kind: 'missing', conn: -1, ordinal: -1, ...(note !== undefined ? { note } : {}) }
        return { kind: r.kind, conn: r.conn, ordinal: r.ordinal, ...(r.kind === 'event' && typeof r.sseId === 'string' ? { sseId: r.sseId } : {}), ...(note !== undefined ? { note } : {}) }
    })
}

export function normaliseFinding(f: Finding, records: readonly RecordLike[]): NormalisedFinding {
    const data: NormalisedFinding['data'] = {}
    if (f.data && 'ranges' in f.data) data.ranges = f.data['ranges']
    if (f.data && 'truncated' in f.data) data.truncated = f.data['truncated']
    return {
        key: f.key,
        ruleId: f.ruleId,
        ruleVersion: f.ruleVersion,
        severity: f.severity,
        status: f.status,
        confidences: f.deductions.map((d) => d.confidence),
        deductionStems: f.deductions.map((d) => `${maskMeasured(d.statement)} | ${[...d.alternatives].map(maskMeasured).sort().join(' / ')}`),
        factStems: f.facts.map((x) => maskMeasured(x.text)),
        evidence: evidenceRefs(f.facts.flatMap((x) => x.evidence), records),
        occurrences: f.occurrences,
        data,
    }
}

/** Every finding normalised, ordered by key so two runs line up. */
export function normaliseFindings(findings: readonly Finding[], records: readonly RecordLike[]): NormalisedFinding[] {
    return findings.map((f) => normaliseFinding(f, records)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** The same finding without its chunk evidence: event-level replay re-chunks, so what a chunk number points at is not comparable. */
export const withoutChunkEvidence = (n: NormalisedFinding): NormalisedFinding => ({ ...n, evidence: n.evidence.filter((e) => e.kind !== 'chunk') })
