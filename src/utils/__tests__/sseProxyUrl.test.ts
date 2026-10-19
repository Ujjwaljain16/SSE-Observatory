import { describe, it, expect, vi, afterEach } from 'vitest'
import { authorizationHeader, buildSSERequest } from '../sseProxyUrl'

afterEach(() => vi.unstubAllGlobals())
const atOrigin = (origin: string) => vi.stubGlobal('location', { origin })

describe('authorizationHeader', () => {
    it('adds the Bearer scheme to a bare token and keeps explicit schemes', () => {
        expect(authorizationHeader('abc123')).toBe('Bearer abc123')
        expect(authorizationHeader('  abc123  ')).toBe('Bearer abc123')
        expect(authorizationHeader('Bearer abc123')).toBe('Bearer abc123')
        expect(authorizationHeader('Basic dXNlcjpwdw==')).toBe('Basic dXNlcjpwdw==')
        expect(authorizationHeader('Token xyz')).toBe('Token xyz')
        expect(authorizationHeader('')).toBeUndefined()
        expect(authorizationHeader(undefined)).toBeUndefined()
    })
})

describe('buildSSERequest', () => {
    it('relative URLs go straight to the same origin, with the auth header', () => {
        expect(buildSSERequest('/api/mock/stream?session=1', 'tok')).toEqual({
            url: '/api/mock/stream?session=1', headers: { Authorization: 'Bearer tok' }, credentials: 'same-origin',
        })
        expect(buildSSERequest('/x').headers).toEqual({})
    })

    it('absolute URLs on the app origin are requested as paths', () => {
        atOrigin('http://localhost:3001')
        expect(buildSSERequest('http://localhost:3001/events?a=1')).toMatchObject({ url: '/events?a=1', credentials: 'same-origin' })
    })

    it('external URLs use the proxy via POST; the token is in the body and never in the URL', () => {
        atOrigin('https://app.example')
        const r = buildSSERequest('https://api.other.com/stream?x=1', 'secret')
        expect(r.url).toBe('/api/sse')
        expect(r.method).toBe('POST')
        expect(r.headers).toEqual({ 'Content-Type': 'application/json' })
        expect(JSON.parse(r.body!)).toEqual({ url: 'https://api.other.com/stream?x=1', token: 'Bearer secret' })
        expect(r.url).not.toContain('secret')
    })

    it('proxy request without a token has no token field', () => {
        atOrigin('https://app.example')
        expect(JSON.parse(buildSSERequest('https://api.other.com/s').body!)).toEqual({ url: 'https://api.other.com/s' })
    })

    it('with the proxy switched off the browser calls the target directly and sends the header itself', () => {
        atOrigin('https://app.example')
        expect(buildSSERequest('https://api.other.com/s', 'tok', false)).toEqual({
            url: 'https://api.other.com/s', headers: { Authorization: 'Bearer tok' }, credentials: 'omit',
        })
    })
})
