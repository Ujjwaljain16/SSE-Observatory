// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { newHeader, serializeCapture, type Capture } from '../format'
import { redactCapture } from '../redact'
import { analyze } from '../../diagnostics/engine'
import { healthyStart } from '../../testing/captureBuilder'
import { shapeOfValue } from '../../observe/payloadShape'

const SENSITIVE = { id: 1, password: 'hunter2-canary', token: 'abc', api_key: 'x', authorization: 'y', note: 'ok' }

function captureWith(payloads: unknown[]): Capture {
    const b = healthyStart()
    for (let i = 0; i < payloads.length; i++) b.silence(100).frame('tick', '')
    let i = 0
    const records = b.build().map((r) => (r.kind === 'event' ? { ...r, extracted: { shape: shapeOfValue(payloads[i++]) } } : r))
    return { header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }), records } as Capture
}

describe('payload shapes in a redacted capture', () => {
    it('are kept as they were, even when a field is named like a secret: the name is not the secret', () => {
        const { capture } = redactCapture(captureWith([SENSITIVE, SENSITIVE]))
        const shapes = capture.records.filter((r) => r.kind === 'event').map((r) => (r as { extracted?: { shape?: string } }).extracted?.shape)
        expect(shapes).toEqual([shapeOfValue(SENSITIVE), shapeOfValue(SENSITIVE)])
    })

    it('hold no value, so the redacted file has none of the values of the payload', () => {
        const text = serializeCapture(redactCapture(captureWith([SENSITIVE])).capture)
        expect(text).not.toContain('hunter2-canary')
    })

    it('still give the same drift finding after redaction as before it', () => {
        const before = captureWith([...Array(20).fill(SENSITIVE), ...Array(10).fill({ id: 1, note: 'ok' })])
        const after = redactCapture(before).capture
        const drift = (c: Capture) => analyze(c.records as never, { endT: c.records.at(-1)!.t }).findings.filter((f) => f.ruleId === 'schema.drift').map((f) => f.summary)
        expect(drift(before).length).toBe(1)
        expect(drift(after)).toEqual(drift(before))
    })

    it('redacting twice changes nothing more', () => {
        const once = redactCapture(captureWith([SENSITIVE, SENSITIVE])).capture
        const twice = redactCapture(once).capture
        expect(serializeCapture(twice).split('\n').slice(1, -1)).toEqual(serializeCapture(once).split('\n').slice(1, -1))
    })
})
