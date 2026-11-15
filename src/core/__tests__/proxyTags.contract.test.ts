import { describe, it, expect } from 'vitest'
import * as js from '../../../lib/proxy/diagTags.js'
import * as ts from '../proxyTags'

describe('proxy tag contract (lib/proxy/diagTags.js <-> src/core/proxyTags.ts)', () => {
    it('shares the same constants', () => {
        expect(ts.PROXY_COMMENT_PREFIX).toBe(js.PROXY_COMMENT_PREFIX)
        expect(ts.PING_TEXT).toBe(js.PING_TEXT)
        expect(ts.HEARTBEAT_TEXT_PREFIX).toBe(js.HEARTBEAT_TEXT_PREFIX)
        expect(ts.CAP_TEXT_PREFIX).toBe(js.CAP_TEXT_PREFIX)
        expect(ts.META_TEXT_PREFIX).toBe(js.META_TEXT_PREFIX)
        expect(ts.ERROR_TEXT_PREFIX).toBe(js.ERROR_TEXT_PREFIX)
        expect(ts.PROXY_ID).toBe(js.PROXY_ID)
        expect(ts.PROXY_HEADER).toEqual(js.HEADER)
    })

    it('every tag starts with the prefix the client uses to label proxy bytes', () => {
        for (const t of [js.PING_TEXT, js.HEARTBEAT_TEXT_PREFIX, js.CAP_TEXT_PREFIX, js.META_TEXT_PREFIX, js.ERROR_TEXT_PREFIX]) expect(t.startsWith(js.PROXY_COMMENT_PREFIX)).toBe(true)
    })

    const text = (wire: string) => wire.replace(/^: /, '').replace(/\n\n$/, '')

    it('parses what the proxy writes', () => {
        expect(ts.parseProxyComment(text(js.pingComment()))).toEqual({ kind: 'ping' })
        expect(ts.parseProxyComment(text(js.heartbeatComment(1234.6, 7)))).toEqual({ kind: 'hb', upIdleMs: 1235, n: 7 })
        expect(ts.parseProxyComment(text(js.capComment(55000)))).toEqual({ kind: 'cap', durationMs: 55000 })
        expect(ts.parseProxyComment(text(js.metaComment({ status: 200, note: 'a\nb' })))).toEqual({ kind: 'meta', meta: { status: 200, note: 'a\nb' } })
        expect(ts.parseProxyComment(text(js.errorComment('Upstream connection lost')))).toEqual({ kind: 'error', message: 'Upstream connection lost' })
    })

    it('the error notice is one comment line whatever the reason says (a newline or a carriage return in it cannot end the comment), and round-trips', () => {
        for (const reason of ['plain', 'two\nlines', 'a\r\nb', 'quote " and \\ backslash', '  separator', 'é\u{1F600}']) {
            const wire = js.errorComment(reason)
            expect(wire.endsWith('\n\n')).toBe(true)
            expect(wire.slice(0, -2)).not.toMatch(/[\r\n]/)
            expect(ts.parseProxyComment(text(wire))).toEqual({ kind: 'error', message: reason })
        }
    })

    it('returns null for foreign or malformed comments', () => {
        for (const t of ['keep-alive', 'sse-proxy hb up_idle=x n=1', 'sse-proxy-meta {bad', 'sse-proxy-meta [1]', 'hello', '', 'sse-proxy error {bad', 'sse-proxy error []', 'sse-proxy error {"error":5}', 'sse-proxy error {}', 'sse-proxy error']) expect(ts.parseProxyComment(t)).toBeNull()
    })

    it('an upstream comment that was rewritten by the proxy (Q15) is not a proxy tag, whatever it says', () => {
        for (const wire of [': sse-proxy hb up_idle=9 n=1\n\n', ':sse-proxy-ping\n\n', ': sse-proxy error {"error":"x"}\n\n']) {
            const escaped = new js.NamespaceEscaper().push(Buffer.from(wire)).toString()
            const body = escaped.replace(/^:/, '').replace(/\n\n$/, '').replace(/^ /, '')
            expect(body.startsWith(ts.PROXY_COMMENT_PREFIX)).toBe(false)
            expect(ts.parseProxyComment(body)).toBeNull()
        }
    })
})
