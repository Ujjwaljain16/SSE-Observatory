import { describe, expect, it } from 'vitest'
import { StreamModel } from '../streamModel'
import { DEFAULT_THRESHOLDS } from '../thresholds'
import { capture } from '../../testing/captureBuilder'

// Q16: the proxy's notice that the upstream connection was lost is a comment (`sse-proxy error {...}`). It is the proxy speaking, so it makes the
// connection a proxied one and counts as a proxy comment; but it is a notice, not a heartbeat, so it must not feed the proxy's heartbeat rhythm
// (R10's "proxy heartbeats stopped" and R13's tags) as if the proxy were still beating.

function modelOf(records: ReturnType<ReturnType<typeof capture>['build']>): StreamModel {
    const model = new StreamModel(DEFAULT_THRESHOLDS)
    for (const r of records) model.update(r)
    return model
}

describe('the proxy\'s error notice in the stream model', () => {
    const notice = 'sse-proxy error {"error":"Upstream connection lost"}'

    it('is a proxy comment but not a proxy heartbeat', () => {
        const model = modelOf(capture().connect().response().frame('tick', '1').beat('proxy', notice).build())
        expect(model.conn(0)!.comments.proxy).toBe(1)
        expect(model.conn(0)!.sawProxy).toBe(true)
        expect(model.heartbeats.proxy.count).toBe(0)
    })

    it('control: a real proxy heartbeat, a ping and the cap tag behave as before (heartbeat, heartbeat, not a heartbeat)', () => {
        const hb = modelOf(capture().connect().response().beat('proxy', 'sse-proxy hb up_idle=5 n=1').build())
        expect(hb.heartbeats.proxy.count).toBe(1)
        const ping = modelOf(capture().connect().response().beat('proxy', 'sse-proxy-ping').build())
        expect(ping.heartbeats.proxy.count).toBe(1)
        const cap = modelOf(capture().connect().response().beat('proxy', 'sse-proxy cap duration=9').build())
        expect(cap.heartbeats.proxy.count).toBe(0)
    })
})
