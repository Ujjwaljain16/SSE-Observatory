import { kv } from '@vercel/kv'

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
        return res.status(200).end()
    }

    if (req.method === 'GET') {
        let mockSession = null
        
        try {
            // 1. Try to fetch from Vercel KV first (shared persistence)
            if (process.env.KV_REST_API_URL) {
                mockSession = await kv.get('current_session')
                if (mockSession) console.log('[Mock Stream] Loaded session from Vercel KV')
            }
            
            // 2. Fallback to ephemeral global memory
            if (!mockSession) {
                mockSession = global.mockSession || null
                if (mockSession) console.log('[Mock Stream] Loaded session from local memory')
            }

            if (!mockSession) {
                // Return a friendly SSE error message if no session is found
                res.writeHead(404, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
                res.write(`event: error\ndata: {"error": "No mock session found. Please upload a file first."}\n\n`)
                return res.end()
            }

            const speedMultiplier = parseFloat(req.query.speed || '1') || 1
            const loop = req.query.loop === 'true'

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            })

            let isDestroyed = false
            req.on('close', () => { isDestroyed = true })

            const play = async () => {
                do {
                    for (const event of (mockSession.events || [])) {
                        if (isDestroyed) return
                        const delay = (event.deltaMs || 0) / speedMultiplier
                        if (delay > 0) await new Promise(r => setTimeout(r, delay))
                        if (isDestroyed) return

                        let finalData = event.data
                        try {
                            const jj = JSON.parse(event.data)
                            if (!jj.type && event.type) {
                                jj.type = event.type
                                finalData = JSON.stringify(jj)
                            }
                        } catch (e) { }

                        if (event.id) res.write(`id: ${event.id}\n`)
                        finalData.split('\n').forEach(l => res.write(`data: ${l}\n`))
                        res.write('\n')
                    }
                } while (loop && !isDestroyed)
                if (!isDestroyed) res.end()
            }
            play()
        } catch (e) {
            console.error('[Mock Stream] Error:', e.message)
            res.status(500).json({ error: 'Server error during streaming' })
        }
    } else {
        return res.status(405).json({ error: 'Method not allowed' })
    }
}
