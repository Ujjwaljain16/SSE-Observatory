// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { analyze, createEngine } from '../engine'
import { DEFAULT_THRESHOLDS, resolveThresholds, type StreamProfile, type Thresholds } from '../thresholds'
import { parseCapture, captureEndT, type CaptureRecord } from '../../capture/format'
import type { EngineInput } from '../streamModel'
import type { Finding } from '../finding'
import { build, plan } from '../../testing/randomCapture'

// Campaign C4: the engine for any threshold value. Thresholds are not validated (plan Q5 says users do not set them in v2.0), but a program
// that embeds the engine can, and a profile's `expected` numbers come from a file a person wrote. Whatever the numbers are (zero, negative,
// fractional, NaN, infinite, enormous), the engine must not throw, must give the same answer live as in batch, and must not print "NaN" or
// "Infinity" in a sentence a person reads.

const NUMERIC_KEYS = (Object.keys(DEFAULT_THRESHOLDS) as Array<keyof Thresholds>).filter((k) => typeof DEFAULT_THRESHOLDS[k] === 'number')
const ODD = [0, -1, 0.5, 1, 1e-9, 2, 1e12, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER]

const oddThresholds = fc.dictionary(fc.constantFrom(...NUMERIC_KEYS), fc.constantFrom(...ODD), { maxKeys: 8 }) as fc.Arbitrary<Partial<Thresholds>>
const oddProfile = fc.record({
    expected: fc.option(fc.record({
        firstEventMs: fc.option(fc.constantFrom(...ODD), { nil: undefined }),
        maxSilenceMs: fc.option(fc.constantFrom(...ODD), { nil: undefined }),
        heartbeatMs: fc.option(fc.constantFrom(...ODD), { nil: undefined }),
    }), { nil: undefined }),
}) as fc.Arbitrary<StreamProfile>

const textOf = (f: Finding): string[] => [
    f.title, f.summary, ...f.facts.map((x) => x.text), ...f.deductions.flatMap((d) => [d.statement, ...d.alternatives]), ...f.limits, f.nextCheck?.description ?? '', f.nextCheck?.command ?? '',
]
const BROKEN = /\bNaN\b|\bundefined\b|[-+]?\bInfinity\b|\[object/

/** Only the `expected` numbers of a profile may be odd; they are what a person types. Everything else in the finding comes from measurements. */
function brokenText(findings: Finding[]): string[] {
    const out: string[] = []
    for (const f of findings) for (const t of textOf(f)) if (BROKEN.test(t)) out.push(`${f.key}: ${t.slice(0, 120)}`)
    return out
}

function live(records: EngineInput[], endT: number, thresholds: Partial<Thresholds>, profile: StreamProfile | undefined) {
    const engine = createEngine({ thresholds, ...(profile ? { profile } : {}) })
    for (const o of records) { engine.feed(o); engine.tick(o.t) }
    engine.tick(endT)
    engine.end(endT)
    return engine.findings()
}

describe('the engine with any threshold value', () => {
    it('random captures, odd thresholds: never throws, live equals batch, no NaN in a sentence', () => {
        const broken = new Set<string>()
        fc.assert(
            fc.property(plan, oddThresholds, (p, thresholds) => {
                const b = build(p)
                const records = b.build()
                const endT = b.now + 20_000
                const batch = analyze(records, { thresholds, endT }).findings
                expect(live(records, endT, thresholds, undefined)).toEqual(batch)
                for (const t of brokenText(batch)) broken.add(t.replace(/\d+/g, '#'))
            }),
            { seed: 51, numRuns: 400 },
        )
        expect([...broken]).toEqual([])
    })

    it('random captures, odd profile expectations: never throws, no NaN in a sentence', () => {
        const broken = new Set<string>()
        fc.assert(
            fc.property(plan, oddProfile, (p, profile) => {
                const b = build(p)
                const found = analyze(b.build(), { profile, endT: b.now + 60_000 }).findings
                for (const t of brokenText(found)) broken.add(t.replace(/\d+/g, '#'))
            }),
            { seed: 52, numRuns: 400 },
        )
        expect([...broken]).toEqual([])
    })

    it('every lab capture, every threshold set to one odd value at a time (and all at once)', () => {
        const dir = path.resolve(process.cwd(), 'public/lab')
        const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) as { entries: Array<{ id: string; file: string }> }
        const broken = new Set<string>()
        let runs = 0
        for (const entry of index.entries) {
            const capture = parseCapture(fs.readFileSync(path.join(dir, entry.file), 'utf8')).capture
            const records = capture.records as CaptureRecord[] as unknown as EngineInput[]
            const endT = captureEndT(capture)
            const sets: Array<Partial<Thresholds>> = []
            for (const key of NUMERIC_KEYS) for (const value of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1e12]) sets.push({ [key]: value })
            for (const value of [0, Number.NaN, Number.POSITIVE_INFINITY]) sets.push(Object.fromEntries(NUMERIC_KEYS.map((k) => [k, value])) as Partial<Thresholds>)
            for (const thresholds of sets) {
                runs++
                const found = analyze(records, { thresholds, ...(capture.header.profile ? { profile: capture.header.profile } : {}), endT }).findings
                for (const t of brokenText(found)) broken.add(`${entry.id}: ${t.replace(/\d+/g, '#')}`)
            }
        }
        expect(runs).toBeGreaterThan(1000)
        expect([...broken]).toEqual([])
    })
})

describe('what is done with a threshold that cannot be used', () => {
    it('ignores an override that is not a finite number of at least zero, keeps zero and a very large number', () => {
        const r = resolveThresholds({ stallMinSilenceMs: Number.NaN, connectToHeadersMs: -5, firstByteToEventMs: Number.POSITIVE_INFINITY, headersToFirstByteMs: 0, stallNoCadenceMs: 1e12, loopWindowMs: '5' as unknown as number })
        expect(r.stallMinSilenceMs).toBe(DEFAULT_THRESHOLDS.stallMinSilenceMs)
        expect(r.connectToHeadersMs).toBe(DEFAULT_THRESHOLDS.connectToHeadersMs)
        expect(r.firstByteToEventMs).toBe(DEFAULT_THRESHOLDS.firstByteToEventMs)
        expect(r.loopWindowMs).toBe(DEFAULT_THRESHOLDS.loopWindowMs)
        expect(r.headersToFirstByteMs).toBe(0)
        expect(r.stallNoCadenceMs).toBe(1e12)
        expect(resolveThresholds({ credentialParamNames: ['x'] }).credentialParamNames).toEqual(['x'])
    })

    it('a profile with expected timings that are not usable behaves as if it had none, in what a stall says about its limit', () => {
        const records = build({ steps: [{ op: 'frame', dt: 100 }, { op: 'frame', dt: 100 }, { op: 'frame', dt: 100 }], ticks: [], headers: 'ok' }).silence(40_000)
        const bad = analyze(records.build(), { profile: { expected: { maxSilenceMs: Number.NaN, heartbeatMs: -1, firstEventMs: Number.POSITIVE_INFINITY } }, endT: records.now })
        const none = analyze(records.build(), { endT: records.now })
        expect(bad.findings).toEqual(none.findings)
    })
})
