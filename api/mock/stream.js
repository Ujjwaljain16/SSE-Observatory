// Note: In Vercel this relies on the ephemeral global object from /session.
// It will only successfully replay if the Lambda container is still warm and handling both requests.

export default function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        return res.status(200).end()
    }

    if (req.method === 'GET') {
        const mockSession = global.mockSession || null
        if (!mockSession) {
            return res.status(404).json({ error: 'No mock session loaded in this Lambda container' })
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
    } else {
        return res.status(405).json({ error: 'Method not allowed' })
    }
}
