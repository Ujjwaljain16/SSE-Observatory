// Request handlers for /api/mock/* shared by Express (server.js) and Vercel functions.

import { isTrustedBrowserRequest, loadConfig } from '../proxy/guard.js'
import { clampSpeed, createMockStore, replay, replayPlan, validateSession } from './session.js'
import { END_BEHAVIOURS, planReplay } from './capturePlan.js'
import { checkBudget, checkRate, clientIp, loadLimits } from './limits.js'

const store = createMockStore()
// How many times each capture session has been requested, so the second request serves the second recorded connection.
const requests = new Map()

function json(res, status, body, headers = {}) {
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
    res.end(JSON.stringify(body))
}

const MAX_NDJSON_BYTES = 20 * 1024 * 1024

let openStreams = 0

/**
 * Takes a place among the open mock streams, and ends the stream when its time is up. Returns false when the server is full.
 * Without this a client could open streams that never end (loop=true, end=hold) faster than the rate limit counts them.
 */
function takeStreamSlot(res, limits) {
    if (limits.maxOpenStreams && openStreams >= limits.maxOpenStreams) return false
    openStreams++
    const timer = limits.maxStreamSeconds ? setTimeout(() => { if (!res.writableEnded) res.end() }, limits.maxStreamSeconds * 1000) : undefined
    timer?.unref?.()
    res.once('close', () => { openStreams--; if (timer) clearTimeout(timer) })
    return true
}

/**
 * The request body. Express has already parsed it (JSON, or NDJSON text). On a host that hands the function a body only for
 * the content types it knows (Vercel does this for JSON, text and form posts), an NDJSON upload arrives with nothing parsed,
 * so it is read from the request here, with the same size cap.
 * @returns {Promise<{ body: unknown, tooLarge?: boolean }>}
 */
async function bodyOf(req, opts, type) {
    const given = opts.body ?? req.body
    const empty = given === undefined || given === null || (typeof given === 'object' && !Buffer.isBuffer(given) && Object.keys(given).length === 0)
    if (!empty || !type.includes('application/x-ndjson') || req.readableEnded || typeof req.on !== 'function') return { body: given }
    const chunks = []
    let size = 0
    for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_NDJSON_BYTES) return { body: undefined, tooLarge: true }
        chunks.push(chunk)
    }
    return { body: Buffer.concat(chunks).toString('utf8') }
}

function tooMany(res, verdict) {
    return json(res, 429, { error: verdict.reason, retryAfterSeconds: verdict.retryAfterSec }, { 'Retry-After': String(verdict.retryAfterSec) })
}

function disabled(res) {
    return json(res, 404, { error: 'Mock API is disabled on this deployment (set ENABLE_MOCK_API=1 to enable)' })
}

/** POST /api/mock/session  → { sessionId, events }      DELETE /api/mock/session?id=… */
export async function handleMockSession(req, res, opts = {}) {
    const cfg = opts.config ?? loadConfig(opts.env ?? process.env)
    if (!cfg.mockEnabled) return disabled(res)
    if (!isTrustedBrowserRequest(req, cfg)) return json(res, 403, { error: 'Forbidden origin' })

    // On Vercel the upload and the stream are separate functions with separate memory: a session kept in memory is never found
    // again (the stream answers 404). Refusing the upload says so, instead of accepting something that cannot be replayed.
    if ((opts.env ?? process.env).VERCEL && !store.persistent) {
        return json(res, 503, { error: 'On Vercel the mock API needs a KV store (KV_REST_API_URL): sessions kept in memory cannot be found by the stream function.' })
    }

    const env = opts.env ?? process.env
    const limits = opts.limits ?? loadLimits(env)
    const rate = await checkRate({ store, limits, kind: 'upload', ip: opts.ip ?? clientIp(req, env) })
    if (!rate.ok) return tooMany(res, rate)

    if (req.method === 'DELETE') {
        const id = new URL(req.url, 'http://localhost').searchParams.get('id')
        if (id) await store.delete(id)
        return json(res, 200, { success: true })
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' }, { Allow: 'POST, DELETE' })
    const type = String(req.headers['content-type'] || '')
    if (!type.includes('application/json') && !type.includes('application/x-ndjson')) {
        return json(res, 415, { error: 'Content-Type must be application/json or application/x-ndjson' })
    }

    const { body, tooLarge } = await bodyOf(req, opts, type)
    if (tooLarge) return json(res, 413, { error: 'Request body too large (NDJSON up to 20 MB)' })
    const { session, error } = validateSession(body)
    if (error) return json(res, 400, { error })
    // The size that is stored, not the Content-Length: a gzip body inflates to many times its header, and counting the header let a
    // compressed upload bypass the hourly budget.
    const budget = await checkBudget({ store, limits, bytes: JSON.stringify(session).length })
    if (!budget.ok) return tooMany(res, budget)
    try {
        const sessionId = await store.create(session)
        const events = session.kind === 'capture' ? session.events.length || session.chunks.length : session.events.length
        return json(res, 200, { success: true, sessionId, events, ...(session.kind === 'capture' ? { kind: 'capture', fidelity: session.chunks.length > 0 ? 'chunks' : 'events' } : {}) })
    } catch (err) {
        console.error('[mock] failed to store session:', err?.message)
        return json(res, 503, { error: 'Mock storage unavailable' })
    }
}

/**
 * GET /api/mock/stream?session=<id>&speed=1&loop=false  (the session id is the capability)
 * For a capture session also: connection=<n>, honorLastEventId=1 (resume after the Last-Event-ID header), unknownId=from-start|400|ignore,
 * end=close|hold|rst|end-event, skipIds=a,b and dropAfter=<n> (test aids).
 */
export async function handleMockStream(req, res, opts = {}) {
    const cfg = opts.config ?? loadConfig(opts.env ?? process.env)
    if (!cfg.mockEnabled) return disabled(res)
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' })
    const env = opts.env ?? process.env
    const rate = await checkRate({ store, limits: opts.limits ?? loadLimits(env), kind: 'stream', ip: opts.ip ?? clientIp(req, env) })
    if (!rate.ok) return tooMany(res, rate)

    const params = new URL(req.url, 'http://localhost').searchParams
    const streamLimits = opts.limits ?? loadLimits(env)
    // Development convenience: without an id, fall back to the most recent in-memory session.
    const id = params.get('session') || (!cfg.production ? store.latestId() : null)
    const session = id ? await store.get(id) : null
    if (!session) return json(res, 404, { error: 'No mock session found. Upload a recording first.' })

    if (!takeStreamSlot(res, streamLimits)) return json(res, 429, { error: 'Too many mock streams are open. Close one or try again in a moment.', retryAfterSeconds: 5 }, { 'Retry-After': '5' })
    if (session.kind === 'capture') return streamCapture({ req, res, session, id, params })

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*', // unguessable session id acts as the capability
    })
    let closed = false
    res.on('close', () => { closed = true })
    try {
        await replay({ res, session, speed: clampSpeed(params.get('speed')), loop: params.get('loop') === 'true', isClosed: () => closed })
    } catch (err) {
        console.error('[mock] replay failed:', err?.message)
        if (!res.writableEnded) res.end()
    }
}

async function streamCapture({ req, res, session, id, params }) {
    const count = requests.get(id) ?? 0
    requests.set(id, count + 1)
    if (requests.size > 200) requests.delete(requests.keys().next().value)
    const end = params.get('end') ?? 'close'
    if (!END_BEHAVIOURS.includes(end)) return json(res, 400, { error: `end must be one of ${END_BEHAVIOURS.join(', ')}` })
    const unknownId = params.get('unknownId') ?? 'from-start'
    if (!['from-start', '400', 'ignore'].includes(unknownId)) return json(res, 400, { error: 'unknownId must be from-start, 400 or ignore' })
    const dropAfter = params.get('dropAfter') === null ? undefined : Number.parseInt(params.get('dropAfter'), 10)
    const connection = params.get('connection') === null ? count : Number.parseInt(params.get('connection'), 10)
    const plan = planReplay(session, {
        connection: Number.isInteger(connection) && connection >= 0 ? connection : count,
        speed: clampSpeed(params.get('speed')),
        honorLastEventId: params.get('honorLastEventId') === '1' || params.get('honorLastEventId') === 'true',
        lastEventId: String(req.headers['last-event-id'] ?? ''),
        unknownId,
        skipIds: (params.get('skipIds') ?? '').split(',').filter(Boolean).slice(0, 1000),
        ...(Number.isInteger(dropAfter) && dropAfter >= 0 ? { dropAfter } : {}),
    })
    if (plan.error) return json(res, plan.error.status, { error: plan.error.message })

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Mock-Fidelity': plan.mode,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-Mock-Fidelity',
    })
    let closed = false
    res.on('close', () => { closed = true })
    try {
        await replayPlan({ res, steps: plan.steps, end, loop: params.get('loop') === 'true', isClosed: () => closed })
    } catch (err) {
        console.error('[mock] replay failed:', err?.message)
        if (!res.writableEnded) res.end()
    }
}
