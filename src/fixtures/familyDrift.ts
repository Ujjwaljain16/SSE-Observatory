/**
 * F11: a producer changes its payload format part way through. `drift` sends `{id, price, qty}` for the first 20 events and then
 * `{id, qty, currency}` (the price is gone, a currency is new); `steady` keeps one shape throughout. The events carry the shape in
 * their JSON only: nothing else about the stream is wrong, so the only finding is the change of format (R16).
 */
import { frame, numericId, type FixtureFamily, type FixtureRoute, type Script } from './kit'

const EVENT_MS = 50
const CHANGE_AT = 20

const steady: Script = async (ctx) => {
    for (let i = ctx.from; i < ctx.n; i++) {
        if (!(await ctx.sleep(EVENT_MS))) return
        ctx.write(frame(numericId(i), 'order', JSON.stringify({ id: i + 1, price: 9.5, qty: 2 })))
    }
    ctx.write('event: end\ndata: done\n\n')
}

const drift: Script = async (ctx) => {
    for (let i = ctx.from; i < ctx.n; i++) {
        if (!(await ctx.sleep(EVENT_MS))) return
        const payload = i < CHANGE_AT ? { id: i + 1, price: 9.5, qty: 2 } : { id: i + 1, qty: 2, currency: 'EUR' }
        ctx.write(frame(numericId(i), 'order', JSON.stringify(payload)))
    }
    ctx.write('event: end\ndata: done\n\n')
}

const routes: FixtureRoute[] = [
    { id: 'f11-drift', family: 'F11', path: '/f11/drift', title: 'The payload format changes part way', description: 'The first 20 orders have id, price and qty; from the 21st the price is gone and a currency is new.', expectedFindings: ['schema.drift'], forbiddenFindings: ['stall.silent', 'proto'], healthyTwin: 'f11-steady', defaultN: 34 },
    { id: 'f11-steady', family: 'F11', path: '/f11/steady', title: 'Healthy: the payload format never changes', description: 'The same orders with one shape throughout.', expectedFindings: [], forbiddenFindings: ['*'], healthyTwin: null, defaultN: 34 },
]

export const driftFamily: FixtureFamily = { routes, scripts: { '/f11/drift': drift, '/f11/steady': steady } }
