import { encryptTicket } from './_ticket.js';

export default function handler(req, res) {
    // CORS headers just in case
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json({ ticket: ticketId });
    } catch (e) {
        res.status(500).json({ error: 'Failed to generate ticket' });
    }
}
