import { describe, expect, it } from 'vitest'
import { ARTIFACTS, prepare, type ArtifactKind } from '../artifacts'
import { localCapture } from '../../core/capture/build'
import type { Capture, CaptureRecord } from '../../core/capture/format'
import { canaries, survivors, type Canary } from '../../core/testing/canaries'

// Campaign E1, the Doctor's side: every way the Doctor lets data leave (each shareable export, in each form) searched for planted secrets. A
// secret that survives into anything shareable is a release blocker. Class R must be gone in every encoding; class F (a random token in free text,
// which no rule can know is a secret) must be flagged by the residual scan without being printed; class L (a low-entropy sentence) is a documented
// limit: it survives and is not flagged, pinned so the limit stays written down.

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const wire = (text: string): CaptureRecord => ({ seq: 0, t: 0, conn: 0, kind: 'chunk', bytes: Buffer.byteLength(text), b64: b64(text) }) as never

/** A recording that has every R canary somewhere real, plus a finding to reproduce (the response is not an event stream). */
function plant(c: Record<string, Canary>, only?: string[]): Capture {
    const on = (k: string) => !only || only.includes(k)
    const v = (k: string) => (on(k) ? c[k]!.value : 'nothing-secret')
    const secret = (k: string) => v(k).replace(/^(Bearer|Basic)\s+/i, '').replace(/^sid=/, '')
    const jwtSplitAt = Math.floor(c['jwtInPayload']!.value.length / 2)
    const text1 = `id: ${v('jwtInId')}\nevent: tick\ndata: ${JSON.stringify({ user: { name: 'ada', password: secret('passwordNested') }, items: [{ token: secret('tokenInArray'), n: 1 }], note: `session ${on('freeToken') ? c['freeToken']!.value : 'x'}` })}\n\n`
    const text2 = `: api_key=${secret('keyValueComment')}\n: ${on('sentence') ? c['sentence']!.value : 'hello'}\n\ndata: {"jwt":"${v('jwtInPayload').slice(0, jwtSplitAt)}`
    const text3 = `${v('jwtInPayload').slice(jwtSplitAt)}"}\n\n`
    // the same address as the request, with its credentials, because the header's copy is cleared when the capture is built but a record's is not
    const address = `https://ada:${secret('userinfo')}@stream.test/events?token=${secret('urlToken')}&api_key=${secret('urlApiKey')}&room=7`
    const records = ([
        { seq: 0, t: 0, conn: 0, kind: 'connect', attempt: 0, url: address, method: 'GET', headerNames: ['accept', 'authorization', 'cookie', 'x-api-key'], sentLastEventId: '' },
        { seq: 1, t: 5, conn: 0, kind: 'response', status: 200, contentType: 'text/html', redirected: false, headers: { 'content-type': 'text/html', 'set-cookie': v('setCookie') }, ttfbMs: 5 },
        { ...wire(text1), seq: 2, t: 10 },
        { seq: 3, t: 10, conn: 0, kind: 'event', event: 'tick', sseId: v('jwtInId'), dataBytes: 40 },
        { ...wire(text2), seq: 4, t: 20 },
        { ...wire(text3), seq: 5, t: 30 },
        { seq: 6, t: 30, conn: 0, kind: 'event', event: 'message', sseId: '', dataBytes: 40 },
    ] as unknown) as CaptureRecord[]
    return localCapture(records, {
        source: { kind: 'browser-app', client: 'browser-fetch' },
        request: {
            url: `https://ada:${secret('userinfo')}@stream.test/events?token=${secret('urlToken')}&api_key=${secret('urlApiKey')}&room=7`,
            headers: { Authorization: v('authorization'), authorization: v('authorization'), Cookie: v('cookie'), 'X-Api-Key': v('apiKey'), 'Proxy-Authorization': v('proxyAuth'), accept: 'text/event-stream' },
        },
        captureId: 'canary-0001',
    })
}

const SHAREABLE = ARTIFACTS.filter((a) => a.shareable).map((a) => a.kind as ArtifactKind)
const R_CANARIES = (c: Record<string, Canary>): Canary[] => Object.values(c).filter((x) => x.cls === 'R' && x.placement !== 'unused')

function everyShareable(capture: Capture) {
    const outputs: Array<{ kind: string; text: string; residual: number }> = []
    for (const kind of SHAREABLE) {
        const p = prepare(kind, capture, kind === 'repro' ? { findingKey: 'proto.content-type' } : {})
        outputs.push({ kind, text: p.text, residual: p.residual.length })
        if (kind === 'curl') { const ps = prepare('curl', capture, { shell: 'powershell' }); outputs.push({ kind: 'curl (powershell)', text: ps.text, residual: ps.residual.length }) }
    }
    return outputs
}

describe('E1 (Doctor): what leaves the Doctor holds none of what was planted', () => {
    const c = canaries(7)
    const capture = plant(c)
    const outputs = everyShareable(capture)

    it('covers every shareable export, the smallest capture included (the old canary loop left it out), and both curl shells', () => {
        expect(outputs.map((o) => o.kind).sort()).toEqual([...SHAREABLE, 'curl (powershell)'].sort())
        expect(SHAREABLE).toContain('repro')
    })

    it('the planted recording really holds every canary (a sweep over a recording with nothing in it proves nothing)', () => {
        const local = prepare('capture-local', capture).text
        const raw = [local, Buffer.from(local).toString('latin1')].join('\n')
        // the wire text is base64 inside a local capture; decode every chunk to look inside
        const decoded = capture.records.map((r) => ((r as { b64?: string }).b64 ? Buffer.from((r as { b64: string }).b64, 'base64').toString('utf8') : '')).join('') // joined as the wire was, so the JWT split across two chunks is whole again
        for (const k of R_CANARIES(c)) expect(survivors(raw + '\n' + decoded, k).length, `${k.placement} is in the planted recording`).toBeGreaterThan(0)
    })

    for (const kind of [...SHAREABLE, 'curl (powershell)']) {
        it(`${kind}: no class R canary survives, in any form (as written, percent-encoded, base64, base64url, JSON-escaped)`, () => {
            const out = outputs.find((o) => o.kind === kind)!
            const found = R_CANARIES(c).map((k) => ({ k, forms: survivors(out.text, k) })).filter((x) => x.forms.length > 0)
            expect(found.map((x) => `${x.k.placement}: ${x.forms.map((f) => f.slice(0, 6) + '...').join(', ')}`)).toEqual([])
        })
    }

    it('the full local capture is the one place the secrets are kept, and it says it must not be shared', () => {
        const p = prepare('capture-local', capture)
        expect(p.shareable).toBe(false)
        expect(survivors(p.text, c['authorization']!).length).toBeGreaterThan(0)
    })

    it('class F: a random-looking token in free text is flagged by the residual scan, and the scan never prints it', () => {
        const only = plant(c, ['freeToken'])
        for (const kind of SHAREABLE.filter((k) => k !== 'curl' && k !== 'scenario')) {
            const p = prepare(kind, only, kind === 'repro' ? { findingKey: 'proto.content-type' } : {})
            expect(p.residual.length, `${kind} flags it`).toBeGreaterThan(0)
            expect(JSON.stringify(p.residual), `${kind}'s warning does not print it`).not.toContain(c['freeToken']!.value)
        }
    })

    it('a recording with nothing planted is not flagged (the scan is not simply always on)', () => {
        const clean = plant(c, [])
        expect(prepare('report-md', clean).residual).toEqual([])
    })

    it('class L, a documented limit: a low-entropy secret sentence in free text survives redaction and is not flagged', () => {
        const only = plant(c, ['sentence'])
        const p = prepare('capture-shared', only)
        expect(survivors(p.text, c['sentence']!).length, 'it survives (the limit)').toBeGreaterThan(0)
        expect(p.residual.map((h) => JSON.stringify(h)).join(''), 'it is not flagged (the limit)').not.toContain('DO_NOT_LEAK')
    })
})
