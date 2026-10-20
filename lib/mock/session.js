// Mock-server support: validated, per-session recordings and a replay loop that
// can never starve the event loop.

import { randomUUID } from 'node:crypto'
import { looksLikeCapture, sessionFromCapture } from './capturePlan.js'

const LIMITS = { maxEvents: 200_000, maxBytes: 20 * 1024 * 1024, maxDeltaMs: 3_600_000 }

/**
 * Validate and normalise an upload: an .sse-record v1 body (`{ events: [...] }`, unchanged), or an .sse-capture v2
 * (NDJSON text, or a JSON envelope holding one). Returns { session } or { error }.
 */
export function validateSession(body, limits = LIMITS) {
    if (looksLikeCapture(body)) return sessionFromCapture(body)
    if (!body || typeof body !== 'object' || !Array.isArray(body.events)) return { error: 'Body must be an object with an "events" array' }
    if (body.events.length > limits.maxEvents) return { error: `Too many events (max ${limits.maxEvents})` }
    let bytes = 0
    const events = []
    for (const [i, e] of body.events.entries()) {
        if (!e || typeof e !== 'object') return { error: `events[${i}] must be an object` }
        if (typeof e.data !== 'string') return { error: `events[${i}].data must be a string` }
        const deltaMs = e.deltaMs === undefined ? 0 : e.deltaMs
        if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs < 0 || deltaMs > limits.maxDeltaMs) {
            return { error: `events[${i}].deltaMs must be a number between 0 and ${limits.maxDeltaMs}` }
        }
        bytes += e.data.length
        if (bytes > limits.maxBytes) return { error: 'Recording is too large' }
        events.push({
            ...(e.id !== undefined && e.id !== null ? { id: String(e.id).replace(/[\r\n\0]/g, '') } : {}),
            ...(typeof e.type === 'string' ? { type: e.type } : {}),
            data: e.data,
            deltaMs,
        })
    }
    return { session: { events } }
}

// ---------- store (memory by default, Upstash/Vercel KV when configured) ----------

const memory = new Map()
const TTL_MS = 60 * 60 * 1000
const MAX_SESSIONS = 100

function prune(now = Date.now()) {
    for (const [id, s] of memory) if (s.expires <= now) memory.delete(id)
    while (memory.size >= MAX_SESSIONS) memory.delete(memory.keys().next().value)
}

export function createMockStore(env = process.env) {
    const useKv = Boolean(env.KV_REST_API_URL)
    const kv = async () => (await import('@vercel/kv')).kv
    return {
        async create(session) {
            const id = randomUUID()
            if (useKv) await (await kv()).set(`mock:${id}`, session, { ex: TTL_MS / 1000 })
            else { prune(); memory.set(id, { session, expires: Date.now() + TTL_MS }) }
            return id
        },
        async get(id) {
            if (!/^[0-9a-f-]{36}$/i.test(id || '')) return null
            if (useKv) return (await (await kv()).get(`mock:${id}`)) ?? null
            const s = memory.get(id)
            if (!s || s.expires <= Date.now()) return null
            return s.session
        },
        async delete(id) {
            if (useKv) await (await kv()).del(`mock:${id}`)
            else memory.delete(id)
        },
        /** Development convenience (single-tenant): most recently created session. */
        latestId() {
            let last = null
            for (const id of memory.keys()) last = id
            return last
        },
    }
}

// ---------- replay ----------

export function clampSpeed(raw) {
    const n = Number.parseFloat(raw)
    return Number.isFinite(n) && n > 0 ? Math.min(1000, Math.max(0.01, n)) : 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tick = () => new Promise((r) => setImmediate(r))

function frameFor(event) {
    let data = event.data
    try {
        const parsed = JSON.parse(data)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !parsed.type && event.type) {
            parsed.type = event.type
            data = JSON.stringify(parsed)
        }
    } catch { /* not JSON — send as-is */ }
    let out = event.id ? `id: ${event.id}\n` : ''
    for (const line of data.split(/\r\n|\r|\n/)) out += `data: ${line}\n`
    return out + '\n'
}

/** Streams a session to `res` honouring recorded timing. Resolves when done or the client left. */
export async function replay({ res, session, speed = 1, loop = false, isClosed }) {
    const writeFrame = async (frame) => {
        if (!res.write(frame)) {
            await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve) })
        }
    }
    let sent = 0
    do {
        const passStart = Date.now()
        for (const event of session.events) {
            if (isClosed()) return
            const delay = event.deltaMs / speed
            if (delay > 0) await sleep(delay)
            else if (++sent % 64 === 0) await tick() // never monopolise the event loop
            if (isClosed()) return
            await writeFrame(frameFor(event))
        }
        // A looping recording with no timing would otherwise spin; enforce a minimum pass time.
        const elapsed = Date.now() - passStart
        if (loop && elapsed < 50) await sleep(50 - elapsed)
    } while (loop && !isClosed())
    if (isClosed()) return
    // Tell the client the recording is over: a bare close looks like a dropped connection and it would replay forever.
    res.write('event: end\ndata: {"done":true}\n\n')
    res.end()
}

/**
 * Writes planned steps at their times and then ends the way asked: 'close' (a plain end, which a client sees as a dropped
 * connection and answers by reconnecting), 'hold' (stay open until the client leaves), 'rst' (destroy the socket), or
 * 'end-event' (the v1 behaviour: an `event: end` so a client stops). Resolves when done or the client left.
 */
export async function replayPlan({ res, steps, end = 'close', loop = false, isClosed }) {
    const writeFrame = async (frame) => {
        if (!res.write(frame)) await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve) })
    }
    do {
        const start = Date.now()
        let sent = 0
        for (const step of steps) {
            if (isClosed()) return
            const wait = step.atMs - (Date.now() - start)
            if (wait > 0) await sleep(wait)
            else if (++sent % 64 === 0) await tick()
            if (isClosed()) return
            await writeFrame(step.write)
        }
        const elapsed = Date.now() - start
        if (loop && elapsed < 50) await sleep(50 - elapsed)
    } while (loop && !isClosed())
    if (isClosed()) return
    if (end === 'hold') {
        await new Promise((resolve) => { res.once('close', resolve) })
        return
    }
    if (end === 'rst') { res.destroy(); return }
    if (end === 'end-event') res.write('event: end\ndata: {"done":true}\n\n')
    res.end()
}
