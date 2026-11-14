import { describe, expect, it } from 'vitest'
import type { Finding } from '../../diagnostics/finding'
import { maskMeasured, normaliseFindings, withoutChunkEvidence } from '../normalise'

const records = [
    { seq: 10, conn: 0, kind: 'connect' },
    { seq: 11, conn: 0, kind: 'chunk' },
    { seq: 12, conn: 0, kind: 'event', sseId: '1' },
    { seq: 13, conn: 0, kind: 'event', sseId: '2' },
    { seq: 14, conn: 1, kind: 'connect' },
    { seq: 15, conn: 1, kind: 'event', sseId: '8' },
]

const finding = (over: Partial<Finding> = {}): Finding => ({
    key: 'resume.last-event-id:skipped', ruleId: 'resume.last-event-id', ruleVersion: 1, severity: 'error', title: 'Title 4.2 s', summary: 'Summary 512 bytes',
    facts: [{ text: 'Numbers 5-7 never arrived after 4.2 s and 1500 ms (512 bytes, 3 KiB).', evidence: [{ seq: 13, t: 4200, note: 'last before, 4.2 s in' }, { seq: 15, t: 4300 }] }],
    deductions: [{ statement: 'Likely: the history was shorter than 30 s.', confidence: 'medium', basis: [13], alternatives: ['b alternative 2 min', 'a alternative'] }],
    limits: ['x'], status: 'open', firstSeenT: 4200, lastSeenT: 4300, occurrences: 1, data: { ranges: [{ from: 5, to: 7 }], truncated: false, other: 'ignored' },
    ...over,
})

describe('normalised findings', () => {
    it('mask measured quantities and nothing else: units are replaced, counts, ids and ranges are not', () => {
        expect(maskMeasured('4.2 s, 1500 ms, 512 bytes, 1 byte, 3 KiB, 2 MiB, 5 min, 7B')).toBe('#unit, #unit, #unit, #unit, #unit, #unit, #unit, #unit')
        expect(maskMeasured('4 connections, ids 5-7, event 12, 3 events')).toBe('4 connections, ids 5-7, event 12, 3 events')
    })

    it('keep what a replay must reproduce and drop what it cannot (times, record numbers, prose)', () => {
        const [n] = normaliseFindings([finding()], records)
        expect(n).toEqual({
            key: 'resume.last-event-id:skipped', ruleId: 'resume.last-event-id', ruleVersion: 1, severity: 'error', status: 'open', confidences: ['medium'],
            deductionStems: ['Likely: the history was shorter than #unit. | a alternative / b alternative #unit'],
            factStems: ['Numbers 5-7 never arrived after #unit and #unit (#unit, #unit).'],
            evidence: [{ kind: 'event', conn: 0, ordinal: 1, sseId: '2', note: 'last before, #unit in' }, { kind: 'event', conn: 1, ordinal: 0, sseId: '8' }],
            occurrences: 1, data: { ranges: [{ from: 5, to: 7 }], truncated: false },
        })
        expect(JSON.stringify(n)).not.toMatch(/firstSeenT|lastSeenT|"seq"|"t":|summary|title|limits/)
    })

    it('point evidence at "the second event of connection 0", so two runs that numbered their records differently still agree', () => {
        const shifted = records.map((r) => ({ ...r, seq: r.seq + 100 }))
        const moved = finding({ facts: [{ text: 'f', evidence: [{ seq: 113, t: 9 }] }] })
        const plain = finding({ facts: [{ text: 'f', evidence: [{ seq: 13, t: 4200 }] }] })
        expect(normaliseFindings([moved], shifted)).toEqual(normaliseFindings([plain], records))
    })

    it('mask the number of the read a framing slip was noticed in (how the bytes were cut up), but not any other note', () => {
        const at = (note: string) => normaliseFindings([finding({ facts: [{ text: 'f', evidence: [{ seq: 12, t: 1, note }] }] })], records)
        expect(at('chunk 3')).toEqual(at('chunk 17'))
        expect(at('chunk 3')[0]!.evidence[0]!.note).toBe('chunk #')
        expect(at('chunk 3')).not.toEqual(at('first body byte'))
        expect(at('first body byte')[0]!.evidence[0]!.note).toBe('first body byte')
    })

    it('say so when evidence points at a record that is not in the capture, instead of throwing', () => {
        const [n] = normaliseFindings([finding({ facts: [{ text: 'f', evidence: [{ seq: 999, t: 0 }] }] })], records)
        expect(n!.evidence).toEqual([{ kind: 'missing', conn: -1, ordinal: -1 }])
    })

    it('are ordered by key, and leave out chunk evidence on request', () => {
        const list = normaliseFindings([finding({ key: 'b' }), finding({ key: 'a', facts: [{ text: 'f', evidence: [{ seq: 11, t: 1 }, { seq: 12, t: 2 }] }] })], records)
        expect(list.map((n) => n.key)).toEqual(['a', 'b'])
        expect(withoutChunkEvidence(list[0]!).evidence.map((e) => e.kind)).toEqual(['event'])
    })

    it('differ when a conclusion differs: severity, a range, a fact, an occurrence', () => {
        const base = normaliseFindings([finding()], records)
        for (const change of [{ severity: 'warning' as const }, { occurrences: 2 }, { data: { ranges: [{ from: 5, to: 8 }], truncated: false } }, { status: 'resolved' as const }]) {
            expect(normaliseFindings([finding(change)], records)).not.toEqual(base)
        }
        expect(normaliseFindings([finding({ facts: [{ text: 'Numbers 5-8 never arrived', evidence: [] }] })], records)).not.toEqual(base)
    })
})
