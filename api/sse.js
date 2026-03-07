import * as http from 'http'
import * as https from 'https'

export default function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        return res.status(200).end()
    }

    if (req.method === 'GET') {
        const targetUrl = req.query.url
        if (!targetUrl) {
            return res.status(400).json({ error: 'Missing url' })
        }

        try {
            const target = new URL(targetUrl)
            const protocol = target.protocol === 'https:' ? https : http
            const proxyReq = protocol.request(target, {
                headers: {
                    'Accept': 'text/event-stream',
                    ...(req.query.auth ? { 'Authorization': req.query.auth } : {})
                }
            }, (proxyRes) => {
                res.writeHead(proxyRes.statusCode || 200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*',
                    'X-Accel-Buffering': 'no'
                })
                proxyRes.pipe(res)
            })

            proxyReq.on('error', (err) => {
                console.error('[Proxy Error]', err.message)
                if (!res.headersSent) {
                    res.writeHead(502, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache, no-transform',
                        'Access-Control-Allow-Origin': '*'
                    })
                }
                res.write(`event: error\ndata: {"error":"Target server unreachable","details":"${err.message}"}\n\n`)
                res.end()
            })
            proxyReq.end()
        } catch (e) {
            console.error('[Proxy Exception]', e.message)
            if (!res.headersSent) {
                res.writeHead(400, {
                    'Content-Type': 'text/event-stream',
                    'Access-Control-Allow-Origin': '*'
                })
            }
            res.write(`event: error\ndata: {"error":"Invalid proxy request","details":"${e.message}"}\n\n`)
            res.end()
        }
    } else {
        return res.status(405).json({ error: 'Method not allowed' })
    }
}
