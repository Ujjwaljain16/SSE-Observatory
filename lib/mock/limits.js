// Abuse limits for the mock API. The Express server has its own rate limiter, but the Vercel functions do not, and a public
// upload endpoint that stores data and holds streams open needs them: a per-client request rate and a global hourly budget.

const MB = 1024 * 1024

const int = (raw, fallback) => {
    const n = Number.parseInt(raw ?? '', 10)
    return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Limits from the environment; 0 turns a limit off. */
export function loadLimits(env = process.env) {
    return {
        uploadsPerMinute: int(env.MOCK_UPLOADS_PER_MINUTE, 20),
        streamsPerMinute: int(env.MOCK_STREAMS_PER_MINUTE, 60),
        sessionsPerHour: int(env.MOCK_SESSIONS_PER_HOUR, 500),
        bytesPerHour: int(env.MOCK_MB_PER_HOUR, 50) * MB,
    }
}

/** The caller's address. Forwarding headers are believed only on Vercel, which sets them itself. */
export function clientIp(req, env = process.env) {
    if (env.VERCEL) {
        const real = req.headers['x-real-ip']
        const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim()
        const ip = (typeof real === 'string' && real.trim()) || forwarded
        if (ip) return ip.slice(0, 64)
    }
    return String(req.ip ?? req.socket?.remoteAddress ?? 'unknown').slice(0, 64)
}

function denied(reason, retryAfterSec) {
    return { ok: false, reason, retryAfterSec: Math.max(1, Math.ceil(retryAfterSec)) }
}

/**
 * Counts one request against the per-client limit for `kind` ('upload' | 'stream').
 * Fails open when the counter store is unreachable: the store failing is reported by the handler itself.
 */
export async function checkRate({ store, limits, kind, ip, now = Date.now() }) {
    const max = kind === 'upload' ? limits.uploadsPerMinute : limits.streamsPerMinute
    if (!max) return { ok: true }
    const window = Math.floor(now / 60_000)
    try {
        const used = await store.counter(`mock:rl:${kind}:${ip}:${window}`, 1, 120)
        if (used > max) return denied(`Too many ${kind}s: at most ${max} per minute per client`, (window + 1) * 60 - now / 1000)
    } catch (err) {
        console.error('[mock] rate counter unavailable:', err?.message)
    }
    return { ok: true }
}

/** Counts one stored session of `bytes` against the global hourly budget (sessions and bytes). */
export async function checkBudget({ store, limits, bytes, now = Date.now() }) {
    const hour = Math.floor(now / 3_600_000)
    const retry = (hour + 1) * 3600 - now / 1000
    try {
        if (limits.sessionsPerHour) {
            const n = await store.counter(`mock:g:sessions:${hour}`, 1, 7200)
            if (n > limits.sessionsPerHour) return denied('The mock API has reached its hourly upload budget; try again later', retry)
        }
        if (limits.bytesPerHour) {
            const b = await store.counter(`mock:g:bytes:${hour}`, bytes, 7200)
            if (b > limits.bytesPerHour) return denied('The mock API has reached its hourly storage budget; try again later', retry)
        }
    } catch (err) {
        console.error('[mock] budget counter unavailable:', err?.message)
    }
    return { ok: true }
}
