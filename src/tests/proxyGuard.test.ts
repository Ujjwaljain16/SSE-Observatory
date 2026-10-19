// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
    FrameTracker, GuardError, hostAllowed, isPrivateAddress, isTrustedBrowserRequest,
    loadConfig, normalizeIp, parseTargetUrl, pinnedLookup, resolveTarget,
} from '../../lib/proxy/guard.js'

const prod = loadConfig({ NODE_ENV: 'production' })
const dev = loadConfig({})

describe('isPrivateAddress (SSRF filter)', () => {
    const blocked = [
        '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
        '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '198.18.0.1',
        '::1', '::', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '[::1]',
        'fc00::1', 'fc01::1', 'fd12:3456::1', 'fe80::1', 'fe90::1', 'febf::1', 'ff02::1',
        '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:db8::1', 'not-an-ip', '',
    ]
    const allowed = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '2606:4700:4700::1111', '::ffff:8.8.8.8', '93.184.216.34']

    it.each(blocked)('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true))
    it.each(allowed)('allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false))

    it('unwraps IPv4-mapped IPv6 in both notations', () => {
        expect(normalizeIp('::FFFF:7f00:1')).toBe('127.0.0.1')
        expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3')
        expect(normalizeIp('[fe80::1%eth0]')).toBe('fe80::1')
    })
})

describe('parseTargetUrl / resolveTarget', () => {
    it('rejects bad schemes, garbage and embedded credentials', () => {
        for (const bad of ['file:///etc/passwd', 'gopher://x', 'ftp://x/y', 'not a url', 'http://user:pw@example.com/']) {
            expect(() => parseTargetUrl(bad)).toThrow(GuardError)
        }
    })

    it('blocks when ANY resolved address is private (multi-record rebinding trick)', async () => {
        const resolve = async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 }]
        await expect(resolveTarget(parseTargetUrl('https://evil.example/'), { resolve })).rejects.toMatchObject({ status: 403 })
    })

    it('blocks IP-literal and mapped-IPv6 literal URLs', async () => {
        for (const u of ['http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:169.254.169.254]/', 'http://2130706433/', 'http://0x7f.1/']) {
            await expect(resolveTarget(parseTargetUrl(u))).rejects.toMatchObject({ status: 403 })
        }
    })

    it('fails closed when DNS fails', async () => {
        const resolve = async () => { throw new Error('ENOTFOUND') }
        await expect(resolveTarget(parseTargetUrl('https://nope.example/'), { resolve })).rejects.toMatchObject({ status: 502 })
    })

    it('returns the pinned address for public hosts and honours allowPrivate', async () => {
        const resolve = async () => [{ address: '93.184.216.34', family: 4 }]
        await expect(resolveTarget(parseTargetUrl('https://example.com/'), { resolve })).resolves.toEqual({ address: '93.184.216.34', family: 4 })
        await expect(resolveTarget(parseTargetUrl('http://127.0.0.1:9/'), { allowPrivate: true })).resolves.toMatchObject({ address: '127.0.0.1' })
    })

    it('pinnedLookup answers with the validated address in both callback shapes', () => {
        const lookup = pinnedLookup('93.184.216.34', 4)
        lookup('anything', {}, (_e: unknown, a: unknown, f: unknown) => expect([a, f]).toEqual(['93.184.216.34', 4]))
        lookup('anything', { all: true }, (_e: unknown, list: unknown) => expect(list).toEqual([{ address: '93.184.216.34', family: 4 }]))
    })
})

describe('hostAllowed', () => {
    it('matches exact hosts and wildcard suffixes only', () => {
        const rules = ['api.example.com', '*.stream.test']
        expect(hostAllowed('API.example.com', rules)).toBe(true)
        expect(hostAllowed('a.stream.test', rules)).toBe(true)
        expect(hostAllowed('stream.test', rules)).toBe(false)
        expect(hostAllowed('evilstream.test', rules)).toBe(false)
        expect(hostAllowed('api.example.com.evil.io', rules)).toBe(false)
    })
})

describe('isTrustedBrowserRequest', () => {
    const req = (headers: Record<string, string>) => ({ headers })
    it('production: requires same-origin fetch metadata or a matching Origin/Referer', () => {
        expect(isTrustedBrowserRequest(req({ 'sec-fetch-site': 'same-origin' }), prod)).toBe(true)
        expect(isTrustedBrowserRequest(req({ 'sec-fetch-site': 'cross-site' }), prod)).toBe(false)
        expect(isTrustedBrowserRequest(req({ 'sec-fetch-site': 'same-site' }), prod)).toBe(false)
        expect(isTrustedBrowserRequest(req({}), prod)).toBe(false)
        expect(isTrustedBrowserRequest(req({ origin: 'https://app.test', host: 'app.test' }), prod)).toBe(true)
        expect(isTrustedBrowserRequest(req({ referer: 'https://app.test/page?x=1', host: 'app.test' }), prod)).toBe(true)
        expect(isTrustedBrowserRequest(req({ origin: 'https://evil.com/?localhost:', host: 'app.test' }), prod)).toBe(false)
        expect(isTrustedBrowserRequest(req({ origin: 'http://localhost:3001', host: 'app.test' }), prod)).toBe(false)
        expect(isTrustedBrowserRequest(req({ origin: 'null', host: 'app.test' }), prod)).toBe(false)
    })
    it('production: honours PROXY_ALLOWED_ORIGINS exactly', () => {
        const cfg = loadConfig({ NODE_ENV: 'production', PROXY_ALLOWED_ORIGINS: 'https://partner.test' })
        expect(isTrustedBrowserRequest(req({ origin: 'https://partner.test' }), cfg)).toBe(true)
        expect(isTrustedBrowserRequest(req({ origin: 'https://partner.test.evil.io' }), cfg)).toBe(false)
    })
    it('development: allows tooling and localhost origins', () => {
        expect(isTrustedBrowserRequest(req({}), dev)).toBe(true)
        expect(isTrustedBrowserRequest(req({ origin: 'http://localhost:3001' }), dev)).toBe(true)
        expect(isTrustedBrowserRequest(req({ origin: 'https://evil.com' }), dev)).toBe(false)
    })
})

describe('loadConfig', () => {
    it('is closed-by-default in production and open in development', () => {
        expect(prod.open).toBe(false)
        expect(prod.allowPrivate).toBe(false)
        expect(prod.mockEnabled).toBe(false)
        expect(dev.open).toBe(true)
        expect(loadConfig({ NODE_ENV: 'production', PROXY_OPEN: '1' }).open).toBe(true)
        expect(loadConfig({ VERCEL: '1' }).production).toBe(true)
        expect(loadConfig({ VERCEL: '1' }).maxDurationMs).toBe(55_000)
    })
})

describe('FrameTracker', () => {
    it('knows when output ends exactly on an event boundary', () => {
        const t = new FrameTracker()
        expect(t.atBoundary).toBe(true)
        t.push('data: {"a":'); expect(t.atBoundary).toBe(false)
        t.push('1}\n'); expect(t.atBoundary).toBe(false)
        t.push('\n'); expect(t.atBoundary).toBe(true)
        t.push('data: x\r\n'); expect(t.atBoundary).toBe(false)
        t.push('\r'); expect(t.atBoundary).toBe(true) // bare CR terminates the blank line (per SSE spec)
        t.push('\n'); expect(t.atBoundary).toBe(true) // ...and a following LF is part of the same CRLF
        t.push('data: z\r'); expect(t.atBoundary).toBe(false)
        t.push('\n\r\n'); expect(t.atBoundary).toBe(true) // CRLF CRLF split across chunks
        t.push(': comment\n\n'); expect(t.atBoundary).toBe(true)
        t.push(Buffer.from('data: y\n')); expect(t.atBoundary).toBe(false)
    })
})
