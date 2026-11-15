import { describe, expect, it } from 'vitest'
import type { Observation } from '../../core/observe/observation'
import { buildTimeline, describeConnection } from '../timeline'
import { capture, healthyStart } from '../../core/testing/captureBuilder'

describe('buildTimeline', () => {
    it('gives a healthy stream one connection with its events and the longest wait between bytes', () => {
        const b = healthyStart()
        b.repeat(5, 1000, (x, i) => x.frame('tick', String(i + 1)))
        const t = buildTimeline(b.observations())
        expect(t.connections).toHaveLength(1)
        const c = t.connections[0]!
        expect(c.status).toBe(200)
        expect(c.events).toHaveLength(5)
        expect(c.firstEventT).toBe(1000)
        expect(c.endT).toBeUndefined() // still open
        expect(c.longestGapMs).toBe(1000)
        expect(describeConnection(c, t.endT)).toContain('still open')
    })

    it('shows each attempt of a reconnecting stream, the id it resumed from, and why the first one ended', () => {
        const b = healthyStart()
        b.repeat(3, 500, (x, i) => x.frame('tick', String(i + 1)))
        b.reconnect({ attempt: 1, delayMs: 2000, reason: 'Stream closed by server', lastEventIdSent: '3' })
        b.silence(2000).connect({ sentLastEventId: '3' }).response()
        b.repeat(2, 500, (x, i) => x.frame('tick', String(i + 4)))
        const t = buildTimeline(b.observations())
        expect(t.connections.map((c) => c.conn)).toEqual([0, 1])
        const [first, second] = t.connections as [typeof t.connections[0], typeof t.connections[0]]
        expect(first.endReason).toMatch(/closed by server/)
        expect(first.reconnectDelayMs).toBe(2000)
        expect(first.reconnectReason).toMatch(/closed by server/)
        expect(second.sentLastEventId).toBe('3')
        expect(second.events).toHaveLength(2)
        expect(second.endT).toBeUndefined()
        expect(describeConnection(second, t.endT)).toContain('resumed from id 3')
    })

    // Q18: the client's retry counter starts again after a connection that opened, so it cannot number the rows. Each row is numbered by
    // the connection it is (1, 2, 3, ...); the retry counter is its own field.
    describe('numbering: the connection number and the retry counter are separate', () => {
        /** The same capture the client writes: the connect record's `attempt` is the retry counter, which the builder does not restart. */
        const withRetryCounters = (records: Observation[], counters: number[]): Observation[] => {
            let i = 0
            return records.map((r) => (r.kind === 'connect' ? { ...r, attempt: counters[i++]! } : r))
        }

        it('numbers the rows 1, 2, 3, 4 when every connection opened and the retry counter restarted each time (f05-drops)', () => {
            const b = healthyStart()
            for (const last of ['3', '6', '9']) {
                b.repeat(3, 100, (x, i) => x.frame('tick', String(Number(last) - 2 + i)))
                b.reconnect({ attempt: 1, delayMs: 100, lastEventIdSent: last }).silence(100).connect({ sentLastEventId: last }).response()
            }
            b.repeat(3, 100, (x, i) => x.frame('tick', String(10 + i)))
            const t = buildTimeline(withRetryCounters(b.observations(), [0, 1, 1, 1]))
            expect(t.connections.map((c) => c.number)).toEqual([1, 2, 3, 4])
            expect(t.connections.map((c) => c.retry)).toEqual([0, 1, 1, 1])
            expect(t.connections.map((c) => c.sentLastEventId)).toEqual(['', '3', '6', '9'])
            const sentences = t.connections.map((c) => describeConnection(c, t.endT))
            expect(sentences[2]).toMatch(/^connection 3, retry 1,/)
            expect(sentences[2]).not.toMatch(/attempt/)
            expect(sentences[0]).toMatch(/^connection 1, retry 0,/)
        })

        it('numbers the rows by connection, not by the counter, when the retries pile up and then restart', () => {
            const b = capture().connect().response({ status: 503 })
            b.silence(10).connect().response({ status: 503 }) // retry 1
            b.silence(10).connect().response() // retry 2: opens
            b.frame('tick', '1')
            b.silence(10).connect().response() // the counter restarted: retry 1 again
            const t = buildTimeline(withRetryCounters(b.observations(), [0, 1, 2, 1]))
            expect(t.connections.map((c) => c.number)).toEqual([1, 2, 3, 4])
            expect(t.connections.map((c) => c.retry)).toEqual([0, 1, 2, 1])
        })

        it('keeps the true connection number when the recording starts after the first connections', () => {
            const b = healthyStart().frame('tick', '1')
            b.silence(10).connect().response().frame('tick', '2')
            b.silence(10).connect().response().frame('tick', '3')
            const all = b.observations()
            const later = all.filter((r) => r.conn >= 1) // the first connection's records are gone
            expect(buildTimeline(later).connections.map((c) => c.number)).toEqual([2, 3])
        })
    })

    it('counts heartbeats by source and keeps a failed connection that never opened', () => {
        const b = capture().connect().response({ status: 502 })
        b.silence(10).connect().response()
        b.beat('proxy').beat('upstream')
        const t = buildTimeline(b.observations())
        expect(t.connections).toHaveLength(2)
        expect(t.connections[0]!.status).toBe(502)
        expect(t.connections[0]!.events).toHaveLength(0)
        expect(t.connections[1]!.heartbeats.map((h) => h.source)).toEqual(['proxy', 'upstream'])
    })

    // Q16: the proxy's notice that the upstream connection was lost is a comment; the timeline keeps its reason on the connection it ended, and does not draw it as a heartbeat.
    it('keeps the proxy\'s error notice as the reason on the connection it ended, not as a heartbeat', () => {
        const b = healthyStart()
        b.frame('tick', '1').beat('proxy', 'sse-proxy hb up_idle=5 n=1').beat('proxy', 'sse-proxy error {"error":"Upstream connection lost"}')
        b.reconnect({ attempt: 1, delayMs: 100, reason: 'Stream closed by server', lastEventIdSent: '1' })
        b.silence(100).connect({ sentLastEventId: '1' }).response().frame('tick', '2')
        const t = buildTimeline(b.observations())
        const [first, second] = t.connections as [typeof t.connections[0], typeof t.connections[0]]
        expect(first.proxyNotice).toBe('Upstream connection lost')
        expect(first.heartbeats.map((h) => h.source)).toEqual(['proxy'])
        expect(describeConnection(first, t.endT)).toContain('the proxy said: Upstream connection lost')
        expect(second.proxyNotice).toBeUndefined()
        expect(describeConnection(second, t.endT)).not.toContain('the proxy said')
    })

    it('copes with an empty recording and with time that passed since the last record', () => {
        expect(buildTimeline([]).connections).toEqual([])
        expect(buildTimeline(healthyStart().frame('tick', '1').observations(), 9000).endT).toBe(9000)
    })
})
