import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRedactionPolicy, getRedactionPolicyText, setRedactionPolicy, subscribeRedactionPolicy } from '../redactionPolicyStore'
import { prepare } from '../artifacts'
import { localCapture } from '../../core/capture/build'
import type { CaptureRecord } from '../../core/capture/format'
import { capture as build, healthyStart } from '../../core/testing/captureBuilder'

beforeEach(() => { localStorage.clear(); setRedactionPolicy(undefined) })
afterEach(() => { vi.restoreAllMocks() })

describe('the saved redaction policy', () => {
    it('starts empty, keeps what is saved, and gives it back as editable text', () => {
        expect(getRedactionPolicy()).toBeUndefined()
        expect(getRedactionPolicyText()).toBe('')
        setRedactionPolicy({ extraKeys: ['ssn'], keepHeaders: ['x-request-id'] })
        expect(getRedactionPolicy()).toEqual({ extraKeys: ['ssn'], keepHeaders: ['x-request-id'] })
        expect(JSON.parse(getRedactionPolicyText())).toEqual({ version: 1, extraKeys: ['ssn'], keepHeaders: ['x-request-id'] })
        setRedactionPolicy(undefined)
        expect(getRedactionPolicy()).toBeUndefined()
    })

    it('returns the same object until the stored text changes', () => {
        setRedactionPolicy({ extraKeys: ['a'] })
        expect(getRedactionPolicy()).toBe(getRedactionPolicy())
    })

    it('ignores stored text that is not a valid policy, so the built-in rules apply alone', () => {
        for (const raw of ['{ nope', '[1]', JSON.stringify({ keepHeaders: ['Authorization'] }), JSON.stringify({ extraPatterns: [{ name: 'a', pattern: '(a+)+$' }] }), JSON.stringify({ x: 1 })]) {
            localStorage.setItem('sse.redaction.policy', raw)
            expect(getRedactionPolicy(), raw).toBeUndefined()
        }
    })

    it('tells subscribers, and another tab changing it', () => {
        const seen = vi.fn()
        const stop = subscribeRedactionPolicy(seen)
        setRedactionPolicy({ extraKeys: ['a'] })
        expect(seen).toHaveBeenCalledTimes(1)
        window.dispatchEvent(new StorageEvent('storage', { key: 'sse.redaction.policy' }))
        expect(seen).toHaveBeenCalledTimes(2)
        window.dispatchEvent(new StorageEvent('storage', { key: 'something.else' }))
        expect(seen).toHaveBeenCalledTimes(2)
        stop()
        setRedactionPolicy(undefined)
        expect(seen).toHaveBeenCalledTimes(2)
    })

    it('keeps it for this tab when the browser will not store it', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
        setRedactionPolicy({ extraKeys: ['ssn'] })
        expect(getRedactionPolicy()).toEqual({ extraKeys: ['ssn'] })
    })
})

describe('exports with the saved policy', () => {
    const records = (): CaptureRecord[] => {
        const b = healthyStart()
        b.chunk(40).comment(' ticket ACME-123456 raised by ops')
        b.frame('tick', '1')
        return b.observations() as CaptureRecord[]
    }
    const capture = () => localCapture(records(), { source: { kind: 'browser-app' }, request: { url: 'https://stream.test/e' } })

    it('replaces what the policy names in a shared capture and says so in the notes', () => {
        const plain = prepare('capture-shared', capture())
        expect(plain.text).toContain('ACME-123456')
        expect(plain.notes.join(' ')).not.toContain('your own')

        const withPolicy = prepare('capture-shared', capture(), { policy: { extraPatterns: [{ name: 'ticket', pattern: 'ACME-\\d{6}' }] } })
        expect(withPolicy.text).not.toContain('ACME-123456')
        expect(withPolicy.redaction?.byRule['ticket']).toBe(1)
        expect(withPolicy.notes.join(' ')).toContain('built-in rules plus your own: 1 extra pattern')
    })

    it('applies to every shareable kind, and never to the local capture', () => {
        const policy = { extraPatterns: [{ name: 'ticket', pattern: 'ACME-\\d{6}' }] }
        for (const kind of ['capture-shared', 'report-md', 'report-issue', 'report-html', 'report-json', 'scenario'] as const) {
            expect(prepare(kind, capture(), { policy }).text, kind).not.toContain('ACME-123456')
        }
        const local = prepare('capture-local', capture(), { policy })
        expect(local.text).toContain('ACME-123456') // the local capture is the recording as it is, and is labelled so
        expect(local.shareable).toBe(false)
    })

    it('has no policy effect for a capture with nothing to match', () => {
        const c = localCapture(build().connect().response().frame('tick', '1').observations() as CaptureRecord[], { source: { kind: 'browser-app' } })
        const a = prepare('capture-shared', c)
        const b = prepare('capture-shared', c, { policy: { extraKeys: ['ssn'] } })
        expect(b.redaction?.placeholders).toBe(a.redaction?.placeholders)
    })
})
