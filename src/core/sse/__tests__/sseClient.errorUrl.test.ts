// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { SSEClient, type SSEPhaseInfo } from '../sseClient'
import { Recorder } from '../../observe/recorder'
import type { Observation } from '../../observe/observation'
import { redactUrlsInText } from '../../observe/redactUrl'
import { canaries, survivors } from '../../testing/canaries'

// Found by the browser canary sweep (e2e/doctor.canary.spec.ts): a URL the browser refuses is quoted whole in the error message, and the
// client put that message into the recording as the reason for the reconnect, with every query value and the password in it. The recorded
// request URL is made safe (redactUrl); the reason must be as well.

const C = canaries(3)
const secrets = [C['urlToken']!, C['userinfo']!, C['setCookie']!, C['jwtInId']!]
const URL_WITH_SECRETS = `http://user:${C['userinfo']!.value}@127.0.0.1:9/p?token=${C['urlToken']!.value}&sc=${C['setCookie']!.value.replace('sid=', '')}&idtoken=${C['jwtInId']!.value}`
const leaks = (text: string) => secrets.flatMap((c) => survivors(text, c))

describe('a URL quoted in an error message', () => {
    it('is recorded without its password and query values (the reason of the reconnect, and what the page is told)', async () => {
        const observations: Observation[] = []
        const infos: SSEPhaseInfo[] = []
        const recorder = new Recorder({ onRecord: (o) => observations.push(o) })
        const client = new SSEClient({
            request: () => ({ url: URL_WITH_SECRETS }),
            fetchImpl: (async (url: string) => { throw new TypeError(`Failed to execute 'fetch' on 'Window': Request cannot be constructed from a URL that includes credentials: ${new URL(url).href}`) }) as unknown as typeof fetch,
            onMessage: () => undefined,
            onPhase: (_p, i) => infos.push(i),
            initialDelayMs: 5, maxDelayMs: 5, jitter: 0, maxRetries: 2,
            onObservation: (d) => recorder.record(d),
        })
        client.start()
        const t0 = Date.now()
        while (!observations.some((o) => o.kind === 'reconnect') && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 5))
        client.stop()
        const everything = JSON.stringify(observations) + JSON.stringify(infos)
        expect(observations.some((o) => o.kind === 'reconnect' && o.reason.startsWith('Network error: ')), 'a reconnect with the error was recorded').toBe(true)
        expect(leaks(everything)).toEqual([])
    })
})

describe('redactUrlsInText', () => {
    it('makes every URL in a sentence safe and leaves the rest', () => {
        const out = redactUrlsInText(`Request cannot be constructed from a URL that includes credentials: ${URL_WITH_SECRETS}. Then (see https://example.com/a?key=${C['urlApiKey']!.value}) it stopped.`)
        expect(leaks(out)).toEqual([])
        expect(survivors(out, C['urlApiKey']!)).toEqual([])
        expect(out).toContain('Request cannot be constructed from a URL that includes credentials: http://127.0.0.1:9/p?token=[redacted]&sc=[redacted]&idtoken=[redacted].')
        expect(out).toContain('(see https://example.com/a?key=[redacted]) it stopped.')
    })
    it('leaves text without a URL alone', () => {
        expect(redactUrlsInText('Network error: Failed to fetch')).toBe('Network error: Failed to fetch')
    })
})
