// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main, type CliIo } from '../index'
import { startFixtureServer, type FixtureServer } from '../../fixtures/server'
import { canaries, survivors, secretPart, type Canary } from '../../core/testing/canaries'

// Campaign E1, the command line's side. Secrets are given to `probe` the ways the CLI offers (--auth-env, --cookie-env, --header-env, --query-env,
// and a token typed in the URL), a server that echoes all of them back (fixture f08-echo) puts each into the stream, and then every command and
// every format is run over what was captured. All of stdout, stderr and every file written is searched for each planted value, as written,
// percent-encoded, base64, base64url and JSON-escaped. One class R survivor anywhere is a release blocker.

let fixtures: FixtureServer
beforeAll(async () => { fixtures = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await fixtures.close() })

const C = canaries(11)
const ENV: Record<string, string> = {
    STREAM_SWEEP_AUTH: secretPart(C['authorization']!.value),
    STREAM_SWEEP_COOKIE: C['cookie']!.value,
    STREAM_SWEEP_KEY: C['apiKey']!.value,
    STREAM_SWEEP_QUERY: C['urlApiKey']!.value,
}
const planted: Canary[] = [C['authorization']!, C['cookie']!, C['apiKey']!, C['urlApiKey']!, C['urlToken']!, C['setCookie']!]

interface Run { argv: string[]; code: number; out: string; err: string; files: Record<string, string> }
const files: Record<string, string> = {}

async function cli(argv: string[], env: Record<string, string> = ENV): Promise<Run> {
    let out = ''
    let err = ''
    const written: Record<string, string> = {}
    const io: CliIo = {
        out: (t) => { out += t }, err: (t) => { err += t }, env,
        readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') },
        writeText: async (p, t) => { written[p] = t; files[p] = t },
    }
    const code = await main(argv, io)
    return { argv, code, out, err, files: written }
}

const everything: Run[] = []
const keep = async (argv: string[], env?: Record<string, string>): Promise<Run> => { const r = await cli(argv, env); everything.push(r); return r }

const probeUrl = () => fixtures.urlFor('f08-echo', { scale: 0.05, n: 3, token: secretPart(C['urlToken']!.value), idtoken: C['idToken']!.value, sc: secretPart(C['setCookie']!.value) })
const PROBE = ['--duration', '3', '--max-events', '4', '--auth-env', 'STREAM_SWEEP_AUTH', '--cookie-env', 'STREAM_SWEEP_COOKIE', '--header-env', 'X-Api-Key=STREAM_SWEEP_KEY', '--query-env', 'api_key=STREAM_SWEEP_QUERY']

describe('E1 (CLI): every output of every command, searched for what was planted', () => {
    beforeAll(async () => {
        // Q14: `probe --no-redact` is refused when a secret option is given, so the full local capture that the commands below must cope with
        // (one that holds the secrets, as the recorder or an earlier version wrote it) is made from the observation directly, unscrubbed.
        const { parseArgs } = await import('../args')
        const { observe } = await import('../commands')
        const { SecretRegistry } = await import('../secretRegistry')
        const { serializeCapture } = await import('../../core/capture/format')
        const observed = await observe({ out: () => undefined, err: () => undefined, env: ENV }, parseArgs(['probe', probeUrl(), ...PROBE]), probeUrl(), new SecretRegistry())
        files['local.sse-capture'] = serializeCapture(observed.capture)
        // the secrets really are sent, and really come back: a sweep over a stream that never carried them proves nothing
        const local = files['local.sse-capture']!
        const echoed = [C['authorization']!, C['cookie']!, C['apiKey']!, C['urlToken']!].filter((k) => survivors(Buffer.from(local).toString('latin1') + local, k).length > 0 || local.includes('b64'))
        expect(echoed.length).toBeGreaterThan(0)
        const log = fixtures.groundTruth.connections.filter((c) => c.route === 'f08-echo').at(-1)!
        expect(log.requestHeaders['authorization'], 'the server received the Authorization header').toMatch(/present/)
        expect(log.query['token']).toBe(secretPart(C['urlToken']!.value))
        expect(fixtures.groundTruth.body(log), 'the server echoed the credentials back').toContain(secretPart(C['authorization']!.value))

        // the redacted capture the user would share, then every command over it
        await keep(['probe', probeUrl(), ...PROBE, '--out', 'safe.sse-capture'])
        for (const format of ['human', 'json', 'md', 'junit']) await keep(['probe', probeUrl(), ...PROBE, '--format', format])
        for (const format of ['human', 'json', 'md', 'junit']) await keep(['analyze', 'safe.sse-capture', '--format', format])
        for (const format of ['md', 'html', 'json', 'issue']) {
            await keep(['report', 'safe.sse-capture', '--format', format])
            await keep(['report', 'safe.sse-capture', '--format', format, '--output', `report.${format}`])
        }
        await keep(['report', 'local.sse-capture', '--redact', '--format', 'md'])
        await keep(['redact', 'local.sse-capture', '--output', 'redacted.sse-capture'])
        await keep(['redact', 'local.sse-capture'])
        await keep(['curl', 'safe.sse-capture'])
        await keep(['curl', 'local.sse-capture'])
        await keep(['repro', 'safe.sse-capture', '--finding', 'security.credentials-in-metadata:url', '--output', 'min.sse-capture', '--scenario', 'min.scenario.json', '--test', 'min.test.ts'])
        await keep(['repro', 'local.sse-capture', '--redact', '--finding', 'security.credentials-in-metadata:url', '--output', 'min2.sse-capture'])
        await keep(['compare', 'safe.sse-capture', 'redacted.sse-capture'])
        await keep(['compare', 'safe.sse-capture', 'redacted.sse-capture', '--format', 'json'])
        // a scenario run against the echo stream, in every format, with the same secrets
        const scenario = { version: 1, name: 'echo', target: { url: '${ENV:STREAM_SWEEP_URL}', headers: { Authorization: 'Bearer ${ENV:STREAM_SWEEP_AUTH}' } }, steps: [{ collect_events: 2, timeout_ms: 10_000 }], verify: [{ no_findings_at_or_above: 'warning' }], fail_on_severity: 'warning' }
        files['echo.scenario.json'] = JSON.stringify(scenario)
        for (const format of ['human', 'json', 'md', 'junit']) await keep(['test', 'echo.scenario.json', '--format', format], { ...ENV, STREAM_SWEEP_URL: probeUrl() }).catch(() => undefined)
        await keep(['test', 'echo.scenario.json', '--format', 'junit', '--output', 'out.junit.xml'], { ...ENV, STREAM_SWEEP_URL: probeUrl() })
        // Q14: --no-redact together with these secrets is refused, and what the refusal prints is searched like every other output
        await keep(['probe', probeUrl(), ...PROBE, '--no-redact', '--out', 'refused.sse-capture'])
        // a connection that cannot be made, with a secret in its URL: the error must not repeat it
        await keep(['probe', `http://127.0.0.1:1/x?token=${secretPart(C['urlToken']!.value)}`, '--duration', '2', '--auth-env', 'STREAM_SWEEP_AUTH'])
    }, 240_000)

    const haystack = (): string => everything.map((r) => `${r.out}\n${r.err}\n${Object.values(r.files).join('\n')}`).join('\n=====\n')

    // Found by this sweep: the scrub of registered secrets that every output gets cut into the base64 of the wire bytes of a full local capture
    // (an echoed secret's base64 form was replaced by a placeholder), so the file the CLI had just written could not be read back, redacted or replayed.
    it('a full local capture (the recording as it is) holds valid base64 in every chunk, a matching hash, and the commands that read it work', async () => {
        const { base64ToBytes } = await import('../../core/capture/base64')
        const { parseCapture } = await import('../../core/capture/format')
        const local = files['local.sse-capture']!
        const chunks = local.split('\n').map((l) => { try { return JSON.parse(l) as { kind?: string; b64?: string } } catch { return {} } }).filter((r) => r.kind === 'chunk')
        expect(chunks.length).toBeGreaterThan(0)
        for (const c of chunks) expect(() => base64ToBytes(c.b64!)).not.toThrow()
        expect(parseCapture(local).integrity).toBe('ok')
        for (const argv of [['redact', 'local.sse-capture', '--output', 'again.sse-capture'], ['analyze', 'local.sse-capture'], ['report', 'local.sse-capture', '--redact']]) {
            expect((await cli(argv, ENV)).code, argv.join(' ')).toBeLessThanOrEqual(1)
        }
    })

    it('ran every command (the sweep covered what it says it covered)', () => {
        const commands = new Set(everything.map((r) => r.argv[0]))
        for (const c of ['probe', 'analyze', 'report', 'redact', 'curl', 'repro', 'compare', 'test']) expect(commands.has(c), c).toBe(true)
        expect(everything.length).toBeGreaterThan(30)
        const wanted = ['safe.sse-capture', 'min.sse-capture', 'min.scenario.json', 'min.test.ts', 'report.html', 'redacted.sse-capture', 'out.junit.xml']
        const missing = wanted.filter((f) => !(f in files))
        const how = everything.filter((r) => ['repro', 'redact', 'test', 'probe'].includes(r.argv[0]!) && r.code !== 0 && r.code !== 1).map((r) => `${r.argv[0]} exit ${r.code}: ${r.err.replace(/\s+/g, ' ').slice(0, 160)}`)
        const broken = (files['safe.sse-capture'] ?? '').split('\n').map((l, i) => { try { if (l.trim()) JSON.parse(l); return '' } catch { return `line ${i + 1}: ${l.slice(0, 400)}` } }).filter(Boolean)
        expect(missing, `missing files; commands that did not finish: ${how.join(' | ') || 'none'}; unreadable lines in safe.sse-capture: ${broken.join(' || ') || 'none'}`).toEqual([])
    })

    for (const k of planted) {
        it(`${k.placement}: not in any output of any command, in any form`, () => {
            // the full local capture and the command told to read it as-is are the one place secrets may stay (no run of the command line writes one with secrets in it any more)
            const shareable = everything.filter((r) => !(r.argv[0] === 'curl' && r.argv[1] === 'local.sse-capture'))
            const text = shareable.map((r) => `${r.out}\n${r.err}\n${Object.entries(r.files).filter(([name]) => name !== 'local.sse-capture').map(([, t]) => t).join('\n')}`).join('\n=====\n')
            // name the commands and the places that held it (the output, the error text, or a file), never the value
            const where = shareable.flatMap((r) => {
                const hit = (t: string) => survivors(t, k).length > 0
                return [hit(r.out) ? `stdout of ${r.argv.slice(0, 3).join(' ')} ${r.argv.filter((a) => a.startsWith('--format') || ['md', 'html', 'json', 'junit', 'issue', 'human'].includes(a)).join(' ')}` : '', hit(r.err) ? `stderr of ${r.argv.slice(0, 2).join(' ')}` : '', ...Object.entries(r.files).filter(([name, t]) => name !== 'local.sse-capture' && hit(t)).map(([name]) => `file ${name} written by ${r.argv[0]}`)]
            }).filter((x) => x !== '')
            expect(where.map((w) => `${k.placement}: ${w.replace(/http\S+/g, '<url>')}`), `${survivors(text, k).length} form(s) found`).toEqual([])
        })
    }

    it('class F: a random token used as an event id is kept (no rule can know it is a secret), is warned about on stderr, and the warning does not print it', () => {
        const token = C['idToken']!
        const writers = everything.filter((r) => ((r.argv[0] === 'redact' && r.argv.includes('--output')) || (r.argv[0] === 'probe' && r.argv.includes('--out') && !r.argv.includes('--no-redact')) || (r.argv[0] === 'report' && r.argv.includes('--redact'))))
        expect(writers.length).toBeGreaterThan(0)
        for (const r of writers) {
            expect(r.err, `${r.argv.slice(0, 2).join(' ')} warns`).toMatch(/looks like a random token/)
            expect(survivors(r.err, token), 'the warning does not print the token').toEqual([])
        }
    })

    it('Q14: --no-redact together with these secrets is refused (exit 2), writes no file and prints none of them; the sweep above searched what it printed', () => {
        const refused = everything.find((r) => r.argv.includes('--no-redact'))!
        expect(refused.code).toBe(2)
        expect(refused.files).toEqual({})
        expect(refused.err).toMatch(/--no-redact/)
        expect(refused.err).not.toMatch(/may contain secrets\. Do not share it/)
        expect(haystack().length).toBeGreaterThan(1000)
    })
})
