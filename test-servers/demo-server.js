/**
 * demo-server.js: a realistic, continuous SSE stream for demos and README screenshots.
 *
 *   GET /demo        ~12 events/s of orders, payments and service logs that share trace ids,
 *                    with an error burst a few seconds in (it trips the built-in "Error burst" pattern rule)
 *   GET /demo-slow   the same shape at ~2 events/s
 *
 * Run: node test-servers/demo-server.js     Port: 4010
 */

import http from 'node:http'

const SERVICES = ['checkout', 'payments', 'inventory', 'shipping', 'auth']
const USERS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']
const pick = (list) => list[Math.floor(Math.random() * list.length)]

function stream(res, req, everyMs) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
    let n = 0
    let traceCounter = 100
    let trace = `tr-${traceCounter}`
    const send = (type, data) => res.write(`event: ${type}\nid: ${n}\ndata: ${JSON.stringify({ traceId: trace, ...data })}\n\n`)

    const timer = setInterval(() => {
        n++
        if (n % 6 === 0) trace = `tr-${++traceCounter}`
        const burst = n >= 40 && n < 48 // a run of failures after a few seconds
        if (burst) return send('error', { service: pick(SERVICES), level: 'error', message: 'upstream timeout', latencyMs: 2000 + Math.floor(Math.random() * 1500), attempt: 1 })
        const roll = Math.random()
        if (roll < 0.28) send('order_created', { service: 'checkout', user: pick(USERS), orderId: `o-${1000 + n}`, items: 1 + Math.floor(Math.random() * 4), total: +(10 + Math.random() * 240).toFixed(2) })
        else if (roll < 0.55) send('payment_succeeded', { service: 'payments', user: pick(USERS), amount: +(10 + Math.random() * 240).toFixed(2), currency: 'USD', method: pick(['card', 'card', 'paypal', 'apple_pay']) })
        else if (roll < 0.63) send('payment_failed', { service: 'payments', user: pick(USERS), amount: +(10 + Math.random() * 240).toFixed(2), level: 'warn', reason: pick(['card_declined', 'insufficient_funds', 'expired_card']) })
        else if (roll < 0.8) send('inventory_updated', { service: 'inventory', sku: `SKU-${100 + Math.floor(Math.random() * 40)}`, delta: -1 - Math.floor(Math.random() * 3) })
        else if (roll < 0.92) send('order_shipped', { service: 'shipping', orderId: `o-${900 + Math.floor(Math.random() * 100)}`, carrier: pick(['ups', 'dhl', 'fedex']) })
        else send('log', { service: pick(SERVICES), level: 'info', message: 'request completed', latencyMs: 20 + Math.floor(Math.random() * 180) })
    }, everyMs)
    req.on('close', () => clearInterval(timer))
}

http.createServer((req, res) => {
    if (req.url?.startsWith('/demo-slow')) return stream(res, req, 500)
    if (req.url?.startsWith('/demo')) return stream(res, req, 80)
    res.writeHead(404).end('Try /demo or /demo-slow')
}).listen(4010, () => console.log('Demo stream at http://localhost:4010/demo'))
