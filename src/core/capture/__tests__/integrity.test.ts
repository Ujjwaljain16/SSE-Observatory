import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { newHeader, parseCapture, serializeCapture, type Capture, type CaptureRecord } from '../format'
import { importV1 } from '../importV1'
import { describeCaptureProblems, MAX_CAPTURE_PROBLEMS, validateCaptureIntegrity } from '../integrity'
import { loadCaptureText } from '../../../doctor/loadCapture'
import { sessionFromCapture } from '../../../../lib/mock/capturePlan.js'

// Owner decision: a duplicate `seq` or a backwards `t` in a capture file must not pass as healthy. The rules, exactly:
//   1. every record has a text `kind` and finite numbers `seq` and `t`            -> record.invalid
//   2. `seq` is never used twice in a capture (anywhere in it)                    -> seq.duplicate
//   3. `seq` never goes down from one record to the next                          -> seq.order   (a seq that is not a repeat)
//   4. `t` never goes down from one record to the next (equal is legal)           -> t.backwards
// Every problem says which record (its seq, its position and, from a file, its line).

const rec = (seq: number, t: number, extra: Record<string, unknown> = {}): CaptureRecord => ({ seq, t, conn: 0, kind: 'comment', text: `c${seq}`, source: 'upstream', ...extra }) as CaptureRecord
const codes = (records: CaptureRecord[]) => validateCaptureIntegrity(records).map((p) => p.code)

describe('validateCaptureIntegrity: it keeps nothing per record while a capture is healthy', () => {
    // The documented limit (docs/technical/limitations.md, section 9) is that a 1.2 million record capture is analysed inside a 384 MB heap.
    // A map from every seq to its position held 1.2 million entries, and the release-candidate run (scripts/perf/large-capture.mjs) found the
    // command line killed in that heap. A seq that rises beyond every earlier one cannot be a repeat, so a healthy capture needs no such table.
    it('a rising seq adds nothing to a Map or a Set, however many records there are', () => {
        const records: CaptureRecord[] = []
        for (let i = 0; i < 50_000; i++) records.push(rec(i, i))
        let kept = 0
        const set = Map.prototype.set
        const add = Set.prototype.add
        Map.prototype.set = function (this: Map<unknown, unknown>, ...args: [unknown, unknown]) { kept++; return set.apply(this, args) } as typeof Map.prototype.set
        Set.prototype.add = function (this: Set<unknown>, value: unknown) { kept++; return add.call(this, value) } as typeof Set.prototype.add
        try {
            expect(validateCaptureIntegrity(records)).toEqual([])
        } finally {
            Map.prototype.set = set
            Set.prototype.add = add
        }
        expect(kept, 'entries kept while checking a healthy capture').toBe(0)
    })

    it('a repeat of a seq far back is still found once the order has broken, and reports the first record that had it', () => {
        const records: CaptureRecord[] = []
        for (let i = 0; i < 1000; i++) records.push(rec(i, i))
        records.push(rec(3, 1000)) // a seq the first thousand already used, long before
        records.push(rec(1000, 1001))
        const problems = validateCaptureIntegrity(records)
        expect(problems.map((p) => p.code)).toContain('seq.duplicate')
        const dup = problems.find((p) => p.code === 'seq.duplicate')!
        expect(dup.seq).toBe(3)
        expect(dup.index).toBe(1000)
        expect(dup.message).toContain('record #1001')
        expect(dup.message).toContain('record #4')
    })

    it('an invalid record is not a seq that was used: it neither hides nor causes a duplicate', () => {
        const records = [rec(0, 0), { kind: 'comment', seq: 'x', t: 1 } as unknown as CaptureRecord, rec(1, 2), rec(0, 3)]
        // the repeat of seq 0 is one fault (a repeat is not also reported as out of order), and t does not go back
        expect(codes(records)).toEqual(['record.invalid', 'seq.duplicate'])
    })
})

describe('validateCaptureIntegrity: healthy captures are not flagged', () => {
    it('nothing, one record, strictly increasing seq with t that rises or stays equal', () => {
        expect(validateCaptureIntegrity([])).toEqual([])
        expect(validateCaptureIntegrity([rec(0, 0)])).toEqual([])
        expect(validateCaptureIntegrity([rec(0, 0), rec(1, 0), rec(2, 5), rec(3, 5), rec(4, 5.5), rec(5, 1e9)])).toEqual([])
    })

    it('a seq that does not start at 0 or skips numbers is legal (a capture trimmed to a window, or records dropped by the memory cap)', () => {
        expect(validateCaptureIntegrity([rec(40, 100), rec(41, 100), rec(50, 130), rec(1_000_000, 131)])).toEqual([])
    })

    it('records of every kind, including kinds this reader does not know, follow the same rules', () => {
        expect(validateCaptureIntegrity([rec(0, 0, { kind: 'future.metric', payload: { a: 1 } }), rec(1, 1, { kind: 'x' })])).toEqual([])
    })

    it('a long healthy capture (50 000 records) is checked quickly', () => {
        const records = Array.from({ length: 50_000 }, (_, i) => rec(i, Math.floor(i / 3)))
        const start = Date.now()
        expect(validateCaptureIntegrity(records)).toEqual([])
        expect(Date.now() - start).toBeLessThan(1000)
    })
})

describe('validateCaptureIntegrity: what is wrong, and where', () => {
    it('a duplicate seq: the second record is flagged, with the seq, its position and the position of the first', () => {
        const problems = validateCaptureIntegrity([rec(0, 0), rec(1, 5), rec(1, 9), rec(2, 12)])
        expect(problems).toHaveLength(1)
        expect(problems[0]).toMatchObject({ code: 'seq.duplicate', seq: 1, index: 2 })
        expect(problems[0]!.message).toMatch(/seq 1 is used twice/)
        expect(problems[0]!.message).toMatch(/record #3 repeats the seq of record #2/)
    })

    it('a duplicate that is not next to the first one is still a duplicate (and not also reported as out of order)', () => {
        expect(codes([rec(0, 0), rec(1, 1), rec(2, 2), rec(1, 3)])).toEqual(['seq.duplicate'])
        expect(codes([rec(5, 0), rec(6, 1), rec(5, 2), rec(5, 3)])).toEqual(['seq.duplicate', 'seq.duplicate'])
    })

    it('a seq that goes down without repeating one is out of order', () => {
        const problems = validateCaptureIntegrity([rec(0, 0), rec(5, 1), rec(3, 2), rec(6, 3)])
        expect(problems.map((p) => [p.code, p.seq, p.index])).toEqual([['seq.order', 3, 2]])
        expect(problems[0]!.message).toMatch(/seq goes backwards at record #3: seq 3 follows seq 5/)
    })

    it('a time that goes backwards is flagged at the record that went back, with both times; equal times are not', () => {
        const problems = validateCaptureIntegrity([rec(0, 100), rec(1, 100), rec(2, 40), rec(3, 70)])
        expect(problems.map((p) => [p.code, p.seq, p.index])).toEqual([['t.backwards', 2, 2]])
        expect(problems[0]!.message).toMatch(/time goes backwards at seq 2 \(record #3\): t=40 ms follows t=100 ms \(seq 1\)/)
    })

    it('a tiny step back is a step back (no tolerance)', () => {
        expect(codes([rec(0, 10), rec(1, 9.999)])).toEqual(['t.backwards'])
    })

    it('one record can break two rules, and every fault in a file is listed, in file order', () => {
        const problems = validateCaptureIntegrity([rec(0, 50), rec(0, 10), rec(1, 20), rec(9, 5), rec(8, 30)])
        expect(problems.map((p) => [p.index, p.code])).toEqual([[1, 'seq.duplicate'], [1, 't.backwards'], [3, 't.backwards'], [4, 'seq.order']])
    })

    it('a record that lacks what every record has is invalid, and does not make the others look wrong', () => {
        const bad = [rec(0, 0), { seq: 1, t: 1 }, { kind: 'x', seq: 'a', t: 2 }, { kind: 'x', seq: 3, t: Number.POSITIVE_INFINITY }, rec(4, 4), null, 7] as unknown as CaptureRecord[]
        const problems = validateCaptureIntegrity(bad)
        expect(problems.map((p) => [p.index, p.code])).toEqual([[1, 'record.invalid'], [2, 'record.invalid'], [3, 'record.invalid'], [5, 'record.invalid'], [6, 'record.invalid']])
        expect(problems[0]!.message).toMatch(/record #2: .*"kind".*"seq".*"t"/)
    })

    it('the list stops at a limit, so a hostile file cannot make the answer as big as the file', () => {
        const records = Array.from({ length: 5000 }, (_, i) => rec(0, 5000 - i))
        const problems = validateCaptureIntegrity(records)
        expect(problems.length).toBe(MAX_CAPTURE_PROBLEMS)
    })

    it('a line number is reported when the caller knows it', () => {
        const problems = validateCaptureIntegrity([rec(0, 0), rec(0, 1)], { lines: [2, 3] })
        expect(problems[0]).toMatchObject({ code: 'seq.duplicate', line: 3 })
        expect(problems[0]!.message).toMatch(/line 3/)
    })

    it('the wording a person reads says what is wrong, where, that analysis was not run, and does not say healthy', () => {
        const text = describeCaptureProblems(validateCaptureIntegrity([rec(0, 100), rec(0, 40)], { lines: [2, 3] }))
        expect(text).toMatch(/^Invalid capture: 2 problems/)
        expect(text).toMatch(/seq 0 is used twice/)
        expect(text).toMatch(/time goes backwards at seq 0/)
        expect(text).toMatch(/not analysed/i)
        expect(text).not.toMatch(/healthy/i)
        expect(describeCaptureProblems(validateCaptureIntegrity([rec(0, 100), rec(1, 40)]))).toMatch(/^Invalid capture: 1 problem\b/)
    })
})

describe('what the file reader does with it', () => {
    const file = (records: CaptureRecord[]) => serializeCapture({ header: newHeader({ kind: 'sanitized', source: { kind: 'fixture' } }), records })

    it('parseCapture still reads a damaged file as far as it goes, and now says what is wrong with its lines', () => {
        const parsed = parseCapture(file([rec(0, 0), rec(1, 5), rec(1, 9), rec(2, 12), rec(3, 3)]))
        expect(parsed.capture.records.map((r) => [r.seq, r.t])).toEqual([[0, 0], [1, 5], [1, 9], [2, 12], [3, 3]])
        expect(parsed.integrity).toBe('ok') // the hash is about tampering, and it is intact: the file was WRITTEN wrong
        expect(parsed.problems.map((p) => [p.code, p.seq, p.line])).toEqual([['seq.duplicate', 1, 4], ['t.backwards', 3, 6]])
    })

    it('a healthy file has no problems', () => {
        expect(parseCapture(file([rec(0, 0), rec(1, 5), rec(2, 5)])).problems).toEqual([])
    })

    it('the lines count the header, so they match the file in an editor, even with blank lines between records', () => {
        const text = file([rec(0, 0), rec(1, 5), rec(1, 9)]).split('\n')
        text.splice(2, 0, '') // a blank line after the first record
        expect(parseCapture(text.join('\n')).problems[0]).toMatchObject({ code: 'seq.duplicate', line: 5 })
    })

    it('the Doctor refuses the file with the same words the command line prints', () => {
        const loaded = loadCaptureText(file([rec(0, 0), rec(0, 9)]))
        expect(loaded.ok).toBe(false)
        if (loaded.ok) return
        expect(loaded.error).toMatch(/^Invalid capture: 1 problem\b/)
        expect(loaded.error).toMatch(/seq 0 is used twice/)
        expect(loaded.error).toMatch(/line 3/)
    })

    it('a healthy file still opens in the Doctor', () => {
        expect(loadCaptureText(file([rec(0, 0), rec(1, 9)])).ok).toBe(true)
    })

    it('the mock server and `replay` refuse an invalid capture too (they read the file without parseCapture)', () => {
        const bad = file([rec(0, 0, { kind: 'event', event: 'm', sseId: '1', dataBytes: 1, data: 'a' }), rec(1, 20, { kind: 'event', event: 'm', sseId: '2', dataBytes: 1, data: 'b' }), rec(2, 10, { kind: 'event', event: 'm', sseId: '3', dataBytes: 1, data: 'c' })])
        const refused = sessionFromCapture(bad)
        expect(refused.session).toBeUndefined()
        expect(refused.error).toMatch(/^Invalid capture: 1 problem\b/)
        expect(refused.error).toMatch(/time goes backwards at seq 2 \(line 4\)/)
        const good = file([rec(0, 0, { kind: 'event', event: 'm', sseId: '1', dataBytes: 1, data: 'a' }), rec(1, 20, { kind: 'event', event: 'm', sseId: '2', dataBytes: 1, data: 'b' })])
        expect(sessionFromCapture(good).error).toBeUndefined()
        // the same for the JSON envelope and the in-memory form
        expect(sessionFromCapture({ capture: bad }).error).toMatch(/^Invalid capture/)
        const parsed = parseCapture(bad).capture
        expect(sessionFromCapture({ header: parsed.header, records: parsed.records }).error).toMatch(/^Invalid capture/)
    })
})

describe('captures the product itself writes are valid', () => {
    it('every lab capture shipped in public/lab', () => {
        const dir = new URL('../../../../public/lab/', import.meta.url)
        const names = readdirSync(dir).filter((n) => n.endsWith('.sse-capture'))
        expect(names.length).toBeGreaterThan(5)
        for (const name of names) {
            const parsed = parseCapture(readFileSync(new URL(name, dir), 'utf8'))
            expect(parsed.problems, name).toEqual([])
        }
    })

    it('every v1 sample, imported (the times are a running sum of non-negative gaps, the seq is the position)', () => {
        const dir = new URL('./v1Samples/', import.meta.url)
        for (const name of readdirSync(dir)) {
            const capture: Capture = importV1(JSON.parse(readFileSync(new URL(name, dir), 'utf8')))
            expect(validateCaptureIntegrity(capture.records), name).toEqual([])
        }
        // damaged gaps (negative, missing, unreadable) never make a time go back
        const odd = importV1({ version: '1.0', events: [5, -1000, 0, -1, 7, -3, 'x', null].map((deltaMs) => ({ data: '', deltaMs })) })
        expect(validateCaptureIntegrity(odd.records)).toEqual([])
    })
})
