// Network-safety primitives for the SSE proxy: configuration, origin checks,
// SSRF address filtering with DNS pinning, and SSE frame tracking.
// Framework-agnostic (plain Node http objects) so Express and Vercel share it.

import net from 'node:net'
import dns from 'node:dns'

export class GuardError extends Error {
    constructor(status, message) {
        super(message)
        this.status = status
    }
}

// ---------- configuration ----------

const list = (v) => (v ? String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [])
const int = (v) => {
    const n = Number.parseInt(v ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : 0
}

export function normalizeOrigin(value) {
    try {
        const u = new URL(value)
        return u.origin === 'null' ? null : u.origin.toLowerCase()
    } catch {
        return null
    }
}

export function loadConfig(env = process.env) {
    const production = env.NODE_ENV === 'production' || Boolean(env.VERCEL)
    return {
        production,
        // In production the proxy only relays to ALLOWED_HOSTS unless PROXY_OPEN=1.
        open: !production || env.PROXY_OPEN === '1',
        allowedHosts: list(env.ALLOWED_HOSTS),
        allowedOrigins: list(env.PROXY_ALLOWED_ORIGINS).map(normalizeOrigin).filter(Boolean),
        // Private/reserved targets are blocked in production unless explicitly allowed (self-host).
        allowPrivate: !production || env.ALLOW_PRIVATE_TARGETS === '1',
        maxDurationMs: int(env.MAX_STREAM_SECONDS) * 1000 || (env.VERCEL ? 55_000 : production ? 3_600_000 : 0),
        maxBytes: int(env.MAX_STREAM_MB) * 1024 * 1024 || (production ? 50 * 1024 * 1024 : 0),
        maxConcurrent: int(env.MAX_CONCURRENT_STREAMS) || (production ? 50 : 0),
        heartbeatMs: int(env.HEARTBEAT_MS) || 15_000,
        connectTimeoutMs: int(env.CONNECT_TIMEOUT_MS) || 10_000,
        mockEnabled: !production || env.ENABLE_MOCK_API === '1',
    }
}

export function hostAllowed(hostname, allowedHosts) {
    const h = hostname.toLowerCase()
    return allowedHosts.some((rule) =>
        rule.startsWith('*.') ? h.endsWith(rule.slice(1)) && h.length > rule.length - 1 : h === rule
    )
}

// ---------- request origin ----------

/**
 * True when the request comes from our own web app (or a configured origin).
 * Browsers set Sec-Fetch-Site / Origin and page scripts cannot forge them, which
 * stops other websites from using the proxy. Non-browser clients can still spoof
 * these headers, so this is not authentication — caps and the SSRF guard
 * are what bound abuse.
 */
export function isTrustedBrowserRequest(req, cfg) {
    const site = req.headers['sec-fetch-site']
    if (site) return site === 'same-origin' || (!cfg.production && site === 'same-site')

    const raw = req.headers.origin || req.headers.referer
    if (!raw) return !cfg.production
    const origin = normalizeOrigin(raw)
    if (!origin) return false
    if (cfg.allowedOrigins.includes(origin)) return true

    const host = req.headers.host
    if (host && (origin === `https://${host}`.toLowerCase() || (!cfg.production && origin === `http://${host}`.toLowerCase()))) {
        return true
    }
    if (!cfg.production) {
        const h = new URL(origin).hostname
        return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
    }
    return false
}

// ---------- SSRF address filtering ----------

const blocked4 = new net.BlockList()
const blocked6 = new net.BlockList()
for (const [addr, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked4.addSubnet(addr, prefix, 'ipv4')
for (const [addr, prefix] of [
    ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
    ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked6.addSubnet(addr, prefix, 'ipv6')

/** Strip brackets/zone id and unwrap IPv4-mapped IPv6 (dotted or hex form). */
export function normalizeIp(ip) {
    let s = String(ip).trim().toLowerCase().replace(/^\[|\]$/g, '')
    const zone = s.indexOf('%')
    if (zone !== -1) s = s.slice(0, zone)
    let m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
    if (m) return m[1]
    m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s)
    if (m) {
        const hi = Number.parseInt(m[1], 16)
        const lo = Number.parseInt(m[2], 16)
        return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
    }
    return s
}

export function isPrivateAddress(ip) {
    const s = normalizeIp(ip)
    const family = net.isIP(s)
    if (family === 4) return blocked4.check(s, 'ipv4')
    if (family === 6) return blocked6.check(s, 'ipv6')
    return true // unparseable → treat as unsafe
}

export function parseTargetUrl(raw) {
    let url
    try {
        url = new URL(raw)
    } catch {
        throw new GuardError(400, 'Invalid target URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new GuardError(400, 'Only http(s) targets are supported')
    if (url.username || url.password) throw new GuardError(400, 'Credentials in the target URL are not allowed')
    return url
}

const defaultResolve = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true })

/**
 * Resolve once, validate every returned address, and return the address to pin the
 * connection to (prevents DNS-rebinding between check and connect).
 */
export async function resolveTarget(url, { allowPrivate = false, resolve = defaultResolve } = {}) {
    const host = url.hostname.replace(/^\[|\]$/g, '')
    let addrs
    if (net.isIP(host)) {
        addrs = [{ address: host, family: net.isIP(host) }]
    } else {
        try {
            addrs = await resolve(host)
        } catch {
            throw new GuardError(502, 'Could not resolve target host')
        }
    }
    if (!addrs || addrs.length === 0) throw new GuardError(502, 'Could not resolve target host')
    if (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) {
        throw new GuardError(403, 'Target resolves to a private or reserved address')
    }
    const first = addrs[0]
    return { address: first.address, family: net.isIP(first.address) || first.family }
}

/** `lookup` option for http(s).request that always answers with the pre-validated address. */
export function pinnedLookup(address, family) {
    return (_hostname, options, cb) => {
        if (typeof options === 'function') cb = options
        if (options && typeof options === 'object' && options.all) return cb(null, [{ address, family }])
        return cb(null, address, family)
    }
}

// ---------- SSE framing ----------

/** Tracks whether the bytes forwarded so far end exactly on an SSE event boundary. */
export class FrameTracker {
    constructor() {
        this.tail = ''
        this.atBoundary = true
    }
    push(chunk) {
        const s = this.tail + (typeof chunk === 'string' ? chunk : chunk.toString('latin1'))
        // Normalise CRLF/CR to LF first so "\r\n" counts as ONE line terminator.
        this.atBoundary = s.replace(/\r\n|\r/g, '\n').endsWith('\n\n')
        this.tail = s.slice(-4)
    }
}

export function errorEvent(message, extra = {}) {
    return `event: error\ndata: ${JSON.stringify({ error: message, ...extra })}\n\n`
}
