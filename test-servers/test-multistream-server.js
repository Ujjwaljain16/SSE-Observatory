/**
 * test-multistream-server.js
 *
 * Three independent SSE streams with distinct event shapes for testing
 * the Multi-Stream mode — all streams run on the same port but different paths.
 *
 * Endpoints:
 *   /stream-a  — user events (login, logout, profile_view)
 *   /stream-b  — payment events (charge, refund, dispute)
 *   /stream-c  — system events (deploy, rollback, alert)
 *
 * Run: node test-multistream-server.js
 * Port: 4003
 */

import http from 'http'

function sse(res, data, event = 'message') {
    if (event !== 'message') res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function startStreamA(res, req) {
    const actions = ['login', 'logout', 'profile_view', 'settings_change', 'password_reset']
    const users = ['alice', 'bob', 'carol', 'dave', 'eve']
    let i = 0
    const iv = setInterval(() => {
        i++
        sse(res, {
            streamId: 'A',
            seq: i,
            event: actions[Math.floor(Math.random() * actions.length)],
            user: users[Math.floor(Math.random() * users.length)],
            traceId: `trace-${(i % 5) + 1}`,   // 5 correlation groups
            ts: Date.now()
        }, 'message')
        if (i >= 30) { sse(res, { done: true }, 'end'); res.end(); clearInterval(iv) }
    }, 600)
    req.on('close', () => clearInterval(iv))
}

function startStreamB(res, req) {
    const types = ['charge', 'refund', 'dispute', 'payout', 'reversal']
    let i = 0
    const iv = setInterval(() => {
        i++
        sse(res, {
            streamId: 'B',
            seq: i,
            type: types[Math.floor(Math.random() * types.length)],
            amount: +(Math.random() * 500).toFixed(2),
            currency: 'USD',
            traceId: `trace-${(i % 5) + 1}`,
            ts: Date.now()
        }, 'message')
        if (i >= 30) { sse(res, { done: true }, 'end'); res.end(); clearInterval(iv) }
    }, 800)
    req.on('close', () => clearInterval(iv))
}

function startStreamC(res, req) {
    const severities = ['info', 'warning', 'critical', 'info', 'info']
    const services = ['api-gateway', 'auth-service', 'payment-svc', 'db-replica']
    let i = 0
    const iv = setInterval(() => {
        i++
        const sev = severities[Math.floor(Math.random() * severities.length)]
        sse(res, {
            streamId: 'C',
            seq: i,
            severity: sev,
            service: services[Math.floor(Math.random() * services.length)],
            message: sev === 'critical' ? 'DISK FULL' : `Heartbeat #${i}`,
            ts: Date.now()
        }, 'message')
        if (i >= 30) { sse(res, { done: true }, 'end'); res.end(); clearInterval(iv) }
    }, 1000)
    req.on('close', () => clearInterval(iv))
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

    if (req.url === '/stream-a') {
        res.writeHead(200, headers)
        startStreamA(res, req)
    } else if (req.url === '/stream-b') {
        res.writeHead(200, headers)
        startStreamB(res, req)
    } else if (req.url === '/stream-c') {
        res.writeHead(200, headers)
        startStreamC(res, req)
    } else {
        res.writeHead(404)
        res.end('Try /stream-a, /stream-b, /stream-c')
    }
})

const PORT = 4003
server.listen(PORT, () => {
    console.log(`\n🌊 Multi-Stream Test Server running at http://localhost:${PORT}`)
    console.log(`  /stream-a  — user events (login/logout) @ 600ms`)
    console.log(`  /stream-b  — payment events @ 800ms`)
    console.log(`  /stream-c  — system/alert events @ 1000ms`)
    console.log(`  All share traceId groups 1-5 for correlation testing\n`)
})
