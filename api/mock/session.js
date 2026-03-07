// Global mock session object. 
// Note: In Vercel this is ephemeral and only works if requests hit the same Lambda container.
// For a robust production Mock Server, this should be backed by Vercel KV or a Redis database.

global.mockSession = global.mockSession || null

export default function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        return res.status(200).end()
    }

    if (req.method === 'POST') {
        try {
            global.mockSession = req.body
            return res.status(200).json({ success: true, events: req.body.events?.length || 0 })
        } catch (e) {
            return res.status(400).json({ error: 'Invalid mock session JSON' })
        }
    } else {
        return res.status(405).json({ error: 'Method not allowed' })
    }
}
