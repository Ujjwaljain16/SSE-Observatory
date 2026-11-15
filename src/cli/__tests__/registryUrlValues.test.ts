// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main, type CliIo } from '../index'
import { isSecretQueryValue } from '../commands'
import { startFixtureServer, type FixtureServer } from '../../fixtures/server'
import { parseCapture } from '../../core/capture/format'

// Found by the canary sweep (campaign E1), as a flake: the saved capture was sometimes not valid JSON. Every value in the URL's query was registered
// as a secret, so a harmless `?scale=0.05` made each `0.05` in the output a placeholder, and one of those was inside a JSON number.

let fixtures: FixtureServer
beforeAll(async () => { fixtures = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await fixtures.close() })

describe('which URL query values are secrets', () => {
    it.each([
        ['token', 'x', true], ['api_key', 'abcd', true], ['access_token', 'short', true], ['password', '1', true], ['sig', 'a', true],
        ['room', '7', false], ['scale', '0.05', false], ['limit', '1000', false], ['debug', 'true', false], ['mode', 'transport', false], ['since', '2026-11-15T10:00:00Z', false],
        ['since', '2026-11-15', false], ['ratio', '1,5', false], ['empty', '', false],
        ['sessionRef', 'q7Zr4KpX9vLm2NcB', true], ['k', 'q7Zr4KpX9vLm2NcB8wTy5HsJ3dFg6A1e', true], ['name', 'ada', false],
    ] as Array<[string, string, boolean]>)('%s=%s is %s', (name, value, secret) => {
        // a word, a number, a date, a flag: none of them is a secret by shape, and registering one damages every output that holds it
        expect(isSecretQueryValue(name, value)).toBe(secret)
    })
})

describe('a harmless query value does not cut into the output', () => {
    const run = async (url: string, extra: string[] = []) => {
        const files: Record<string, string> = {}
        let out = ''
        const io: CliIo = { out: (t) => { out += t }, err: () => {}, env: {}, readText: async () => '', writeText: async (p, t) => { files[p] = t } }
        const code = await main(['probe', url, '--duration', '3', '--max-events', '4', '--out', 'x.sse-capture', ...extra], io)
        return { code, out, files }
    }

    it('?scale=0.05&limit=1000&debug=true leaves the JSON result and the saved capture as they were', async () => {
        const r = await run(fixtures.urlFor('h01', { scale: 0.05, n: 3, limit: 1000, debug: 'true' }), ['--format', 'json'])
        JSON.parse(r.out)
        expect(r.out).not.toContain('[REDACTED]')
        for (const line of r.files['x.sse-capture']!.split('\n')) if (line.trim()) JSON.parse(line)
        expect(parseCapture(r.files['x.sse-capture']!).integrity).not.toBe('mismatch')
    })

    it('a value that is only a word of the output (?phase=phase) does not turn the records into placeholders', async () => {
        const r = await run(fixtures.urlFor('h01', { scale: 0.05, n: 2, where: 'transport', step: 'connecting' }))
        const text = r.files['x.sse-capture']!
        expect(text).toContain('"kind":"phase"')
        expect(text).not.toContain('"domain":"[REDACTED]"')
    })

    it('a token in the URL is still scrubbed from everything: by its name, and by its length', async () => {
        const secret = 'Qx9ZrT4mPw2LkB7vNc5H'
        const r = await run(fixtures.urlFor('h01', { scale: 0.05, n: 2, token: secret, other: 'abcdef123456ghij' }), ['--format', 'json'])
        expect(r.out + (r.files['x.sse-capture'] ?? '')).not.toContain(secret)
        expect(r.out + (r.files['x.sse-capture'] ?? '')).not.toContain('abcdef123456ghij')
    })
})
