import { afterEach, describe, expect, it, vi } from 'vitest'
import { DoctorStore } from '../doctorStore'
import { ObservationRegistry } from '../observationRegistry'
import { capture, healthyStart } from '../../core/testing/captureBuilder'
import { analyze } from '../../core/diagnostics/engine'
import type { Observation } from '../../core/observe/observation'
import type { DoctorView } from '../doctorSession'

// A page whose clock the test moves by hand, and a registry it feeds as the worker would.
function setup(options: { hidden?: () => boolean } = {}) {
    const registry = new ObservationRegistry()
    let nowMs = 0
    const loadEngine = vi.fn(() => import('../doctorSession'))
    const store = new DoctorStore({ registry, now: () => nowMs, isHidden: options.hidden ?? (() => false), loadEngine })
    const stop = store.subscribe(() => {})
    const feed = (b: ReturnType<typeof capture>, captureId = 'c1') => registry.receive('main', { captureId, batch: b.observations() })
    return {
        registry, store, loadEngine, feed,
        advance: (ms: number) => { nowMs += ms },
        view: (): DoctorView | undefined => store.getViews().get('main'),
        stop,
    }
}

const steady = (seconds: number) => healthyStart().repeat(seconds, 1000, (b) => b.frame('tick'))
let teardown: Array<() => void> = []
afterEach(() => { teardown.forEach((f) => f()); teardown = []; vi.useRealTimers() })
const start = (options?: Parameters<typeof setup>[0]) => { const h = setup(options); teardown.push(h.stop); return h }

describe('the Doctor store', () => {
    it('loads nothing until a stream has records', async () => {
        const h = start()
        await h.store.refresh()
        expect(h.loadEngine).not.toHaveBeenCalled()
        expect(h.store.getViews().size).toBe(0)
    })

    it('diagnoses a stream from the records the registry holds', async () => {
        const h = start()
        h.feed(steady(12))
        await h.store.refresh()
        const v = h.view()!
        expect(v.health.events).toBe(12)
        expect(v.health.phase).toBe('open')
        expect(v.open.error + v.open.critical).toBe(0)
        expect(v.evaluated).toBeGreaterThan(0)
        // Checks that need records this stream never produced are listed as not evaluated, not as passing.
        expect(v.coverage.find((c) => c.ruleId === 'consumer.slow')?.status).toBe('not-evaluated')
    })

    it('feeds each record once however often it syncs', async () => {
        const h = start()
        h.feed(steady(5))
        await h.store.refresh()
        await h.store.refresh()
        await h.store.refresh()
        expect(h.view()!.health.events).toBe(5)
    })

    it('raises a stall finding as the silence goes on, without any new record', async () => {
        const h = start()
        h.feed(steady(15))
        await h.store.refresh()
        expect(h.view()!.findings.some((f) => f.ruleId.startsWith('stall'))).toBe(false)
        h.advance(60_000)
        await h.store.refresh()
        const stall = h.view()!.findings.find((f) => f.ruleId.startsWith('stall'))
        expect(stall?.status).toBe('open')
        expect(['warning', 'error']).toContain(stall?.severity)
    })

    it('a stream that resumes clears the provisional stall', async () => {
        const h = start()
        h.feed(steady(15))
        await h.store.refresh()
        h.advance(60_000)
        await h.store.refresh()
        expect(h.view()!.worst).not.toBeNull()
        const more = capture().connect().response().repeat(15, 1000, (b) => b.frame('tick')).silence(60_000).frame('tick')
        h.feed(more, 'c1')
        await h.store.refresh()
        // The records are the same capture continuing; what matters is that time keeps being measured from the newest record.
        expect(h.view()!.health.lastEventAgeMs).toBeLessThan(5000)
    })

    it('a time away in a hidden tab is not read as a stall', async () => {
        let hidden = false
        const h = start({ hidden: () => hidden })
        h.feed(steady(15))
        await h.store.refresh()
        hidden = true
        document.dispatchEvent(new Event('visibilitychange'))
        h.advance(10 * 60_000)
        hidden = false
        document.dispatchEvent(new Event('visibilitychange'))
        await h.store.refresh()
        expect(h.view()!.findings.some((f) => f.ruleId.startsWith('stall') && f.status === 'open')).toBe(false)
        expect(h.view()!.findings.some((f) => f.ruleId === 'clock.discontinuity')).toBe(true)
    })

    it('a new capture id starts the diagnosis over', async () => {
        const h = start()
        h.feed(capture().connect().response({ status: 500 }), 'old')
        await h.store.refresh()
        expect(h.view()!.worst).toBe('error')
        h.feed(steady(4), 'new')
        await h.store.refresh()
        expect(h.view()!.findings.some((f) => f.key.includes('status'))).toBe(false)
        expect(h.view()!.captureId).toBe('new')
    })

    it('forgets a stream the registry no longer holds', async () => {
        const h = start()
        h.feed(steady(3))
        await h.store.refresh()
        h.registry.close('main')
        await h.store.refresh()
        expect(h.store.getViews().size).toBe(0)
    })

    it('reports a slow page from consumer samples, in the page clock', async () => {
        const h = start()
        h.feed(steady(30))
        for (let i = 0; i < 40; i++) h.registry.recordConsumer('main', { kind: 'consumer', n: 1, queueDepth: i, receivedT: i, processedT: i + 900, lagMs: 900 })
        await h.store.refresh()
        const v = h.view()!
        expect(v.health.consumer?.samples).toBe(40)
        expect(v.health.consumer?.p95LagMs).toBe(900)
        expect(v.findings.some((f) => f.key === 'consumer.slow')).toBe(true)
        expect(v.coverage.find((c) => c.ruleId === 'consumer.slow')?.status).toBe('evaluated')
    })

    it('schedules nothing once the last subscriber has left', async () => {
        vi.useFakeTimers()
        const h = setup()
        h.feed(steady(3))
        expect(vi.getTimerCount()).toBeGreaterThan(0) // a sync and the one-second tick while someone listens
        h.stop()
        expect(vi.getTimerCount()).toBe(0)
        h.feed(steady(3), 'again')
        expect(vi.getTimerCount()).toBe(0)
    })
})

describe('observation records the store ignores', () => {
    it('passes unknown record kinds through the engine without failing', async () => {
        const h = start()
        const weird = { seq: 999, t: 5000, conn: 0, kind: 'future-kind' } as unknown as Observation
        h.registry.receive('main', { captureId: 'c', batch: [...steady(3).observations(), weird] })
        await h.store.refresh()
        expect(h.view()).toBeDefined()
    })
})

// Results Q12 (decided): the live view gives what the batch analysis gives. A stall that ended with the connection closing is open until a later
// connection delivers an event; then it is history (kept, resolved), and the open counts and the health strip stop counting it.
describe('a stall that a later connection recovered from', () => {
    it('is counted as open until the new connection delivers, then kept as resolved and no longer counted, and the view equals a batch analysis', async () => {
        const h = start()
        const b = steady(12).silence(8000).reconnect({ delayMs: 500 }).silence(500).connect({ sentLastEventId: '12' }).response()
        h.feed(b)
        await h.store.refresh()
        const waiting = h.view()!
        expect(waiting.findings.find((f) => f.key === 'stall.silent:bytes')).toMatchObject({ status: 'open', occurrences: 1 })
        expect(waiting.open.warning + waiting.open.error, 'the stall is counted while nothing has been delivered').toBeGreaterThan(0)
        expect(waiting.worst).not.toBeNull()

        b.silence(100).frame('tick', '13')
        h.advance(1000)
        h.feed(b)
        await h.store.refresh()
        const recovered = h.view()!
        expect(recovered.findings.find((f) => f.key === 'stall.silent:bytes')).toMatchObject({ status: 'resolved', occurrences: 1 })
        expect(recovered.open.warning + recovered.open.error + recovered.open.critical, 'a recovered stream is not counted').toBe(0)
        expect(recovered.worst).toBeNull()
        expect(recovered.findings.filter((f) => f.status === 'open')).toEqual([])
        // The live view and the batch analysis of the same records agree on the stall, to the last field.
        const batch = analyze(b.build(), { endT: b.now + 1000 }).findings.find((f) => f.key === 'stall.silent:bytes')
        expect(recovered.findings.find((f) => f.key === 'stall.silent:bytes')).toEqual(batch)
    })
})

// Found by the browser tests (campaign G1): while records keep arriving, an open silence dropped out of the live view. Feeding a record clears the
// engine's provisional findings (the ones that are only true "so far"), and the tick that puts them back ran only once a second, while the store
// synced and published every 250 ms. With a heartbeat every 250 ms, most views had no stall finding in them and the finding flickered.
describe('an open silence stays in the view while records keep arriving', () => {
    it('shows the "heartbeats but no events" stall in every view once it has begun, not only in the views a tick made', async () => {
        vi.useFakeTimers()
        const h = start()
        const b = steady(12) // twelve events a second apart: the stream's own rhythm
        h.feed(b)
        await h.store.refresh()
        const missing: string[] = []
        let ticks = 0
        for (let step = 1; step <= 48; step++) {
            b.silence(250).beat() // from now on only heartbeats
            h.advance(250)
            h.feed(b)
            await vi.advanceTimersByTimeAsync(250) // the store syncs (and, every fourth step, ticks)
            if (step * 250 >= 6000) {
                const keys = h.view()!.findings.filter((f) => f.status === 'open').map((f) => f.key)
                if (!keys.includes('stall.silent:events')) missing.push(`after ${step * 250} ms of heartbeats the view held: ${keys.join(', ') || 'no open finding'}`)
                if (step % 4 === 0) ticks++
            }
        }
        expect(ticks, 'the run included the views a tick made, and the others').toBeGreaterThan(3)
        expect(missing).toEqual([])
    })
})
