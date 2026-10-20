export const PROXY_COMMENT_PREFIX: string
export const PING_TEXT: string
export const HEARTBEAT_TEXT_PREFIX: string
export const CAP_TEXT_PREFIX: string
export const META_TEXT_PREFIX: string
export const LEGACY_KEEPALIVE_TEXT: string
export const PROXY_ID: string
export const HEADER: {
    proxy: string
    heartbeatMs: string
    maxDuration: string
    upstreamStatus: string
    upstreamContentType: string
    upstreamEncoding: string
    upstreamTtfbMs: string
}
export function pingComment(): string
export function legacyKeepAliveComment(): string
export function heartbeatComment(upIdleMs: number, n: number): string
export function capComment(durationMs: number): string
export function metaComment(meta: object): string
export function headerSafe(value: unknown): string
export function diagnosticHeaders(d: {
    status: number
    contentType: string
    encoding: string
    ttfbMs: number
    heartbeatMs: number
    maxDurationMs: number
}): Record<string, string>
