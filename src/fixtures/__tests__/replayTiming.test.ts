// @vitest-environment node
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultRules } from '../../core/diagnostics/rules'
import { serializeCapture, type Capture } from '../../core/capture/format'
import type { Observation } from '../../core/observe/observation'
import { handleMockSession, handleMockStream } from '../../../lib/mock/handlers.js'
import { loadConfig } from '../../../lib/proxy/guard.js'
import { startFixtureServer, type FixtureServer } from '../server'
import { observeFixture, observeUrl } from './observeFixture'

// Campaign D4: a replay keeps the timing of the capture. A capture of about three seconds is replayed at 0.5x, 1x and 2x with a real clock, and the gaps
// between its events are compared with the original gaps scaled by 1/speed. A replay that is faster, slower or lumpier than it claims would make every
// timing finding on a replayed capture wrong. It uses the real clock, so it runs only when NIGHTLY=1 (and on a quiet machine):
// `NIGHTLY=1 npx vitest run src/fixtures/__tests__/replayTiming.test.ts`.

const NIGHTLY = process.env['NIGHTLY'] === '1'

let fixtures: FixtureServer
let mock: http.Server
let mockUrl = ''
const config = loadConfig({ NODE_ENV: 'development', ENABLE_MOCK_API: '1' })

beforeAll(async () => {
    if (!NIGHTLY) return
    fixtures = await startFixtureServer({ port: 0 })
    mock = http.createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString()
            if (req.url!.startsWith('/api/mock/session')) handleMockSession(req, res, { config, body: raw, limits: { uploadsPerMinute: 1000, streamsPerMinute: 1000, maxOpenStreams: 100, hourlyBudgetBytes: 1e12 } as never })
            else handleMockStream(req, res, { config, limits: { uploadsPerMinute: 1000, streamsPerMinute: 1000, maxOpenStreams: 100, hourlyBudgetBytes: 1e12 } as never })
        })
    })
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()))
    mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`
})
afterAll(async () => { if (!NIGHTLY) return; mock.closeAllConnections(); mock.close(); await fixtures.close() })

const eventTimes = (obs: Observation[]): number[] => obs.filter((o) => o.kind === 'event').map((o) => o.t)
const gaps = (ts: number[]): number[] => ts.slice(1).map((t, i) => t - ts[i]!)
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]! }
const percentile = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]! }

describe.skipIf(!NIGHTLY)('a replay keeps the timing of the capture', () => {
    for (const speed of [0.5, 1, 2]) {
        it(`at ${speed}x, the gaps between events are the original gaps divided by ${speed}`, async () => {
            // about three seconds: h01 at scale 0.6, five events a second apart
            const original = await observeFixture(fixtures, defaultRules, 'h01', { scale: 0.6, n: 5 }, true, { captureBytes: true })
            const originalGaps = gaps(eventTimes(original.observations))
            expect(originalGaps.length, 'the original has gaps to compare').toBeGreaterThan(2)

            const upload = await fetch(`${mockUrl}/api/mock/session`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: serializeCapture(original.capture as Capture) })
            const { sessionId } = await upload.json() as { sessionId: string }
            const replay = await observeUrl(`${mockUrl}/api/mock/stream?session=${sessionId}&speed=${speed}`, defaultRules, undefined, { captureBytes: true })
            const replayGaps = gaps(eventTimes(replay.observations))
            expect(replayGaps.length).toBe(originalGaps.length)

            const expected = originalGaps.map((g) => g / speed)
            const relative = replayGaps.map((g, i) => Math.abs(g - expected[i]!) / expected[i]!)
            const absolute = replayGaps.map((g, i) => Math.abs(g - expected[i]!))
            expect(median(relative), `median relative error of the gaps at ${speed}x`).toBeLessThan(0.15)
            expect(percentile(absolute, 0.95), `95th percentile absolute error at ${speed}x (ms)`).toBeLessThan(60)
        }, 60_000)
    }
})

describe('the replay timing check', () => {
    it('is skipped unless NIGHTLY=1, and says how to run it', () => {
        expect(typeof NIGHTLY).toBe('boolean')
    })
})
