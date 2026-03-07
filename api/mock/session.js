import { kv } from '@vercel/kv'
import crypto from 'crypto'

// Fallback for non-KV environments
global.mockSession = global.mockSession || null

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
        return res.status(200).end()
    }

    if (req.method === 'POST') {
        try {
            const sessionData = req.body
            const sessionId = 'current_session' // We use a fixed key for the demo purposes or could use session tagging
            
            // 1. Try Vercel KV persistence
            if (process.env.KV_REST_API_URL) {
                await kv.set(sessionId, sessionData, { ex: 3600 }) // Auto-expire in 1 hour to save space
                console.log('[Mock Session] Saved to Vercel KV')
            } 
            
            // 2. Always update local memory as a hot fallback/optimization
            global.mockSession = sessionData
            
            return res.status(200).json({ 
                success: true, 
                persistence: process.env.KV_REST_API_URL ? 'kv' : 'memory',
                events: sessionData.events?.length || 0 
            })
        } catch (e) {
            console.error('[Mock Session] Error:', e.message)
            return res.status(400).json({ error: 'Invalid mock session JSON' })
        }
    } else {
        return res.status(405).json({ error: 'Method not allowed' })
    }
}
