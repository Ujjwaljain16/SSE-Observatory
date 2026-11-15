/**
 * F09: the same stream behind two paths. `healthy` flushes every event as it is produced; `buffered` behaves like a
 * buffering layer that releases data in 4096-byte blocks. Neither is wrong on its own; the difference only shows when
 * two captures are compared, which is what compareCaptures is for.
 */
import { frame, numericId, type FixtureFamily, type FixtureRoute, type Script } from './kit'

const EVENT_MS = 300
const BLOCK = 4096
/** About a quarter of a block per event, so a block holds four events. */
const payload = (i: number) => JSON.stringify({ n: i + 1, pad: 'x'.repeat(1000) })

const healthy: Script = async (ctx) => {
    for (let i = ctx.from; i < ctx.n; i++) {
        if (!(await ctx.sleep(EVENT_MS))) return
        ctx.write(frame(numericId(i), 'tick', payload(i)))
    }
    ctx.write('event: end\ndata: done\n\n')
}

const buffered: Script = async (ctx) => {
    let held = ''
    for (let i = ctx.from; i < ctx.n; i++) {
        if (!(await ctx.sleep(EVENT_MS))) return
        held += frame(numericId(i), 'tick', payload(i))
        while (held.length >= BLOCK) {
            ctx.write(held.slice(0, BLOCK))
            held = held.slice(BLOCK)
        }
    }
    ctx.write(held + 'event: end\ndata: done\n\n')
}

const routes: FixtureRoute[] = [
    { id: 'f09-buffered', family: 'F09', path: '/f09/buffered', title: 'Same stream through a buffering layer', description: 'Events are produced every 300 ms but delivered in 4096-byte blocks. Compare with f09-healthy.', expectedFindings: [], forbiddenFindings: ['stall.silent'], healthyTwin: null, defaultN: 12 },
    { id: 'f09-healthy', family: 'F09', path: '/f09/healthy', title: 'Healthy: same stream, flushed per event', description: 'The same events, each delivered as it is produced.', expectedFindings: [], forbiddenFindings: ['*'], healthyTwin: null, defaultN: 12 },
]

export const compareFamily: FixtureFamily = { routes, scripts: { '/f09/buffered': buffered, '/f09/healthy': healthy } }
