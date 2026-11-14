import fc from 'fast-check'
import { capture, type CaptureBuilder } from './captureBuilder'

/**
 * Random but valid captures, shared by the engine's property tests: connections open, speak, are dropped and reopened, with gaps from
 * milliseconds to a minute and a half between records. A plan is what fast-check generates and shrinks; `build` turns it into records.
 */

export type Step = { op: 'frame' | 'beat' | 'proxyBeat' | 'chunk' | 'event' | 'retry' | 'violation' | 'discontinuity' | 'reconnect' | 'end'; dt: number }
export interface Plan { steps: Step[]; ticks: number[][]; headers: 'ok' | 'html' | 'status' }

const OPS = ['frame', 'frame', 'frame', 'beat', 'proxyBeat', 'chunk', 'event', 'retry', 'violation', 'discontinuity', 'reconnect', 'end'] as const

const step = fc.record({
    op: fc.constantFrom(...OPS),
    dt: fc.oneof({ weight: 6, arbitrary: fc.integer({ min: 0, max: 1500 }) }, { weight: 2, arbitrary: fc.integer({ min: 1500, max: 12_000 }) }, { weight: 1, arbitrary: fc.integer({ min: 12_000, max: 90_000 }) }),
}) as fc.Arbitrary<Step>

export const plan = fc.record({
    steps: fc.array(step, { minLength: 0, maxLength: 80 }),
    ticks: fc.array(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 3 }), { minLength: 90, maxLength: 90 }),
    headers: fc.constantFrom('ok', 'ok', 'ok', 'html', 'status'),
}) as fc.Arbitrary<Plan>

/** A valid capture: connections open, speak, and are dropped and reopened. */
export function build(p: Plan): CaptureBuilder {
    const b = capture().connect()
    if (p.headers === 'html') b.response({ contentType: 'text/html' })
    else if (p.headers === 'status') b.response({ status: 503 })
    else b.response()
    let id = 0
    let open = p.headers === 'ok'
    for (const s of p.steps) {
        b.silence(s.dt)
        if (!open && s.op !== 'reconnect' && s.op !== 'discontinuity') continue
        switch (s.op) {
            case 'frame': b.frame('tick', String(++id)); break
            case 'beat': b.beat(); break
            case 'proxyBeat': b.beat('proxy'); break
            case 'chunk': b.chunk(7); break
            case 'event': b.event('tick', String(++id)); break
            case 'retry': b.retry(3000); break
            case 'violation': b.violation(id % 2 ? 'UNKNOWN_FIELD' : 'WRONG_CASE_FIELD'); break
            case 'discontinuity': b.discontinuity(s.dt); break
            case 'reconnect': b.reconnect({ lastEventIdSent: String(id) }).silence(500).connect({ sentLastEventId: String(id) }).response(); open = true; break
            case 'end': b.end(); open = false; break
        }
    }
    return b
}
