import { VIOLATIONS, type ViolationCode } from '../../sse/violations'
import { maxSeverity, type Deduction, type Evidence, type FindingDraft, type Severity } from '../finding'
import type { Rule } from '../rule'
import { ev, plural } from './util'

/**
 * R02 proto.framing: what the parser noticed about the stream's framing, one finding per violation code (never per
 * occurrence), with the count and the first few examples. Severity comes from the record, which follows the WHATWG
 * spec. HTTP-level violations belong to R01 and are not repeated here.
 */

const HTTP_LEVEL = new Set<ViolationCode>(['BAD_CONTENT_TYPE', 'HTTP_STATUS_NOT_200'])

interface Agg { count: number; firstT: number; severity: Severity; examples: Array<Evidence & { detail: string }> }

const DEDUCTIONS: Partial<Record<ViolationCode, Omit<Deduction, 'basis'>>> = {
    WRONG_CASE_FIELD: { statement: 'Likely: a producer bug; the line is ignored, so its data never reaches the application.', confidence: 'medium', alternatives: ['A deliberate non-standard field that is harmless.'] },
    UNTERMINATED_FRAME: { statement: 'Likely: the producer wrote an event without the blank line that ends it, or the connection was cut mid-event.', confidence: 'low', alternatives: ['A proxy or timeout closed the connection mid-event.', 'The producer crashed while writing.'] },
    NUL_IN_ID: { statement: 'Likely: the producer builds ids from binary data; resuming from that id will not work.', confidence: 'low', alternatives: ['A corrupt id on one event only.'] },
    MIXED_LINE_ENDINGS: { statement: 'Likely: more than one writer or a template mixes line ending styles; harmless to conforming clients.', confidence: 'low', alternatives: ['A proxy normalised some lines.'] },
}

export const framing: Rule = {
    id: 'proto.framing',
    version: 1,
    title: 'Stream framing',
    requires: ['violations'],
    create({ thresholds }) {
        const byCode = new Map<ViolationCode, Agg>()
        return {
            onObservation(o) {
                if (o.kind !== 'violation' || HTTP_LEVEL.has(o.code)) return
                const agg = byCode.get(o.code) ?? { count: 0, firstT: o.t, severity: o.severity, examples: [] }
                agg.count++
                agg.severity = maxSeverity(agg.severity, o.severity)
                if (agg.examples.length < thresholds.framingExamples) agg.examples.push({ ...ev(o.seq, o.t, o.chunk !== undefined ? `chunk ${o.chunk}` : undefined), detail: o.detail })
                byCode.set(o.code, agg)
                const note = VIOLATIONS[o.code].note
                const examples = agg.examples
                const shown = examples.length < agg.count ? ` (first ${examples.length} shown)` : ''
                const draft: FindingDraft = {
                    key: `proto.framing:${o.code}`,
                    severity: agg.severity,
                    title: `Framing: ${o.code}`,
                    summary: `${plural(agg.count, 'occurrence')} of ${o.code}. ${note}`,
                    facts: [{ text: `The parser reported ${o.code} ${plural(agg.count, 'time')}${shown}.`, evidence: examples.map(({ seq, t, note: n }) => ev(seq, t, n)) },
                        ...examples.map((e) => ({ text: e.detail, evidence: [ev(e.seq, e.t)] }))],
                    deductions: DEDUCTIONS[o.code] ? [{ ...DEDUCTIONS[o.code]!, basis: examples.map((e) => e.seq) }] : [],
                    limits: ['Severity follows the WHATWG spec: error means a conforming EventSource would fail the connection, warning means data is lost or a producer mistake is likely, info means the spec ignores or normalises it.'],
                    status: 'open', firstSeenT: agg.firstT, lastSeenT: o.t, occurrences: agg.count,
                }
                return [draft]
            },
        }
    },
}
