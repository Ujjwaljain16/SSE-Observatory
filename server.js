import * as Sentry from '@sentry/node';

Sentry.init({
    dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
});

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as http from 'http';
import * as https from 'https';
import dns from 'dns';
import { promisify } from 'util';
import path from 'path';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import winston from 'winston';


const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console()
    ]
});

const lookup = promisify(dns.lookup);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(compression());
// Parse large JSON bodies for mock session (max 10MB)
app.use(express.json({ limit: '10mb' }));


// Protect proxy from connection exhaustion (100 reqs / 15 mins per IP)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);



// Comma-separated list of allowed hostnames (e.g. "api.mycompany.com,stream.example.com")
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS ? process.env.ALLOWED_HOSTS.split(',') : [];

/**
 * Checks if a resolved IPv4/IPv6 address falls into a private/local range.
 * This prevents DNS rebinding attacks where an attacker points a public DNS
 * record to an internal IP like 169.254.169.254 or 127.0.0.1.
 */
function isPrivateIP(ip) {
    if (ip === '::1') return true;
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


app.get('/healthz', (req, res) => res.status(200).send('OK'));



let mockSession = null;

app.post('/api/mock/session', (req, res) => {
    try {
        mockSession = req.body;
        res.status(200).json({ success: true, events: mockSession.events?.length || 0 });
    } catch (e) {
        res.status(400).json({ error: 'Invalid mock data' });
    }
});

app.get('/api/mock/stream', async (req, res) => {
    if (!mockSession) {
        return res.status(404).json({ error: 'No mock session loaded' });
    }
    const speedMultiplier = parseFloat(req.query.speed) || 1;
    const loop = req.query.loop === 'true';

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
    });

    let isDestroyed = false;
    req.on('close', () => { isDestroyed = true; });

    const play = async () => {
        do {
            for (const event of (mockSession.events || [])) {
                if (isDestroyed) return;
                const delay = (event.deltaMs || 0) / speedMultiplier;
                if (delay > 0) await new Promise(r => setTimeout(r, delay));
                if (isDestroyed) return;

                let finalData = event.data;
                try {
                    const jj = JSON.parse(event.data);
                    if (!jj.type && event.type) {
                        jj.type = event.type;
                        finalData = JSON.stringify(jj);
                    }
                } catch (e) { }

                if (event.id) res.write(`id: ${event.id}\n`);
                finalData.split('\n').forEach((l) => res.write(`data: ${l}\n`));
                res.write('\n');
            }
        } while (loop && !isDestroyed);
        if (!isDestroyed) res.end();
    };
    play();
});


const sseTickets = new Map();

app.post('/api/sse/ticket', (req, res) => {
    const { url, token } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing url' });
    
    const ticketId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    sseTickets.set(ticketId, { url, token, expiresAt: Date.now() + 30000 }); // 30s expiry
    res.json({ ticket: ticketId });
});

// Periodic cleanup of expired tickets
setInterval(() => {
    const now = Date.now();
    for (const [id, ticket] of sseTickets.entries()) {
        if (ticket.expiresAt < now) sseTickets.delete(id);
    }
}, 60000);



app.get('/api/sse', async (req, res) => {
    const origin = req.headers.origin || req.headers.referer;
    const isLocal = origin && (origin.includes('localhost:') || origin.includes('127.0.0.1:'));
    const isInternal = isLocal || process.env.NODE_ENV !== 'production';

    let targetUrl = req.query.url;
    let authHeader = req.query.auth;
    const ticketId = req.query.ticket;

    if (ticketId) {
        const ticketData = sseTickets.get(ticketId);
        if (ticketData && ticketData.expiresAt > Date.now()) {
            targetUrl = ticketData.url;
            authHeader = ticketData.token;
            sseTickets.delete(ticketId);
        }
    }

    if (!targetUrl) return res.status(400).json({ error: 'Missing target url' });

    let target;
    try {
        target = new URL(targetUrl);
    } catch (e) {
        return res.status(400).json({ error: 'Invalid target URL' });
    }

    if (process.env.NODE_ENV === 'production' && !isInternal) {
        const isHostAllowed = ALLOWED_HOSTS.length > 0 && ALLOWED_HOSTS.includes(target.hostname);
        if (!isHostAllowed) {
            res.writeHead(403, { 'Content-Type': 'text/event-stream' });
            res.write(`event: error\ndata: {"error":"Unauthorized origin"}\n\n`);
            return res.end();
        }
    }

    try {
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
            res.writeHead(proxyRes.statusCode || 200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
                'Access-Control-Allow-Origin': origin || '*'
            });

            res.write(': sse-proxy-ping\n\n');
            if (res.flush) res.flush();

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
        if (!res.headersSent) res.status(500).json({ error: e.message });
        else {
            res.write(`event: error\ndata: {"error":"Proxy fault","details":"${e.message}"}\n\n`);
            res.end();
        }
    }
});

// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(process.cwd(), 'dist')));
    app.get('*', (req, res) => {
        if (!req.path.startsWith('/api')) {
            res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
        }
    });
}

Sentry.setupExpressErrorHandler(app);

app.listen(PORT, '127.0.0.1', () => {
    logger.info(`Backend service listening on http://127.0.0.1:${PORT}`, { environment: process.env.NODE_ENV || 'development' });
});
