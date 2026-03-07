/**
 * test-interceptor-server.js
 *
 * Sends controlled, predictable events for testing the interceptor pipeline.
 *
 * Endpoints:
 *   /plain        — simple events with a `value` field (test transforms)
 *   /sensitive    — events with fake auth tokens (test redaction interceptors)
 *   /rapid        — 200 events immediately (test interceptor throughput)
 *
 * Run: node test-interceptor-server.js
 * Port: 4002
 */

import http from 'http'

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
        res.writeHead(200)
        return res.end()
    }

    const sse = (data, event = 'message', id = null) => {
        if (id) res.write(`id: ${id}\n`)
        if (event !== 'message') res.write(`event: ${event}\n`)
        res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    }

    if (req.url === '/plain') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        })

        let i = 0
        const iv = setInterval(() => {
            i++
            sse({ counter: i, value: i * 10, type: i % 2 === 0 ? 'even' : 'odd' }, 'message', `plain-${i}`)
            if (i >= 20) {
                sse({ done: true }, 'end')
                res.end()
                clearInterval(iv)
            }
        }, 500)

        req.on('close', () => clearInterval(iv))

    } else if (req.url === '/sensitive') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        })

        // Events with sensitive data — interceptors should strip these
        const events = [
            { id: 1, user: 'alice', password: 'hunter2', token: 'sk-abc123', action: 'login' },
            { id: 2, user: 'bob', creditCard: '4111-1111-1111-1111', amount: 99.99, action: 'purchase' },
            { id: 3, user: 'carol', ssn: '123-45-6789', action: 'profile_update' },
            { id: 4, user: 'dave', apiKey: 'secret-key-xyz', endpoint: '/admin', action: 'api_call' },
            { id: 5, user: 'eve', action: 'logout', session: 'expired' },
        ]

        let i = 0
        const iv = setInterval(() => {
            if (i >= events.length) {
                sse({ done: true }, 'end')
                res.end()
                clearInterval(iv)
                return
            }
            sse(events[i], 'message', `sensitive-${i + 1}`)
            i++
        }, 1000)

        req.on('close', () => clearInterval(iv))

    } else if (req.url === '/rapid') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        })

        // 200 events as fast as possible — tests interceptor throughput
        for (let i = 0; i < 200; i++) {
            sse({ id: i, value: Math.random(), batch: 'rapid' })
        }
        sse({ done: true }, 'end')
        res.end()

    } else {
        res.writeHead(404)
        res.end('Not found. Try /plain, /sensitive, /rapid')
    }
})

const PORT = 4002
server.listen(PORT, () => {
    console.log(`\n🔬 Interceptor Test Server running at http://localhost:${PORT}`)
    console.log(`  /plain     — 20 predictable events @ 500ms`)
    console.log(`  /sensitive — 5 events with passwords/tokens/PII`)
    console.log(`  /rapid     — 200 events immediately (throughput test)\n`)
})
