// Request handlers for /api/mock/* shared by Express (server.js) and Vercel functions.

import { isTrustedBrowserRequest, loadConfig } from '../proxy/guard.js'
import { clampSpeed, createMockStore, replay, replayPlan, validateSession } from './session.js'
import { END_BEHAVIOURS, planReplay } from './capturePlan.js'

const store = createMockStore()
// How many times each capture session has been requested, so the second request serves the second recorded connection.
const requests = new Map()

function json(res, status, body, headers = {}) {
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
    res.end(JSON.stringify(body))
}

function disabled(res) {
    return json(res, 404, { error: 'Mock API is disabled on this deployment (set ENABLE_MOCK_API=1 to enable)' })
}

/** POST /api/mock/session  → { sessionId, events }      DELETE /api/mock/session?id=… */
export async function handleMockSession(req, res, opts = {}) {
    const cfg = opts.config ?? loadConfig(opts.env ?? process.env)
    if (!cfg.mockEnabled) return disabled(res)
    if (!isTrustedBrowserRequest(req, cfg)) return json(res, 403, { error: 'Forbidden origin' })

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

    const { session, error } = validateSession(opts.body ?? req.body)
    if (error) return json(res, 400, { error })
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

    const params = new URL(req.url, 'http://localhost').searchParams
    // Development convenience: without an id, fall back to the most recent in-memory session.
    const id = params.get('session') || (!cfg.production ? store.latestId() : null)
    const session = id ? await store.get(id) : null
    if (!session) return json(res, 404, { error: 'No mock session found. Upload a recording first.' })

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
