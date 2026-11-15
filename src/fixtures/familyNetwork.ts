/**
 * Network-shaped faults: delivery in lumps (F03), connections that drop (F05) and a stream for a slow consumer (F10).
 *
 * F03  `/f03/buffered`  events are produced steadily but written to the socket in lumps (12 events 250 ms apart, flushed
 *                       together every 3 s); `/f03/steady` is the twin that flushes each event as it is produced.
 *      Both carry a producer timestamp (`ts`), so a stream profile with `timestampField: '$.ts'` can tell batching at
 *      the source from buffering.
 * F05  `/f05/drops`     the server ends the connection after `?per=` events (default 3). A reconnect resumes after
 *                       Last-Event-ID, unless `?ignore=1`, which ignores it and restarts from 1. Lifetimes differ from
 *                       one connection to the next. `/f05/cap` drops every connection after the same duration (`?cap=`
 *                       ms, default 3500) while events and heartbeats flow. `/f05/resumes` is the twin: one drop after
 *                       half of the events, a correct resume, and nothing else.
 * F10  `/f10/steady`    100 events a second. The stream is healthy; the fault is in the consumer, so tests feed it to a
 *                       deliberately slow one. The twin is the same stream consumed promptly.
 */
import { FINDINGS_NEVER_ON_HEALTHY, frame, numericId, type Ctx, type FixtureFamily, type FixtureRoute, type Script } from './kit'

const routes: FixtureRoute[] = [
    { id: 'f03-buffered', family: 'F03', path: '/f03/buffered', title: 'Events written in lumps', description: 'Events are produced every 250 ms but written to the socket 12 at a time, every 3 s: what a buffer in front of the app does.', expectedFindings: ['delivery.bursty'], forbiddenFindings: ['stall.silent'], healthyTwin: 'f03-steady', defaultN: 60 },
    { id: 'f03-steady', family: 'F03', path: '/f03/steady', title: 'Healthy: events flushed as produced', description: 'The same events, one every 250 ms, each written when produced.', expectedFindings: [], forbiddenFindings: FINDINGS_NEVER_ON_HEALTHY, healthyTwin: null, defaultN: 60 },
    { id: 'f05-drops', family: 'F05', path: '/f05/drops', title: 'The server ends the connection every few events', description: 'Ends the connection after ?per= events (default 3); the client resumes with Last-Event-ID. ?ignore=1 ignores it and restarts from 1.', expectedFindings: ['reconnect.loop'], forbiddenFindings: ['reconnect.duration-pattern', 'stall.silent'], healthyTwin: 'f05-resumes', defaultN: 12 },
    { id: 'f05-cap', family: 'F05', path: '/f05/cap', title: 'Every connection is cut after the same duration', description: 'Events and heartbeats flow, then the connection is dropped after ?cap= ms (default 3500), every time.', expectedFindings: ['reconnect.duration-pattern', 'reconnect.loop'], forbiddenFindings: ['stall.silent'], healthyTwin: 'f05-resumes', defaultN: 12 },
    { id: 'f05-resumes', family: 'F05', path: '/f05/resumes', title: 'Healthy: one drop, a correct resume', description: 'The connection is dropped once, half way; the client resumes after Last-Event-ID and the rest arrives.', expectedFindings: [], forbiddenFindings: FINDINGS_NEVER_ON_HEALTHY, healthyTwin: null, defaultN: 6 },
    { id: 'f10-steady', family: 'F10', path: '/f10/steady', title: 'A fast, healthy stream for a slow consumer', description: '100 events a second. Nothing is wrong on the wire: the fault is a consumer that cannot keep up, which a test supplies.', expectedFindings: ['consumer.slow'], forbiddenFindings: ['stall.silent', 'delivery.bursty'], healthyTwin: 'h01', defaultN: 100 },
]

/** Starts a stopwatch: `elapsed()` is the time since the call in the stream's own (unscaled) milliseconds. */
const stopwatch = (ctx: Ctx) => { const t0 = Date.now(); return { t0, elapsed: () => (Date.now() - t0) / ctx.scale } }

const tick = (i: number, ts: number) => frame(numericId(i), 'tick', JSON.stringify({ n: i + 1, ts: Math.round(ts) }))

/** Closes the connection after `per` events; sends the end event once the last event of the stream has gone out. */
function dropsAfter(perOf: (ctx: Ctx) => number): Script {
    return async (ctx) => {
        const from = ctx.query.get('ignore') !== '1' ? ctx.from : 0
        const per = perOf(ctx)
        // Later connections run slower, so lifetimes differ from one to the next.
        const interval = 600 + 200 * (Math.floor(from / Math.max(1, per)) % 4)
        let i = from
        for (let sent = 0; sent < per && i < ctx.n; sent++, i++) {
            if (!(await ctx.sleep(interval))) return
            ctx.write(frame(numericId(i), 'tick', JSON.stringify({ n: i + 1 })))
        }
        if (i >= ctx.n) ctx.write('event: end\ndata: done\n\n')
    }
}

const scripts: Record<string, Script> = {
    '/f03/buffered': async (ctx) => {
        const lump = 12
        const spacing = 250
        const { t0, elapsed } = stopwatch(ctx)
        let i = ctx.from
        // events are produced one every 250 ms; nothing is written until the whole lump is ready, at an absolute moment so the lumps keep an even period
        for (let j = 1; i < ctx.n; j++) {
            if (!(await ctx.sleep(Math.max(0, j * lump * spacing - elapsed())))) return
            const batch: string[] = []
            for (let k = 0; k < lump && i < ctx.n; k++, i++) batch.push(tick(i, t0 + (i - ctx.from + 1) * spacing * ctx.scale))
            ctx.write(batch.join(''))
        }
        ctx.write('event: end\ndata: done\n\n')
    },
    '/f03/steady': async (ctx) => {
        const t0 = Date.now()
        for (let i = ctx.from; i < ctx.n; i++) {
            if (!(await ctx.sleep(250))) return
            ctx.write(tick(i, t0 + (i - ctx.from + 1) * 250 * ctx.scale))
        }
        ctx.write('event: end\ndata: done\n\n')
    },

    '/f05/drops': dropsAfter((ctx) => Math.max(1, Number(ctx.query.get('per') ?? 3) || 3)),
    '/f05/resumes': dropsAfter((ctx) => Math.max(1, Math.ceil(ctx.n / 2))),

    '/f05/cap': async (ctx) => {
        const cap = Number(ctx.query.get('cap') ?? 3500) || 3500
        const { elapsed } = stopwatch(ctx)
        let i = ctx.from
        // a heartbeat every 500 ms, an event every second, and the drop at an absolute moment so timer drift does not add up
        for (let at = 500; at < cap; at += 500) {
            if (!(await ctx.sleep(Math.max(0, at - elapsed())))) return
            if (at % 1000 === 0) ctx.write(frame(numericId(i), 'tick', JSON.stringify({ n: ++i })))
            else ctx.write(': keep-alive\n\n')
        }
        await ctx.sleep(Math.max(0, cap - elapsed()))
    },

    '/f10/steady': async (ctx) => {
        for (let i = ctx.from; i < ctx.n; i++) {
            if (!(await ctx.sleep(10))) return
            ctx.write(frame(numericId(i), 'tick', JSON.stringify({ n: i + 1 })))
        }
        ctx.write('event: end\ndata: done\n\n')
    },
}

export const networkFamily: FixtureFamily = { routes, scripts }
