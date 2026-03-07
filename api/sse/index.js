import * as http from 'http'
import * as https from 'https'
import dns from 'dns'
import { promisify } from 'util'
import { decryptTicket } from './_ticket.js'

const lookup = promisify(dns.lookup)
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS ? process.env.ALLOWED_HOSTS.split(',') : []

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

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        return res.status(200).end()
    }

    if (req.method === 'GET') {
        let targetUrl = req.query.url
        let authHeader = req.query.auth
        const ticketId = req.query.ticket
        
        // Secure ticket exchange fallback
        if (ticketId) {
            const ticketData = decryptTicket(ticketId);
            if (!ticketData) {
                return res.status(401).json({ error: 'Invalid or expired proxy ticket' })
            }
            targetUrl = ticketData.url
            authHeader = ticketData.token
        }

        if (!targetUrl) {
            return res.status(400).json({ error: 'Missing target url' })
        }

        try {
            const target = new URL(targetUrl)

            // 1. Hostname Allowlist Check
            if (ALLOWED_HOSTS.length > 0 && !ALLOWED_HOSTS.includes(target.hostname)) {
                return res.status(403).json({ error: `Host ${target.hostname} is not in the allowlist` })
            }

            // 2. DNS Resolution & Private IP Check (DNS Rebinding Protection)
            const { address } = await lookup(target.hostname)
            
            // Strict SSRF check block private IPs in production unless specifically opted out
            if (isPrivateIP(address) && process.env.NODE_ENV === 'production') {
                return res.status(403).json({ error: 'Blocked attempt to proxy to private IP network' })
            }

            const protocol = target.protocol === 'https:' ? https : http
            const proxyReq = protocol.request(target, {
                headers: {
                    'Accept': 'text/event-stream',
                    ...(authHeader ? { 'Authorization': authHeader } : {})
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
