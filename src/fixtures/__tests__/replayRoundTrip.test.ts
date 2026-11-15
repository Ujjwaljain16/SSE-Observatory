import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { defaultRules } from '../../core/diagnostics/rules'
import { serializeCapture, type Capture } from '../../core/capture/format'
import { redactCapture } from '../../core/capture/redact'
import { compareCaptures } from '../../core/capture/derived'
import type { Observation } from '../../core/observe/observation'
import { handleMockSession, handleMockStream } from '../../../lib/mock/handlers.js'
import { loadConfig } from '../../../lib/proxy/guard.js'
import { FIXTURE_ROUTES, startFixtureServer, type FixtureServer } from '../server'
import { observeFixture, observeUrl } from './observeFixture'

let fixtures: FixtureServer
let mock: http.Server
let mockUrl = ''
const config = loadConfig({ NODE_ENV: 'development', ENABLE_MOCK_API: '1' })

beforeAll(async () => {
    fixtures = await startFixtureServer({ port: 0 })
    mock = http.createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString()
            if (req.url!.startsWith('/api/mock/session')) {
                const ndjson = String(req.headers['content-type']).includes('x-ndjson')
                handleMockSession(req, res, { config, body: ndjson ? raw : raw ? JSON.parse(raw) : undefined })
            } else handleMockStream(req, res, { config })
        })
    })
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()))
    mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`
})
afterAll(async () => { mock.closeAllConnections(); mock.close(); await fixtures.close() })

async function upload(capture: Capture): Promise<string> {
    const res = await fetch(`${mockUrl}/api/mock/session`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: serializeCapture(capture) })
    const body = await res.json() as { sessionId?: string; error?: string }
    if (!body.sessionId) throw new Error(body.error ?? 'upload failed')
    return body.sessionId
}

const profileOf = (id: string) => FIXTURE_ROUTES.find((r) => r.id === id)!.profile
const keys = (findings: Array<{ key: string }>) => findings.map((f) => f.key).sort()
const kinds = <K extends Observation['kind']>(obs: Observation[], kind: K) => obs.filter((o): o is Extract<Observation, { kind: K }> => o.kind === kind)

describe('capture, replay, record, analyze', () => {
    it('a stream that arrived in 4096-byte blocks replays in blocks, and the replay compares as the same path', async () => {
        const original = await observeFixture(fixtures, defaultRules, 'f09-buffered', {}, true, { captureBytes: true })
        expect(kinds(original.observations, 'chunk').every((c) => typeof c.b64 === 'string')).toBe(true)

        const id = await upload(original.capture)
        const replay = await observeUrl(`${mockUrl}/api/mock/stream?session=${id}`, defaultRules, profileOf('f09-buffered'), { captureBytes: true })

        const bytes = (obs: Observation[]) => kinds(obs, 'chunk').reduce((n, c) => n + c.bytes, 0)
        expect(bytes(replay.observations)).toBe(bytes(original.observations))
        expect(kinds(replay.observations, 'event').map((e) => e.sseId)).toEqual(kinds(original.observations, 'event').map((e) => e.sseId))
        expect(keys(replay.findings)).toEqual(keys(original.findings))
        // same buffering signature in both: the comparison does not flag a difference between them
        expect(compareCaptures(original.capture, replay.capture).filter((f) => f.severity !== 'info')).toEqual([])
    })

    it('a capture with a reconnect reproduces it: the second request gets the second recorded connection, and the same finding appears', async () => {
        const original = await observeFixture(fixtures, defaultRules, 'f06-skips', {}, true, { captureBytes: true })
        expect(keys(original.findings)).toContain('resume.last-event-id:skipped')
        expect(kinds(original.observations, 'reconnect').length).toBeGreaterThan(0)

        const id = await upload(original.capture)
        const replay = await observeUrl(`${mockUrl}/api/mock/stream?session=${id}&speed=20`, defaultRules, profileOf('f06-skips'), { captureBytes: true })
        expect(kinds(replay.observations, 'reconnect').length).toBe(kinds(original.observations, 'reconnect').length)
        expect(keys(replay.findings)).toEqual(keys(original.findings))
    })

    it('a sanitized export replays from its redacted text and still produces the same findings', async () => {
        const original = await observeFixture(fixtures, defaultRules, 'f06-skips', {}, true, { captureBytes: true })
        const { capture: sanitized } = redactCapture(original.capture)
        const id = await upload(sanitized)
        const replay = await observeUrl(`${mockUrl}/api/mock/stream?session=${id}&speed=20`, defaultRules, profileOf('f06-skips'))
        expect(keys(replay.findings)).toEqual(keys(original.findings))
    })
})

describe('replay options on the mock stream', () => {
    const fetchText = async (url: string, headers: Record<string, string> = {}) => {
        const res = await fetch(url, { headers })
        return { status: res.status, text: await res.text(), fidelity: res.headers.get('x-mock-fidelity') }
    }

    it('resumes after Last-Event-ID when asked, and not otherwise', async () => {
        const original = await observeFixture(fixtures, defaultRules, 'f06-resumes', {}, true, { captureBytes: true })
        const id = await upload(original.capture)
        const resumed = await fetchText(`${mockUrl}/api/mock/stream?session=${id}&honorLastEventId=1&speed=100`, { 'Last-Event-ID': '6' })
        expect(resumed.fidelity).toBe('event-level')
        expect(resumed.text).toContain('id: 7')
        expect(resumed.text).not.toContain('id: 6\n')
        const plain = await fetchText(`${mockUrl}/api/mock/stream?session=${id}&connection=0&speed=100`, { 'Last-Event-ID': '6' })
        expect(plain.fidelity).toBe('chunk-faithful')
        expect(plain.text).toContain('id: 1\n')
    })

    it('answers an unknown id with 400 when asked to', async () => {
        const original = await observeFixture(fixtures, defaultRules, 'f06-resumes', {}, true, { captureBytes: true })
        const id = await upload(original.capture)
        const res = await fetchText(`${mockUrl}/api/mock/stream?session=${id}&honorLastEventId=1&unknownId=400`, { 'Last-Event-ID': 'nope' })
        expect(res.status).toBe(400)
    })

    it('ends as asked: a plain close, an end event, or a reset', async () => {
        const original = await observeFixture(fixtures, defaultRules, 'f09-healthy', {}, false, { captureBytes: true })
        const id = await upload(original.capture)
        const close = await fetchText(`${mockUrl}/api/mock/stream?session=${id}&speed=100&dropAfter=3&end=close`)
        expect(close.text).not.toContain('event: end')
        const endEvent = await fetchText(`${mockUrl}/api/mock/stream?session=${id}&speed=100&dropAfter=3&end=end-event`)
        expect(endEvent.text).toMatch(/event: end\ndata: \{"done":true\}/)
        const reset = await fetch(`${mockUrl}/api/mock/stream?session=${id}&speed=100&dropAfter=3&end=rst`).then((r) => r.text()).then(() => 'completed', () => 'reset')
        expect(reset).toBe('reset')
    })

    it('rejects a bad end behaviour, and a capture with nothing to replay', async () => {
        const original = await observeFixture(fixtures, defaultRules, 'f09-healthy', {}, false, { captureBytes: true })
        const id = await upload(original.capture)
        expect((await fetchText(`${mockUrl}/api/mock/stream?session=${id}&end=explode`)).status).toBe(400)
        const meta = await observeFixture(fixtures, defaultRules, 'f09-healthy', {}, false) // no wire bytes recorded
        const res = await fetch(`${mockUrl}/api/mock/session`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: serializeCapture(meta.capture) })
        expect(res.status).toBe(400)
        expect((await res.json() as { error: string }).error).toMatch(/no payload to replay/)
    })
})
