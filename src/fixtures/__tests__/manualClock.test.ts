// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { frameLog } from '../groundTruth'
import { ManualClock } from '../manualClock'
import { startFixtureServer, type FixtureServer } from '../server'

// Plan A2: the stepped server clock. With `clock: 'manual'` (or ?clock=manual) the fixtures' ctx.sleep waits on a virtual clock that only
// server.advance(ms) moves, so a test decides when each frame is written. The claims, each with the way it can fail:
//   - nothing is written until the clock moves, and one advance writes exactly what falls due in it;
//   - sleeps come due in order, also across an advance that spans several of them, and across requests;
//   - the clock waits for an async script (gzip flushes on the thread pool) to write before it moves on;
//   - a client that leaves, or a server that closes, does not leave a sleeper behind or hang;
//   - the real clock, which every other test uses, is untouched.

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(condition: () => boolean, what: string, ceilingMs = 3000): Promise<void> {
    const start = Date.now()
    while (!condition()) {
        if (Date.now() - start > ceilingMs) throw new Error(`timed out waiting for ${what}`)
        await wait(2)
    }
}

/** A request read in the background: `text` is everything the client has been given so far. */
async function open(url: string) {
    const controller = new AbortController()
    const res = await fetch(url, { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const state = { text: '', ended: false }
    const pump = (async () => {
        try {
            for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                state.text += decoder.decode(value, { stream: true })
            }
        } catch { /* aborted */ } finally { state.ended = true }
    })()
    return { res, state, abort: () => controller.abort(), pump, ids: () => [...state.text.matchAll(/^id: (.*)$/gm)].map((m) => m[1]!) }
}

let server: FixtureServer
beforeAll(async () => { server = await startFixtureServer({ port: 0, clock: 'manual' }) })
afterAll(async () => { await server.close() })

describe('a server on the stepped clock', () => {
    it('h01 n=3 delivers nothing until advance(1000), then one frame per advance, then the end event and the end of the stream', async () => {
        const c = await open(server.urlFor('h01', { n: 3 }))
        await wait(60)
        expect(c.state.text, 'the headers have come, no body').toBe('')
        expect(server.groundTruth.of('h01').at(-1)!.writes).toHaveLength(0)
        expect(server.clock.pending).toBe(1)

        await server.advance(999)
        await wait(40)
        expect(c.state.text, '999 ms is not yet a second').toBe('')

        await server.advance(1)
        await until(() => c.ids().length === 1, 'the first frame')
        expect(c.ids()).toEqual(['1'])
        await wait(40)
        expect(c.ids(), 'and no more than one').toEqual(['1'])

        await server.advance(1000)
        await until(() => c.ids().length === 2, 'the second frame')
        await server.advance(1000)
        await until(() => c.ids().length === 3, 'the third frame')
        // the stream's own end event follows the last frame at once, in a write of its own, and the server closes
        await until(() => c.state.ended, 'the end of the stream')
        expect(c.state.text.endsWith('event: end\ndata: done\n\n')).toBe(true)

        // the server's own log agrees: one write per frame, and the three advances made three of them (and the end)
        const log = server.groundTruth.of('h01').at(-1)!
        expect(log.writes).toHaveLength(4)
        expect(frameLog(log).filter((f) => f.id !== null).map((f) => f.id)).toEqual(['1', '2', '3'])
        expect(server.clock.pending).toBe(0)
    })

    it('an advance that spans several sleeps releases them all, in order (a sleep a script registers inside the window comes due inside it too)', async () => {
        const c = await open(server.urlFor('h01', { n: 5 }))
        await server.advance(3000)
        await until(() => c.ids().length === 3, 'three frames from one advance')
        expect(c.ids()).toEqual(['1', '2', '3'])
        await server.advance(2000)
        await until(() => c.state.ended, 'the end')
        expect(c.ids()).toEqual(['1', '2', '3', '4', '5'])
    })

    it('sleeps come due in the order of their times: h02 sends an event, a heartbeat at 15 s and the next event at 20 s, in that order from one advance', async () => {
        const c = await open(server.urlFor('h02', { n: 2 }))
        await server.advance(0) // a sleep of nothing is due now
        await until(() => c.ids().length === 1, 'the first event')
        await server.advance(20_000)
        await until(() => c.ids().length === 2, 'the second event')
        const log = server.groundTruth.of('h02').at(-1)!
        // in the order of the times (the heartbeat is at 15 s, the event at 20 s), and then the end event, which has no sleep before it
        expect(log.writes.map((w) => w.text.trim().split('\n')[0])).toEqual(['id: 1', ': keep-alive', 'id: 2', 'event: end'])
        await until(() => c.state.ended, 'the end')
    })

    it('requests in flight at the same time share the clock: both are released by one advance, in the order they asked', async () => {
        const first = await open(server.urlFor('h01', { n: 1 }))
        const second = await open(server.urlFor('h01', { n: 1 }))
        await server.advance(1000)
        await until(() => first.ids().length === 1 && second.ids().length === 1, 'a frame on each')
        const [a, b] = server.groundTruth.of('h01').slice(-2)
        expect(a!.writes[0]!.atMs, 'the first request is released first').toBeLessThanOrEqual(b!.writes[0]!.atMs)
        await server.advance(1)
        await until(() => first.state.ended && second.state.ended, 'both ended')
    })

    it('?scale applies to the virtual time as it does to the real: at scale 0.5 a second is 500 virtual ms', async () => {
        const c = await open(server.urlFor('h01', { n: 1, scale: 0.5 }))
        await server.advance(499)
        await wait(40)
        expect(c.ids()).toEqual([])
        await server.advance(1)
        await until(() => c.ids().length === 1, 'the frame at 500 ms')
        await server.advance(500)
        await until(() => c.state.ended, 'the end')
    })

    it('waits for a script that finishes its write on the thread pool: f12 (gzip, a flush per event) gives exactly one event per advance', async () => {
        const c = await open(server.urlFor('f12-gzip-sync', { n: 3 }))
        await server.advance(1000)
        // advance has returned: the compressed bytes for the event are already written, not still being compressed
        const log = server.groundTruth.of('f12-gzip-sync').at(-1)!
        expect(log.writes.length, 'the event was written before advance returned').toBeGreaterThan(0)
        await until(() => c.ids().length === 1, 'the first event, decoded')
        await wait(40)
        expect(c.ids()).toEqual(['1'])
        await server.advance(1000)
        await until(() => c.ids().length === 2, 'the second event')
        await server.advance(2000)
        await until(() => c.state.ended, 'the end')
        expect(c.ids()).toEqual(['1', '2', '3'])
    })

    it('a client that leaves takes its sleeper with it: nothing stays pending, and the clock still moves', async () => {
        const c = await open(server.urlFor('h01', { n: 5 }))
        await server.advance(1000)
        await until(() => c.ids().length === 1, 'a first frame')
        expect(server.clock.pending).toBe(1)
        c.abort()
        await until(() => server.groundTruth.of('h01').at(-1)!.endedBy === 'client-closed', 'the server to notice')
        await until(() => server.clock.pending === 0, 'the sleeper to go')
        await server.advance(10_000)
        expect(server.groundTruth.of('h01').at(-1)!.writes, 'nothing is written to a connection that is gone').toHaveLength(1)
    })

    it('advance refuses a time that is not a number of at least 0', async () => {
        for (const bad of [-1, NaN, Infinity]) await expect(server.advance(bad), String(bad)).rejects.toThrow(/at least 0/)
    })
})

describe('closing, and choosing the clock per request', () => {
    it('a server with scripts asleep on the virtual clock still closes', async () => {
        const own = await startFixtureServer({ port: 0, clock: 'manual' })
        const c = await open(own.urlFor('h01', { n: 5 }))
        expect(own.clock.pending).toBe(1)
        const closed = await Promise.race([own.close().then(() => 'closed'), wait(3000).then(() => 'hung')])
        expect(closed).toBe('closed')
        await c.pump
        await until(() => own.clock.pending === 0, 'the sleeper of the closed request to go')
    })

    it('?clock=real on the stepped server runs by itself in real time; ?clock=manual on a real-time server waits for advance', async () => {
        const real = await open(server.urlFor('h01', { n: 1, scale: 0.01, clock: 'real' }))
        await until(() => real.state.ended, 'a real-time stream to finish without advance')
        expect(real.ids()).toEqual(['1'])

        const own = await startFixtureServer({ port: 0 })
        try {
            const stepped = await open(own.urlFor('h01', { n: 1, clock: 'manual' }))
            const free = await open(own.urlFor('h01', { n: 1, scale: 0.01 }))
            await until(() => free.state.ended, 'the real-time request to finish')
            expect(stepped.ids(), 'the stepped one has not moved').toEqual([])
            expect(own.clock.pending).toBe(1)
            await own.advance(1000)
            await until(() => stepped.ids().length === 1, 'the stepped frame')
        } finally { await own.close() }
    })

    it('the default is the real clock and the virtual one is never touched: a server without the option registers no sleeper', async () => {
        const own = await startFixtureServer({ port: 0 })
        try {
            const c = await open(own.urlFor('h01', { n: 2, scale: 0.01 }))
            await until(() => c.state.ended, 'the stream to end on its own')
            expect(c.ids()).toEqual(['1', '2'])
            expect(own.clock.pending).toBe(0)
            expect(own.clock.now).toBe(0)
        } finally { await own.close() }
    })
})


describe('ManualClock on its own', () => {
    it('releases the earliest sleeper first, equal times in the order they were registered, and a sleep a woken script registers inside the window comes due inside it', async () => {
        const clock = new ManualClock()
        const order: string[] = []
        const a = clock.session()
        const b = clock.session()
        const c = clock.session()
        void a.sleep(300).then(() => { order.push('a'); return a.sleep(0).then(() => { order.push('a again'); a.end() }) })
        void b.sleep(100).then(() => { order.push('b'); b.end() })
        void c.sleep(300).then(() => { order.push('c'); c.end() })
        await clock.advance(299)
        expect(order).toEqual(['b'])
        await clock.advance(1)
        // a and c are both due at 300 (a asked first); a's next sleep is registered after c's, so it comes last
        expect(order).toEqual(['b', 'a', 'c', 'a again'])
        expect(clock.now).toBe(300)
        expect(clock.pending).toBe(0)
    })

    it('does not move past a script that is still running: it waits, and throws at its ceiling instead of hanging for ever', async () => {
        const clock = new ManualClock(60)
        clock.session() // a script that never sleeps and never ends
        await expect(clock.advance(1)).rejects.toThrow(/still running 60 ms after the clock moved/)
    })

    it('a session that ends releases its sleeps as "gone" (false) and is no longer waited for', async () => {
        const clock = new ManualClock(60)
        const s = clock.session()
        const slept = s.sleep(1000)
        s.end()
        await expect(slept).resolves.toBe(false)
        await expect(clock.advance(5000)).resolves.toBeUndefined()
        await expect(s.sleep(1)).resolves.toBe(false)
    })
})
