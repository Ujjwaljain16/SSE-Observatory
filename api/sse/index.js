import * as http from 'http'
import * as https from 'https'
import dns from 'dns'
import { promisify } from 'util'
import { decryptTicket } from './_ticket.js'

const lookup = promisify(dns.lookup)
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS 
    ? process.env.ALLOWED_HOSTS.split(',').map(h => h.trim()) 
    : []

const APP_ORIGINS = process.env.PROXY_ALLOWED_ORIGINS 
    ? process.env.PROXY_ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : [];

function isPrivateIP(ip) {
    if (!ip) return false;
    if (ip === '::1' || ip === '127.0.0.1') return true;
    if (ip.toLowerCase().startsWith('fc00:') || ip.toLowerCase().startsWith('fd')) return true;
    if (ip.toLowerCase().startsWith('fe80:')) return true;

    const parts = ip.split('.').map(p => parseInt(p, 10));
    if (parts.length === 4) {
        if (parts[0] === 10) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        if (parts[0] === 127) return true;
        if (parts[0] === 169 && parts[1] === 254) return true;
    }
    return false;
}

export default async function handler(req, res) {
    const origin = req.headers.origin || req.headers.referer;
    
    // Safety check: is this request coming from our own app or a trusted host?
    const isLocal = origin && (origin.includes('localhost:') || origin.includes('127.0.0.1:'));
    const isWhitelisted = origin && APP_ORIGINS.some(o => origin.startsWith(o));
    const isVercel = process.env.VERCEL_URL && origin && origin.includes(process.env.VERCEL_URL);
    const isInternal = isLocal || isWhitelisted || isVercel;

    // Handle CORS preflight
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    let targetUrl = req.query.url;
    let authHeader = req.query.auth;
    const ticketId = req.query.ticket;

    // If ticket is provided, try to decrypt it (Legacy support)
    if (ticketId) {
        const ticketData = decryptTicket(ticketId);
        if (ticketData) {
            targetUrl = ticketData.url;
            authHeader = ticketData.token;
        }
    }

    if (!targetUrl) return res.status(400).json({ error: 'Missing target url' });

    let target;
    try {
        target = new URL(targetUrl);
    } catch (e) {
        return res.status(400).json({ error: 'Invalid target URL' });
    }

    // Security Enforcement:
    // If NOT from our own app origin, only allow specifically allowlisted hosts
    if (process.env.NODE_ENV === 'production' && !isInternal) {
        const isHostAllowed = ALLOWED_HOSTS.length > 0 && ALLOWED_HOSTS.includes(target.hostname);
        if (!isHostAllowed) {
            console.warn(`[Proxy] Unauthorized access attempt to ${target.hostname} from ${origin}`);
            res.writeHead(403, { 'Content-Type': 'text/event-stream' });
            res.write(`event: error\ndata: {"error":"Unauthorized origin. Only requests from the app itself are allowed to proxy arbitrary URLs."}\n\n`);
            return res.end();
        }
    }

    try {
        // SSRF Protection: Resolve and block private IPs
        const { address } = await lookup(target.hostname).catch(() => ({ address: null }));
        if (address && isPrivateIP(address) && process.env.NODE_ENV === 'production') {
            res.writeHead(403, { 'Content-Type': 'text/event-stream' });
            res.write(`event: error\ndata: {"error":"Blocked access to private network"}\n\n`);
            return res.end();
        }

        const protocol = target.protocol === 'https:' ? https : http;
        const proxyReq = protocol.request(target, {
            headers: {
                'Accept': 'text/event-stream',
                'User-Agent': 'SSE-Observatory/1.0 (https://github.com/Ujjwaljain16/SSE-Observatory)',
                'Cache-Control': 'no-cache',
                ...(authHeader ? { 'Authorization': authHeader } : {})
            }
        }, (proxyRes) => {
            // Set streaming headers
            res.writeHead(proxyRes.statusCode || 200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
                'Access-Control-Allow-Origin': origin || '*'
            });

            // Immediate heartbeat to flush headers and signal aliveness
            res.write(': sse-proxy-ping\n\n');
            if (res.flush) res.flush();

            // Keep-alive heartbeat every 15 seconds to prevent gateway timeouts
            const heartbeat = setInterval(() => {
                if (!res.writableEnded) {
                    res.write(': keep-alive\n\n');
                    if (res.flush) res.flush();
                }
            }, 15000);

            proxyRes.on('data', (chunk) => {
                if (!res.writableEnded) {
                    res.write(chunk);
                    if (res.flush) res.flush();
                }
            });

            proxyRes.on('end', () => {
                clearInterval(heartbeat);
                res.end();
            });

            proxyRes.on('error', (err) => {
                clearInterval(heartbeat);
                res.write(`event: error\ndata: {"error":"Upstream connection lost","details":"${err.message}"}\n\n`);
                res.end();
            });

            req.on('close', () => {
                clearInterval(heartbeat);
                proxyReq.destroy();
            });
        });

        proxyReq.on('error', (err) => {
            if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/event-stream' });
            res.write(`event: error\ndata: {"error":"Failed to reach target","details":"${err.message}"}\n\n`);
            res.end();
        });

        proxyReq.end();
    } catch (e) {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/event-stream' });
        res.write(`event: error\ndata: {"error":"Proxy internal failure","details":"${e.message}"}\n\n`);
        res.end();
    }
}
