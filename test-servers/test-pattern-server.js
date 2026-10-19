/**
 * test-pattern-server.js
 *
 * Deliberately triggers every pattern detection scenario:
 *   /burst-test    — sends 15 events in 2 seconds, then calms down (burst pattern)
 *   /gap-test      — sends events, then goes silent for 10s, then resumes (gap pattern)
 *   /frequency     — sends specific event types at known rates (frequency rule test)
 *   /correlated    — events with matching traceId/correlationId fields
 *
 * Run: node test-pattern-server.js
 * Port: 4004
 */

import http from 'http'

function sse(res, data, event = 'message', id = null) {
    if (id) res.write(`id: ${id}\n`)
    if (event !== 'message') res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end() }

    const headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    }

    if (req.url === '/burst-test') {
        // Phase 1: calm (5 events @ 1s each)
        // Phase 2: BURST (20 events in 1.5s) — should trigger burst alert
        // Phase 3: calm again (5 events @ 1s each)
        res.writeHead(200, headers)
        let seq = 0
        const events = []

        // Phase 1: slow
        for (let i = 0; i < 5; i++) {
            events.push({ delay: i * 1000, data: { seq: ++seq, phase: 'calm', type: 'tick' } })
        }
        // Phase 2: burst — 20 events in 1.5s starting at t=6s
        for (let i = 0; i < 20; i++) {
            events.push({ delay: 6000 + i * 75, data: { seq: ++seq, phase: 'BURST', type: 'alert' } })
        }
        // Phase 3: calm again
        for (let i = 0; i < 5; i++) {
            events.push({ delay: 8000 + i * 1000, data: { seq: ++seq, phase: 'calm', type: 'tick' } })
        }

        events.forEach(({ delay, data }) => {
            setTimeout(() => {
                if (!res.writableEnded) sse(res, data, 'message')
            }, delay)
        })

        setTimeout(() => { if (!res.writableEnded) res.end() }, 14000)
        req.on('close', () => {})

    } else if (req.url === '/gap-test') {
        // Sends events normally, then silent for 10s, then resumes
        res.writeHead(200, headers)
        let seq = 0
        const iv = setInterval(() => {
            seq++
            sse(res, { seq, phase: 'active', type: 'heartbeat', ts: Date.now() }, 'message')
            if (seq >= 5) {
                clearInterval(iv)
                console.log('[gap-test] Going silent for 10s...')
                // 10s gap
                setTimeout(() => {
                    console.log('[gap-test] Resuming...')
                    const iv2 = setInterval(() => {
                        seq++
                        sse(res, { seq, phase: 'resumed', type: 'heartbeat', ts: Date.now() }, 'message')
                        if (seq >= 15) { clearInterval(iv2); res.end() }
                    }, 1000)
                }, 10000)
            }
        }, 1000)
        req.on('close', () => { clearInterval(iv) })

    } else if (req.url === '/frequency') {
        // Sends events at known rates: `error` every 3s, `info` every 500ms
        // Create a frequency rule for `error` type ≥ 4 per minute to trigger an alert
        res.writeHead(200, headers)
        let seq = 0
        const errorIv = setInterval(() => {
            seq++
            sse(res, { seq, type: 'error', level: 'error', message: `Error #${seq}` }, 'message')
        }, 3000)

        const infoIv = setInterval(() => {
            seq++
            sse(res, { seq, type: 'info', level: 'info', message: `Tick #${seq}` }, 'message')
        }, 500)

        setTimeout(() => {
            clearInterval(errorIv)
            clearInterval(infoIv)
            res.end()
        }, 60000)

        req.on('close', () => {
            clearInterval(errorIv)
            clearInterval(infoIv)
        })

    } else if (req.url === '/correlated') {
        // 3 trace groups, each with request→processing→response events
        res.writeHead(200, headers)
        const traces = ['T-001', 'T-002', 'T-003']
        let delay = 0

        traces.forEach(traceId => {
            setTimeout(() => sse(res, { traceId, type: 'request', stage: 'request', svc: 'api-gw' }, 'message'), delay += 200)
            setTimeout(() => sse(res, { traceId, type: 'processing', stage: 'processing', svc: 'worker' }, 'message'), delay += 300)
            setTimeout(() => sse(res, { traceId, type: 'db', stage: 'db_query', svc: 'postgres' }, 'message'), delay += 400)
            setTimeout(() => sse(res, { traceId, type: 'response', stage: 'response', svc: 'api-gw', status: 200 }, 'message'), delay += 200)
        })

        setTimeout(() => { if (!res.writableEnded) res.end() }, delay + 500)
        req.on('close', () => {})

    } else {
        res.writeHead(404)
        res.end('Try /burst-test, /gap-test, /frequency, /correlated')
    }
})

const PORT = 4004
server.listen(PORT, () => {
    console.log(`\n🔍 Pattern Detection Test Server running at http://localhost:${PORT}`)
    console.log(`  /burst-test  — calm → 20-event burst → calm (triggers burst alert)`)
    console.log(`  /gap-test    — active → 10s silence → resumed (gap detection)`)
    console.log(`  /frequency   — error every 3s, info every 500ms (frequency rule)`)
    console.log(`  /correlated  — 3 trace groups with request→db→response chain\n`)
})
