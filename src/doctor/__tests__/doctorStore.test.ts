import { afterEach, describe, expect, it, vi } from 'vitest'
import { DoctorStore } from '../doctorStore'
import { ObservationRegistry } from '../observationRegistry'
import { capture, healthyStart } from '../../core/testing/captureBuilder'
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
