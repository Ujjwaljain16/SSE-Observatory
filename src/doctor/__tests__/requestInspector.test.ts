import { describe, expect, it } from 'vitest'
import { describeRequest, inspectRequests } from '../requestInspector'
import { capture, healthyStart } from '../../core/testing/captureBuilder'

describe('inspectRequests', () => {
    it('reports the request, the response, the kept headers and the time to each stage', () => {
        const b = capture().at(100).connect({ url: 'http://stream.test/events?token=[redacted]', headerNames: ['accept', 'authorization'] })
        b.silence(40).response({ headers: { via: '1.1 proxy' }, ttfbMs: 38 })
        b.silence(60).chunk(30)
        b.silence(200).event('tick', '1')
        const [r] = inspectRequests(b.observations(), 1000)
        expect(r).toMatchObject({ conn: 0, method: 'GET', url: 'http://stream.test/events?token=[redacted]', requestHeaderNames: ['accept', 'authorization'], open: true, chunks: 1, events: 1, ttfbMs: 38 })
        expect(r!.response).toMatchObject({ status: 200, contentType: 'text/event-stream', redirected: false })
        expect(Object.fromEntries(r!.response!.headers)).toMatchObject({ via: '1.1 proxy', 'cache-control': 'no-cache' })
        expect(r!.timing).toEqual({ headersMs: 40, firstByteMs: 100, firstEventMs: 300, totalMs: 900 })
    })

    it('has one entry per attempt, with the id each one resumed from and why the earlier one ended', () => {
        const b = healthyStart()
        b.repeat(2, 500, (x, i) => x.frame('tick', String(i + 1)))
        b.retry(3000)
        b.phase('reconnecting', { attempt: 1, delayMs: 2000, reason: 'Stream closed by server' })
        b.silence(2000).connect({ sentLastEventId: '2' }).response()
        const [first, second] = inspectRequests(b.observations(), 5000)
        expect(first!.sentLastEventId).toBe('')
        expect(first!.open).toBe(false)
        expect(first!.endReason).toMatch(/closed by server/)
        expect(first!.serverRetryMs).toBe(3000)
        expect(second!.sentLastEventId).toBe('2')
        expect(second!.open).toBe(true)
    })

    it('keeps an attempt that never got a response, without inventing timings for it', () => {
        const b = capture().connect()
        b.silence(5000).phase('error', { attempt: 0, reason: 'connection refused' })
        const [r] = inspectRequests(b.observations(), 6000)
        expect(r!.response).toBeUndefined()
        expect(r!.timing).toEqual({ totalMs: 5000 })
        expect(r!.open).toBe(false)
        expect(describeRequest(r!)).toContain('no response')
    })

    it('says what a recording with no request in it holds, and survives an empty recording', () => {
        expect(inspectRequests([], 0)).toEqual([])
        const b = capture()
        b.event('tick')
        expect(describeRequest(inspectRequests(b.observations(), 10)[0]!)).toContain('(no request recorded)')
    })

    it('says when the request went to the app\'s own proxy, by its URL or by its tags', () => {
        const byUrl = capture().connect({ url: 'http://localhost:3001/api/sse', method: 'POST' }).response()
        expect(inspectRequests(byUrl.observations(), 10)[0]!.viaAppProxy).toBe(true)
        const byTag = capture().connect({ url: 'https://app.example.com/relay' }).response({ headers: { 'x-sse-proxy': '1' } })
        expect(inspectRequests(byTag.observations(), 10)[0]!.viaAppProxy).toBe(true)
        const direct = capture().connect({ url: 'http://stream.test/api/sse-events' }).response()
        expect(inspectRequests(direct.observations(), 10)[0]!.viaAppProxy).toBe(false)
    })

    it('words a resumed request', () => {
        const b = capture().connect({ url: 'http://x.test/s', sentLastEventId: '41' }).response({ status: 200 })
        expect(describeRequest(inspectRequests(b.observations(), 10)[0]!)).toBe('GET http://x.test/s → 200 text/event-stream → resumed from id 41')
    })
})
