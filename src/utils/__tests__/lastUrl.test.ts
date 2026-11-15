import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LAST_URL_KEY, isRememberableUrl, readLastUrl, rememberLastUrl } from '../lastUrl'

beforeEach(() => localStorage.clear())

describe('isRememberableUrl', () => {
    it.each([
        'https://api.example.com/sse',
        'http://localhost:4000/api/stream?freq=1',
        'https://x.test/events?channel=orders&limit=50',
        'https://x.test/events?since=2026-11-16',
    ])('accepts %s', (url) => expect(isRememberableUrl(url)).toBe(true))

    it.each([
        ['userinfo with a password', 'https://user:hunter2@x.test/sse'],
        ['userinfo with a name only', 'https://user@x.test/sse'],
        ['a token parameter', 'https://x.test/sse?token=abc'],
        ['an access_token parameter', 'https://x.test/sse?access_token=abc'],
        ['an api key parameter', 'https://x.test/sse?apiKey=abc'],
        ['a secret parameter', 'https://x.test/sse?client_secret=abc'],
        ['a password parameter', 'https://x.test/sse?password=abc'],
        ['an auth parameter', 'https://x.test/sse?Authorization=abc'],
        ['a signature parameter', 'https://x.test/sse?sig=abc'],
        ['a long value under an innocent name', 'https://x.test/sse?room=0123456789abcdef0123'],
        ['a secret in the fragment', 'https://x.test/sse#access_token=abc'],
    ])('refuses %s', (_label, url) => expect(isRememberableUrl(url)).toBe(false))

    it('accepts a value one character short of the long-value limit and refuses one at the limit', () => {
        expect(isRememberableUrl(`https://x.test/sse?room=${'a'.repeat(19)}`)).toBe(true)
        expect(isRememberableUrl(`https://x.test/sse?room=${'a'.repeat(20)}`)).toBe(false)
    })

    it('refuses an empty or blank value', () => {
        expect(isRememberableUrl('')).toBe(false)
        expect(isRememberableUrl('   ')).toBe(false)
    })
})

describe('rememberLastUrl / readLastUrl', () => {
    it('stores a safe URL (trimmed) and reads it back', () => {
        rememberLastUrl('  https://x.test/sse  ')
        expect(localStorage.getItem(LAST_URL_KEY)).toBe('https://x.test/sse')
        expect(readLastUrl()).toBe('https://x.test/sse')
    })

    it('does not store a URL that carries credentials, and forgets the earlier one rather than keep a stale address', () => {
        rememberLastUrl('https://x.test/sse')
        rememberLastUrl('https://u:p@x.test/sse')
        expect(localStorage.getItem(LAST_URL_KEY)).toBeNull()
        expect(readLastUrl()).toBe('')
        rememberLastUrl('https://x.test/sse?token=abc')
        expect(localStorage.length).toBe(0)
    })

    it('reads nothing when nothing is stored, and never returns a stored value that is unsafe', () => {
        expect(readLastUrl()).toBe('')
        localStorage.setItem(LAST_URL_KEY, 'https://x.test/sse?token=abc') // written by something else
        expect(readLastUrl()).toBe('')
    })

    it('survives storage that throws', () => {
        const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
        const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
        expect(readLastUrl()).toBe('')
        expect(() => rememberLastUrl('https://x.test/sse')).not.toThrow()
        get.mockRestore()
        set.mockRestore()
    })
})
