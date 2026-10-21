import { describe, expect, it } from 'vitest'
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

    it('copes with an empty recording and with time that passed since the last record', () => {
        expect(buildTimeline([]).connections).toEqual([])
        expect(buildTimeline(healthyStart().frame('tick', '1').observations(), 9000).endT).toBe(9000)
    })
})
