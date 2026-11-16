// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { analyze } from '../engine'
import { parseCapture, captureEndT, type Capture, type CaptureRecord } from '../../capture/format'
import { compareCaptures } from '../../capture/derived/compare'
import { healthyStart } from '../../testing/captureBuilder'
import { build, plan } from '../../testing/randomCapture'
import { SEVERITY_RANK, type Fact, type Finding } from '../finding'

// Campaign C3, "evidence is real". The Doctor's central promise is that a fact it states is backed by records it points at. This checks the
// pointers: every piece of evidence of every finding names a record that exists, with the time that record has; what the evidence's note says
// it is (the last byte, the response headers, a clock jump) is what kind of record it is; no fact says "last byte" while pointing at a clock
// jump; every deduction's basis exists. Over every capture in the failure lab (whole, cut short, with and without its profile), over random
// valid captures, and over comparisons (where a note's "A:" or "B:" says which capture the record is in).

const dir = path.resolve(process.cwd(), 'public/lab')
const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) as { entries: Array<{ id: string; file: string; healthyTwin: string | null }> }
const load = (file: string): Capture => parseCapture(fs.readFileSync(path.join(dir, file), 'utf8')).capture

const BYTES = ['chunk', 'comment', 'event', 'retry', 'violation', 'heartbeatSeries']

/**
 * What an evidence note claims the record is. Read from the rules; a note not listed here fails the test, so a new rule has to say what its
 * notes mean. `A: ` / `B: ` prefixes (comparison) are removed first.
 */
const NOTE_KINDS: Array<[RegExp, string[]]> = [
    [/^clock jump$/, ['clock.discontinuity']],
    [/^clock jump, measuring restarted here$/, ['clock.discontinuity']],
    [/^burst (start|end)$/, ['event']],
    [/^previous heartbeat$/, ['comment', 'heartbeatSeries']],
    [/^heartbeat$/, ['comment', 'heartbeatSeries']],
    [/^late heartbeat$/, ['comment', 'heartbeatSeries']],
    // a number delivered twice under a declared sequence (seq.integrity:replay) points at the two events; a framing violation says which chunk it was in
    [/^(first delivery|delivered again)$/, ['event']],
    [/^chunk \d+$/, ['violation']],
    [/^BAD_CONTENT_TYPE$|^HTTP_STATUS_NOT_\d+$/, ['violation']],
    [/^response( headers)?$/, ['response']],
    [/^up_idle=\d+ ms$/, ['comment']],
    [/^connection \d+$/, ['connect']],
    [/^(first event of this name|first event with the new shape|latest event|first event|last complete event|a later connection delivered an event)$/, ['event']],
    [/^connection ended$|^phase change$|^connection opened$/, ['phase', 'connect', 'response']],
    [/^data resumed$/, BYTES],
    [/^last byte$/, BYTES],
    [/^last origin output$/, BYTES],
    [/^first (body )?byte$/, BYTES],
    [/^stage complete$/, BYTES],
    [/^a later connection completed this stage$/, ['response', 'chunk', 'comment', 'event', 'heartbeatSeries']],
    // comparison
    [/^chunk of \d+ bytes$/, ['chunk']],
    [/^(event|first matched event|only in [AB])$/, ['event']],
]

/** Notes that appear without one: a fact whose evidence is the violations themselves, or the event that showed a skipped number. */
const NO_NOTE_KINDS: Record<string, string[]> = { 'proto.framing': ['violation'], 'resume.last-event-id': ['event'] }

/** The times a record may be pointed at by: its own, or, for a folded series or a consumer record, the span it stands for. */
function timesOf(r: CaptureRecord): number[] {
    const t = [r.t]
    const any = r as unknown as Record<string, unknown>
    if (r.kind === 'heartbeatSeries') t.push(Number(any.firstT), Number(any.lastT))
    if (r.kind === 'consumer') t.push(Number(any.receivedT), Number(any.processedT))
    return t.filter((x) => Number.isFinite(x))
}

type Shown = Pick<Finding, 'key' | 'severity' | 'facts' | 'deductions' | 'limits'> & Partial<Pick<Finding, 'ruleId' | 'occurrences' | 'firstSeenT' | 'lastSeenT'>>

let checkedFindings = 0
let checkedEvidence = 0

/** `side` picks the capture an evidence's record is in; a plain finding has one. */
function problemsIn(findings: Shown[], records: (side: 'A' | 'B') => Map<number, CaptureRecord>, where: string, compared = false): string[] {
    const problems: string[] = []
    const keys = new Set<string>()
    for (const f of findings) {
        checkedFindings++
        const at = `${where} ${f.key}`
        if (keys.has(f.key)) problems.push(`${at}: the key appears twice`)
        keys.add(f.key)
        if (!(f.severity in SEVERITY_RANK)) problems.push(`${at}: unknown severity ${f.severity}`)
        if (f.occurrences !== undefined && !(f.occurrences >= 1)) problems.push(`${at}: occurrences ${f.occurrences}`)
        if (f.firstSeenT !== undefined && f.lastSeenT !== undefined && !(f.firstSeenT <= f.lastSeenT)) problems.push(`${at}: first seen ${f.firstSeenT} is after last seen ${f.lastSeenT}`)
        if (f.facts.length === 0) problems.push(`${at}: a finding with no fact`)
        for (const fact of f.facts as Fact[]) {
            if (fact.text.trim() === '') problems.push(`${at}: an empty fact`)
            if (/\bNaN\b|undefined|Infinity|\[object/.test(fact.text)) problems.push(`${at}: a fact with a broken value: "${fact.text.slice(0, 80)}"`)
            for (const e of fact.evidence) {
                checkedEvidence++
                const side = compared ? (/^([AB]): /.exec(e.note ?? '')?.[1] as 'A' | 'B' | undefined) : 'A'
                if (!side) { problems.push(`${at}: a comparison's evidence does not say which capture it is in ("${e.note ?? ''}")`); continue }
                const r = records(side).get(e.seq)
                if (!r) { problems.push(`${at}: evidence points at seq ${e.seq}, which is not a record ("${fact.text.slice(0, 60)}")`); continue }
                if (!timesOf(r).some((t) => Math.abs(t - e.t) < 1e-6)) problems.push(`${at}: evidence says seq ${e.seq} is at t=${e.t}, the record is at t=${r.t} ("${fact.text.slice(0, 60)}")`)
                const note = (e.note ?? '').replace(/^[AB]: /, '')
                const allowed = note === '' ? (compared ? undefined : NO_NOTE_KINDS[f.ruleId ?? '']) : NOTE_KINDS.find(([re]) => re.test(note))?.[1]
                if (!allowed) { problems.push(`${at}: an evidence note this test does not know ("${note}"): say what record it points at in NOTE_KINDS`); continue }
                if (!allowed.includes(r.kind)) problems.push(`${at}: the note "${note}" says one thing, the record at seq ${e.seq} is a "${r.kind}" ("${fact.text.slice(0, 60)}")`)
            }
            // what the words claim must not be contradicted by what is pointed at
            if (/after the last byte at t=/.test(fact.text) && fact.evidence.some((e) => /clock jump/.test(e.note ?? ''))) {
                problems.push(`${at}: the fact says "the last byte" is at a time that is a clock jump, not a byte ("${fact.text.slice(0, 80)}")`)
            }
        }
        for (const d of f.deductions) {
            if (!/^Likely:/.test(d.statement)) problems.push(`${at}: a deduction not worded as one: "${d.statement.slice(0, 60)}"`)
            if (d.alternatives.length === 0) problems.push(`${at}: a deduction that names no alternative`)
            for (const s of d.basis) if (!records('A').has(s)) problems.push(`${at}: a deduction rests on seq ${s}, which is not a record`)
        }
        if (f.limits.length === 0 && f.severity !== 'info') problems.push(`${at}: states no limit`)
    }
    return problems
}

const bySeq = (records: readonly CaptureRecord[]): Map<number, CaptureRecord> => new Map(records.map((r) => [r.seq, r]))

describe('the evidence a finding cites is real', () => {
    const cuts = [0.15, 0.3, 0.5, 0.7, 0.9, 1]
    for (const entry of index.entries) {
        it(`${entry.id}: whole, cut short, with and without its profile`, () => {
            const capture = load(entry.file)
            const records = capture.records as CaptureRecord[]
            const all: string[] = []
            for (const profile of [capture.header.profile, undefined]) {
                for (const c of cuts) {
                    const n = Math.max(1, Math.floor(records.length * c))
                    const part = records.slice(0, n)
                    const endT = c === 1 ? captureEndT(capture) : part[part.length - 1]!.t
                    const analysis = analyze(part as never, { ...(profile ? { profile } : {}), endT })
                    all.push(...problemsIn(analysis.findings, () => bySeq(part), `${entry.id} ${c === 1 ? 'whole' : `first ${Math.round(c * 100)}%`} ${profile ? 'with profile' : 'no profile'}:`))
                }
            }
            expect(all).toEqual([])
        })
    }

    it('random valid captures (reconnects, stalls, clock jumps, odd headers), judged as they end and long after', () => {
        const all = new Set<string>()
        fc.assert(
            fc.property(plan, fc.constantFrom(0, 20_000, 120_000), (p, extra) => {
                const b = build(p)
                const records = b.build()
                const found = problemsIn(analyze(records, { endT: b.now + extra }).findings, () => bySeq(records as never), 'random:')
                for (const f of found) all.add(f.replace(/\d+(\.\d+)?/g, '#'))
                return true
            }),
            { seed: 41, numRuns: 500, endOnFailure: false },
        )
        expect([...all]).toEqual([])
    })

    it('comparisons: each lab capture against its healthy twin and against a plain healthy stream, both ways round', () => {
        const byId = new Map(index.entries.map((e) => [e.id, e]))
        const healthy = load(byId.get('h01')!.file)
        const pairs: Array<[string, Capture, Capture]> = []
        for (const e of index.entries) {
            const twin = e.healthyTwin ? byId.get(e.healthyTwin) : undefined
            if (twin) { pairs.push([`${e.id} vs ${twin.id}`, load(e.file), load(twin.file)]); pairs.push([`${twin.id} vs ${e.id}`, load(twin.file), load(e.file)]) }
            pairs.push([`${e.id} vs h01`, load(e.file), healthy])
        }
        const all: string[] = []
        for (const [name, a, b] of pairs) {
            const found = compareCaptures(a, b)
            all.push(...problemsIn(found as unknown as Shown[], (side) => bySeq((side === 'A' ? a : b).records as CaptureRecord[]), `${name}:`, true))
        }
        expect(all).toEqual([])
    })

    it('after a clock jump, a silence is counted from the jump, and the fact does not call the jump "the last byte"', () => {
        // the last byte was at 6 s; at 8 s the clock jumped; 40 s of silence follow
        const b = healthyStart().frame().silence(3000).frame().silence(3000).frame().silence(2000).discontinuity(60_000).silence(40_000)
        const records = b.build()
        const stall = analyze(records, { endT: b.now }).findings.find((f) => f.key === 'stall.silent:bytes')!
        const text = stall.facts[0]!.text
        expect(text).toContain('counted from t=8 s')
        expect(text).not.toContain('last byte at t=8 s')
        expect(problemsIn([stall], () => bySeq(records as never), 'clock jump:')).toEqual([])
    })

    it('looked at something: findings and evidence were actually checked, so a pass is not an empty loop', () => {
        expect(checkedFindings).toBeGreaterThan(300)
        expect(checkedEvidence).toBeGreaterThan(500)
    })
})
