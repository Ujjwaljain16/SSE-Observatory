/**
 * A capture made through the app's server proxy does not carry the stream's address: the app asked its own `POST /api/sse`, and the address
 * travelled in the body, which is never recorded (it may hold a secret). The request in such a capture is therefore a relative path with no
 * target, which no command can run. These helpers recognise that case so every artifact can say so plainly instead of printing a path that
 * looks like a reproduction and is not.
 */

import type { RedactedCapture } from '../redacted'
import { PROXY_HEADER } from '../../proxyTags'
import { ofKind } from './records'

/** The path the app asks for when "Use Server Proxy" is on (the app's request builder, sseProxyUrl). */
export const APP_PROXY_PATH = '/api/sse'

/** One sentence, shared by the curl comment, the report, the issue body and the scenario note, so they cannot drift apart. */
export const PROXIED_CAPTURE_NOTE = "This stream went through the app's server proxy, so its address was not recorded (it may carry a secret). Set STREAM_URL to the address you gave the app."

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i

/** The request's URL, from the header or, failing that, the first connect record. */
export function requestUrlOf(capture: RedactedCapture): string {
    return capture.header.request?.url ?? ofKind(capture.records, 'connect')[0]?.url ?? ''
}

/**
 * True when the capture was made through the app's own proxy: its request has no address of its own (a relative path or nothing) and it is the
 * app's proxy path, or the response carries the proxy's `X-SSE-Proxy` header. A request with an absolute URL is a real address and is kept as it
 * is, wherever it went (the command line's own captures are of that kind).
 */
export function isProxiedCapture(capture: RedactedCapture): boolean {
    const url = requestUrlOf(capture).trim()
    if (ABSOLUTE_URL.test(url) || url.startsWith('//')) return false
    const path = url.split(/[?#]/, 1)[0]!
    if (path === APP_PROXY_PATH) return true
    const marker = PROXY_HEADER.proxy.toLowerCase()
    return ofKind(capture.records, 'response').some((r) => Object.keys(r.headers).some((h) => h.toLowerCase() === marker))
}
