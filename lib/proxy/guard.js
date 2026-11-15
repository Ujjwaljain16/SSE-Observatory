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
        // Tagged proxy comments and X-SSE-* response headers. PROXY_DIAGNOSTICS=0 restores the original bare output.
        diagnostics: env.PROXY_DIAGNOSTICS !== '0',
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
/**
 * In development the proxy is open to private addresses, so a page that reaches it under another name (DNS rebinding: evil.example
 * resolving to 127.0.0.1) must not count as the app. Same-origin only means the page and this server share a name, so the name is
 * checked: loopback, or the host of a configured origin.
 */
function developmentHostIsOurs(req, cfg) {
    const raw = String(req.headers.host ?? '')
    let hostname
    try { hostname = new URL(`http://${raw}`).hostname.toLowerCase() } catch { return false }
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost')) return true
    return cfg.allowedOrigins.some((origin) => { try { return new URL(origin).host.toLowerCase() === raw.toLowerCase() } catch { return false } })
}

export function isTrustedBrowserRequest(req, cfg) {
    const site = req.headers['sec-fetch-site']
    if (site) {
        if (site !== 'same-origin' && !(!cfg.production && site === 'same-site')) return false
        return cfg.production || developmentHostIsOurs(req, cfg)
    }

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

/**
 * Tracks whether the bytes forwarded so far end exactly on an SSE event boundary: no line half written and no event half written, so the proxy
 * may put its own lines (a keep-alive comment, an `event: error` frame, `retry:`) into the stream without joining them to the producer's.
 * A comment line on its own is complete (the specification ignores it), so a stream that ends on `: keep-alive
` is at a boundary. This is the
 * same question as `SSEParser.atBoundary` and the two are tested against each other; it reads bytes, so it needs no decoding.
 */
const BOM = [0xef, 0xbb, 0xbf]
const EVENT_FIELDS = new Set(['event', 'data', 'id'])

export class FrameTracker {
    constructor() {
        this.atBoundary = true
        this.lineLength = 0 // bytes of the line being written
        this.lineIsComment = false
        this.fieldName = '' // the start of the line's field name, up to the colon (enough to tell the three that belong to an event)
        this.fieldDone = false
        this.eventStarted = false // an `event`, `data` or `id` line was completed and no blank line has followed
        this.skipLF = false // the last byte was CR: a following LF belongs to it
        this.bomSeen = 0 // bytes of a leading byte order mark matched so far (only at the start of the stream)
        this.started = false
    }
    push(chunk) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
        for (let i = 0; i < bytes.length; i++) this.#byte(bytes[i])
        // half a byte order mark is half a character: nothing may be written in the middle of it
        this.atBoundary = this.lineLength === 0 && !this.eventStarted && (this.started || this.bomSeen === 0)
    }
    #byte(b) {
        if (!this.started) {
            // "One leading U+FEFF BOM is removed" before anything else is read
            if (b === BOM[this.bomSeen]) { if (++this.bomSeen === BOM.length) this.started = true; return }
            this.started = true
            // a partial BOM was not one: its bytes are ordinary text of the first line
            if (this.bomSeen > 0) { this.lineLength = this.bomSeen; this.lineIsComment = false; this.fieldName = 'ï'; this.fieldDone = true; this.bomSeen = 0 }
        }
        if (this.skipLF) { this.skipLF = false; if (b === 0x0a) return }
        if (b === 0x0a || b === 0x0d) {
            if (b === 0x0d) this.skipLF = true
            if (this.lineLength === 0) this.eventStarted = false // a blank line ends the event (or is a stray one)
            // only these fields make up an event; `retry` and unknown fields leave the next dispatch as it was, so a line of theirs is a safe place to write
            else if (!this.lineIsComment && EVENT_FIELDS.has(this.fieldName)) this.eventStarted = true
            this.lineLength = 0
            this.lineIsComment = false
            this.fieldName = ''
            this.fieldDone = false
            return
        }
        if (this.lineLength === 0) this.lineIsComment = b === 0x3a
        if (!this.fieldDone) {
            if (b === 0x3a) this.fieldDone = true
            else if (this.fieldName.length < 6) this.fieldName += String.fromCharCode(b)
            else this.fieldDone = true // longer than any field that matters
        }
        this.lineLength++
    }
}

export function errorEvent(message, extra = {}) {
    return `event: error\ndata: ${JSON.stringify({ error: message, ...extra })}\n\n`
}
