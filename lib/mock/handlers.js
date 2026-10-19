// Request handlers for /api/mock/* shared by Express (server.js) and Vercel functions.

import { isTrustedBrowserRequest, loadConfig } from '../proxy/guard.js'
import { clampSpeed, createMockStore, replay, validateSession } from './session.js'

const store = createMockStore()

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
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
        return json(res, 415, { error: 'Content-Type must be application/json' })
    }

    const { session, error } = validateSession(opts.body ?? req.body)
    if (error) return json(res, 400, { error })
    try {
        const sessionId = await store.create(session)
        return json(res, 200, { success: true, sessionId, events: session.events.length })
    } catch (err) {
        console.error('[mock] failed to store session:', err?.message)
        return json(res, 503, { error: 'Mock storage unavailable' })
    }
}

/** GET /api/mock/stream?session=<id>&speed=1&loop=false  (the session id is the capability) */
export async function handleMockStream(req, res, opts = {}) {
    const cfg = opts.config ?? loadConfig(opts.env ?? process.env)
    if (!cfg.mockEnabled) return disabled(res)
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' })

    const params = new URL(req.url, 'http://localhost').searchParams
    // Development convenience: without an id, fall back to the most recent in-memory session.
    const id = params.get('session') || (!cfg.production ? store.latestId() : null)
    const session = id ? await store.get(id) : null
    if (!session) return json(res, 404, { error: 'No mock session found. Upload a recording first.' })

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
