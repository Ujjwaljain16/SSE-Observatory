import { encryptTicket } from './_ticket.js';

const WHITELIST_ORIGINS = process.env.PROXY_ALLOWED_ORIGINS 
    ? process.env.PROXY_ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : [];

export default function handler(req, res) {
    const origin = req.headers.origin;
    const isLocalhost = origin && (origin.includes('localhost:') || origin.includes('127.0.0.1:'));
    const isWhitelisted = WHITELIST_ORIGINS.includes(origin);
    const isVercel = process.env.VERCEL_URL && origin && origin.includes(process.env.VERCEL_URL);

    // Strict origin check in production
    if (process.env.NODE_ENV === 'production' && !isLocalhost && !isWhitelisted && !isVercel) {
        console.warn(`[Security] Ticket request blocked from unauthorized origin: ${origin}`);
        return res.status(403).json({ error: 'Unauthorized origin' });
    }

    // Handle CORS preflight
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { url, token } = req.body || {};
    if (!url) {
        return res.status(400).json({ error: 'Missing url' });
    }

    try {
        const ticketId = encryptTicket(url, token);
        res.json({ ticket: ticketId });
    } catch (e) {
        res.status(500).json({ error: 'Failed to generate ticket' });
    }
}
