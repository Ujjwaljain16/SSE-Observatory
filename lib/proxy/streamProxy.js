// Single implementation of the /api/sse proxy, shared by server.js (Express) and
// the Vercel function. Works on plain Node IncomingMessage / ServerResponse.

import http from 'node:http'
import https from 'node:https'
import {
    FrameTracker, GuardError, errorEvent, hostAllowed, isTrustedBrowserRequest,
    loadConfig, parseTargetUrl, pinnedLookup, resolveTarget,
} from './guard.js'

const USER_AGENT = 'SSE-Observatory/1.0 (+https://github.com/Ujjwaljain16/SSE-Observatory)'
let active = 0

function sendJson(res, status, body, headers = {}) {
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
    res.end(JSON.stringify(body))
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ env?: object, config?: object, resolve?: Function }} [opts]
 */
export async function handleSseProxy(req, res, opts = {}) {
    const cfg = opts.config ?? loadConfig(opts.env ?? process.env)

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { Allow: 'GET, OPTIONS' })
        return res.end()
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, OPTIONS' })
    if (!isTrustedBrowserRequest(req, cfg)) return sendJson(res, 403, { error: 'Forbidden origin' })

    const params = new URL(req.url, 'http://localhost').searchParams
    const rawUrl = params.get('url')
    if (!rawUrl) return sendJson(res, 400, { error: 'Missing target url' })
    const auth = params.get('auth')
    if (auth && (auth.length > 8192 || /[\r\n\0]/.test(auth))) return sendJson(res, 400, { error: 'Invalid auth value' })

    let url
    let pin
    try {
        url = parseTargetUrl(rawUrl)
        if (!cfg.open && !hostAllowed(url.hostname, cfg.allowedHosts)) {
            console.warn(`[proxy] blocked host not on allow-list: ${url.hostname}`)
            throw new GuardError(403, 'Target host is not on this proxy\'s allow-list')
        }
        pin = await resolveTarget(url, { allowPrivate: cfg.allowPrivate, ...(opts.resolve ? { resolve: opts.resolve } : {}) })
    } catch (err) {
        if (err instanceof GuardError) {
            if (err.status === 403) console.warn(`[proxy] refused ${url?.hostname ?? 'invalid target'}: ${err.message}`)
            return sendJson(res, err.status, { error: err.message })
        }
        return sendJson(res, 500, { error: 'Proxy error' })
    }

    if (cfg.maxConcurrent && active >= cfg.maxConcurrent) {
        return sendJson(res, 429, { error: 'Too many concurrent streams' }, { 'Retry-After': '5' })
    }

    active++
    let finished = false
    let proxyReq
    let heartbeat
    let capTimer
    // eslint-disable-next-line prefer-const -- assigned after proxyReq exists; read by finish()
    let connectTimer
    const tracker = new FrameTracker()

    const finish = () => {
        if (finished) return
        finished = true
        active--
        clearInterval(heartbeat)
        clearTimeout(capTimer)
        clearTimeout(connectTimer)
        proxyReq?.destroy()
    }
    res.on('close', finish) // fires on client disconnect and after normal end

    const flush = () => res.flush?.()
    const endStream = (message) => {
        if (res.writableEnded) return
        if (res.headersSent) {
            if (message && tracker.atBoundary) res.write(errorEvent(message))
            res.end()
        } else {
            sendJson(res, 502, { error: message || 'Upstream error' })
        }
        finish()
    }

    const headers = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', 'User-Agent': USER_AGENT }
    if (auth) headers.Authorization = auth
    const lastId = req.headers['last-event-id']
    if (typeof lastId === 'string' && lastId.length <= 512 && !/[\r\n\0]/.test(lastId)) headers['Last-Event-ID'] = lastId

    const transport = url.protocol === 'https:' ? https : http
    try {
        proxyReq = transport.request(url, { method: 'GET', headers, lookup: pinnedLookup(pin.address, pin.family) }, (up) => {
            clearTimeout(connectTimer)
            const type = String(up.headers['content-type'] || '')
            if (up.statusCode !== 200 || !/^text\/event-stream/i.test(type)) {
                up.resume()
                return endStream(up.statusCode === 200 ? 'Target did not return an event stream' : `Target responded with HTTP ${up.statusCode}`)
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform, no-store, must-revalidate',
                Pragma: 'no-cache',
                Expires: '0',
                'X-Accel-Buffering': 'no',
                'X-Content-Type-Options': 'nosniff',
            })
            res.write(': sse-proxy-ping\n\n')
            flush()

            // Keep-alive comments are only injected between complete events.
            heartbeat = setInterval(() => {
                if (tracker.atBoundary && !res.writableEnded) {
                    res.write(': keep-alive\n\n')
                    flush()
                }
            }, cfg.heartbeatMs)
            if (cfg.maxDurationMs) {
                capTimer = setTimeout(() => {
                    if (tracker.atBoundary && !res.writableEnded) res.write('retry: 1000\n\n')
                    res.end()
                }, cfg.maxDurationMs)
            }

            let bytes = 0
            up.on('data', (chunk) => {
                bytes += chunk.length
                if (cfg.maxBytes && bytes > cfg.maxBytes) return endStream('Stream byte limit reached')
                tracker.push(chunk)
                if (!res.write(chunk)) {
                    up.pause()
                    res.once('drain', () => up.resume())
                }
                flush()
            })
            up.on('end', () => res.end())
            up.on('error', () => endStream('Upstream connection lost'))
        })
    } catch {
        finish()
        return sendJson(res, 400, { error: 'Invalid request headers' })
    }

    connectTimer = setTimeout(() => proxyReq.destroy(new Error('connect timeout')), cfg.connectTimeoutMs)
    proxyReq.on('error', (err) => {
        console.warn(`[proxy] upstream error for ${url.hostname}: ${err.code ?? err.message}`)
        endStream('Failed to reach target')
    })
    proxyReq.end()
}
