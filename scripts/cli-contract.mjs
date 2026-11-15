// The command line as a person (or a CI step) uses it: a real process, its exit code, what it writes to stdout and to stderr, and whether it
// ever fails to stop. Everything else in the repository tests the CLI by calling `main()` in-process; none of that can see an exit code, a
// stream that is not clean, a stack trace, or a process that does not end. Run after `npm run build:cli`:  npm run doctor:contract
//
// Campaign slice F (F1 exit codes, F2 stdout purity, F3 never hangs, F6 the CLI expands its own globs).

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = path.resolve(import.meta.dirname, '..')
const BIN = path.join(ROOT, 'dist-cli', 'bin', 'sse-doctor.mjs')
if (!existsSync(BIN)) { console.error(`${BIN} does not exist. Run "npm run build:cli" first.`); process.exit(2) }
const lab = (id) => path.join('public', 'lab', `${id}.sse-capture`)

/** Runs the built CLI. Resolves with what it did; kills it (and says so) if it outlives `limitMs`. */
function run(args, { env = {}, limitMs = 60_000 } = {}) {
    return new Promise((resolve) => {
        const started = Date.now()
        const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        let stdout = ''
        let stderr = ''
        let killed = false
        child.stdout.on('data', (d) => { stdout += d })
        child.stderr.on('data', (d) => { stderr += d })
        const timer = setTimeout(() => { killed = true; child.kill('SIGKILL') }, limitMs)
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - started, killed }) })
    })
}

const noStackTrace = (text, what) => {
    assert.doesNotMatch(text, /^\s+at\s+\S+.*\(.*:\d+:\d+\)/m, `${what}: stderr has a stack frame`)
    assert.doesNotMatch(text, /node:internal|file:\/\/\/|\.mjs:\d+/, `${what}: stderr shows where in the program it failed`)
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'sse-contract-'))
const servers = []
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close() } rmSync(tmp, { recursive: true, force: true }) })

async function serve(handler) {
    const s = http.createServer(handler)
    servers.push(s)
    await new Promise((r) => s.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${s.address().port}`
}

const write = (name, text) => { const p = path.join(tmp, name); writeFileSync(p, text); return p }

describe('F1: exit codes, on the real process', () => {
    const CASES = [
        { name: 'no arguments prints the help and exits 0', args: [], code: 0, out: /Usage: sse-doctor/ },
        { name: '--version prints the version only', args: ['--version'], code: 0, out: /^\d+\.\d+\.\d+/ },
        { name: 'analyze of a healthy capture: 0, and says what was not evaluated', args: ['analyze', lab('h01')], code: 0, out: /No findings\.[\s\S]*Not evaluated \(this is not the same as healthy\)/ },
        { name: 'analyze of a capture with an error finding: 1', args: ['analyze', lab('f04-silent')], code: 1, out: /\[ERROR\] .*stall\.silent:bytes/ },
        { name: '--fail-on critical lets an error through: 0', args: ['analyze', lab('f04-silent'), '--fail-on', 'critical'], code: 0 },
        { name: 'an unknown command: 2, with a hint', args: ['bogus'], code: 2, err: /Unknown command: bogus[\s\S]*--help/ },
        { name: 'a missing argument: 2, with the usage line', args: ['analyze'], code: 2, err: /Usage: sse-doctor analyze/ },
        { name: 'an unknown flag: 2', args: ['analyze', lab('h01'), '--nope'], code: 2, err: /Unknown option --nope/ },
        { name: 'a bad --format: 2, naming the choices', args: ['analyze', lab('h01'), '--format', 'bogus'], code: 2, err: /--format must be human, json, md or junit/ },
        { name: 'a non-http URL for probe: 2', args: ['probe', 'ftp://nope'], code: 2, err: /Usage: sse-doctor probe/ },
        { name: 'a file that cannot be read: 3 (could not run)', args: ['analyze', 'does-not-exist.sse-capture'], code: 3, err: /Cannot read "does-not-exist\.sse-capture"/ },
        { name: 'a scenario that cannot be read: 3', args: ['test', 'does-not-exist.json'], code: 3, err: /Cannot read/ },
        { name: 'a stream that refuses the connection: 3, whatever --fail-on says', args: ['probe', 'http://127.0.0.1:1/x', '--duration', '3', '--fail-on', 'critical'], code: 3 },
        { name: 'a scenario that passes: 0', args: ['test', 'scenarios/ci/pass/h01-steady.json'], code: 0, out: /^PASS/ },
        { name: 'a scenario that fails: 1, naming it', args: ['test', 'scenarios/ci/fail/f06-resume-skips.json'], code: 1, out: /^FAIL .*skips ids/ },
        { name: 'a scenario that cannot judge: 4 (inconclusive)', args: ['test', 'scenarios/ci/inconclusive/f06-no-contract.json'], code: 4, out: /^INCONCLUSIVE/ },
        { name: '--allow-inconclusive turns that into 0, and still says inconclusive', args: ['test', 'scenarios/ci/inconclusive/f06-no-contract.json', '--allow-inconclusive'], code: 0, out: /^INCONCLUSIVE/ },
    ]
    for (const c of CASES) {
        it(c.name, async () => {
            const r = await run(c.args)
            assert.equal(r.killed, false, 'it did not stop')
            assert.equal(r.code, c.code, `exit code (stderr: ${r.stderr.slice(0, 200)})`)
            if (c.out) assert.match(r.stdout, c.out)
            if (c.err) assert.match(r.stderr, c.err)
            noStackTrace(r.stderr, c.name)
        })
    }

    it('files that are not what they claim are 2 (a usage problem with the input), with the line and the reason, no stack trace', async () => {
        const files = {
            'version9.sse-capture': { text: '{"format":"sse-capture","version":"9.0"}\n', err: /unsupported capture version "9\.0"/ },
            'junk.sse-capture': { text: 'not a capture\n', err: /not an \.sse-capture file/ },
            'empty.sse-capture': { text: '', err: /the file is empty/ },
        }
        for (const [name, f] of Object.entries(files)) {
            const r = await run(['analyze', write(name, f.text)])
            assert.equal(r.code, 2, name)
            assert.match(r.stderr, f.err, name)
            noStackTrace(r.stderr, name)
        }
    })

    it('an invalid scenario is 2, and every problem is named with where it is', async () => {
        const r = await run(['test', write('bad.json', '{"version":1}')])
        assert.equal(r.code, 2)
        assert.match(r.stderr, /is not a valid scenario/)
        assert.match(r.stderr, /\(document\): missing required property "name"/)
        noStackTrace(r.stderr, 'invalid scenario')
    })

    it('a scenario with a literal secret in it is refused: 2', async () => {
        const doc = { version: 1, name: 'leaks', target: { url: 'http://127.0.0.1:1/x', headers: { Authorization: 'Bearer abcdef0123456789abcdef0123456789' } }, steps: [{ collect_events: 1 }], verify: [{ no_findings_at_or_above: 'error' }] }
        const r = await run(['test', write('secret.json', JSON.stringify(doc))])
        assert.equal(r.code, 2)
        assert.doesNotMatch(r.stdout + r.stderr, /abcdef0123456789abcdef0123456789/, 'the secret was echoed back')
    })

    it('never shows the machine\'s own paths in an error about a file given by a relative name', async () => {
        const r = await run(['analyze', 'does-not-exist.sse-capture'])
        assert.ok(!r.stderr.includes(ROOT), 'the repository path was printed')
    })
})

describe('F2: stdout is the answer and nothing else', () => {
    it('--format json is JSON, and only JSON', async () => {
        const r = await run(['analyze', lab('f04-silent'), '--format', 'json'])
        const parsed = JSON.parse(r.stdout)
        assert.ok(Array.isArray(parsed.findings) || typeof parsed === 'object')
        assert.equal(r.code, 1)
    })

    it('--format junit is a well-formed XML document, and only that', async () => {
        const { JSDOM } = createRequire(import.meta.url)('jsdom')
        const r = await run(['analyze', lab('f04-silent'), '--format', 'junit'])
        assert.match(r.stdout, /^<\?xml /)
        const doc = new JSDOM(r.stdout, { contentType: 'application/xml' }).window.document
        assert.ok(doc.getElementsByTagName('testsuite').length > 0)
    })

    it('--format md starts with its heading', async () => {
        const r = await run(['analyze', lab('f04-silent'), '--format', 'md'])
        assert.match(r.stdout, /^## sse-doctor analyze/)
    })

    it('a warning goes to stderr and stdout stays clean: probe --no-redact --out', async () => {
        const url = await serve((_, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: a\n\n'); setTimeout(() => res.end(), 100) })
        const out = path.join(tmp, 'x.sse-capture')
        const r = await run(['probe', url, '--duration', '2', '--max-events', '1', '--no-redact', '--out', out, '--format', 'json'])
        assert.match(r.stderr, /warning: --no-redact writes a capture that may contain secrets/)
        JSON.parse(r.stdout) // stdout is still only the JSON
        assert.ok(existsSync(out), 'the capture was written')
    })

    it('--no-redact with a secret option is refused: exit 2, a message on stderr, stdout empty, no file', async () => {
        const url = await serve((_, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: a\n\n'); setTimeout(() => res.end(), 100) })
        const out = path.join(tmp, 'refused.sse-capture')
        const r = await run(['probe', url, '--duration', '2', '--auth-env', 'CONTRACT_TOKEN', '--no-redact', '--out', out], { env: { CONTRACT_TOKEN: 'contract-secret-71c4e9' } })
        assert.equal(r.code, 2, r.stderr)
        assert.match(r.stderr, /--no-redact was refused/)
        assert.match(r.stderr, /--auth-env/)
        assert.doesNotMatch(r.stdout + r.stderr, /contract-secret-71c4e9/)
        assert.equal(r.stdout, '')
        assert.ok(!existsSync(out), 'no capture was written')
    })

    it('a redirect to another origin with a secret option is refused (3) and followed with --follow-redirects (0), stderr naming what was not forwarded', async () => {
        const target = await serve((_, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: a\n\n'); setTimeout(() => res.end(), 100) })
        const origin = await serve((_, res) => { res.writeHead(302, { Location: `${target}/landed` }); res.end() })
        const env = { env: { CONTRACT_TOKEN: 'contract-secret-71c4e9' } }
        const refused = await run(['probe', `${origin}/s`, '--duration', '2', '--max-events', '1', '--auth-env', 'CONTRACT_TOKEN'], env)
        assert.equal(refused.code, 3, refused.stderr)
        assert.match(refused.stderr, /--follow-redirects/)
        assert.match(refused.stderr, /--auth-env/)
        noStackTrace(refused.stderr, 'refused redirect')
        const followed = await run(['probe', `${origin}/s`, '--duration', '2', '--max-events', '1', '--auth-env', 'CONTRACT_TOKEN', '--follow-redirects', '--format', 'json'], env)
        assert.equal(followed.code, 0, followed.stderr)
        assert.match(followed.stderr, /NOT forwarded/)
        JSON.parse(followed.stdout)
        assert.doesNotMatch(followed.stdout + followed.stderr, /contract-secret-71c4e9/)
    })

    it('"test --output file" writes the chosen format to the file', async () => {
        const out = path.join(tmp, 'junit.xml')
        const r = await run(['test', 'scenarios/ci/pass/h01-steady.json', '--format', 'junit', '--output', out])
        assert.equal(r.code, 0, r.stderr)
        const { readFileSync } = await import('node:fs')
        assert.match(readFileSync(out, 'utf8'), /^<\?xml /)
    })
})

describe('F3: it always stops', () => {
    it('a refused connection ends within the duration and a margin, exit 3', async () => {
        const r = await run(['probe', 'http://127.0.0.1:1/x', '--duration', '3'], { limitMs: 15_000 })
        assert.equal(r.killed, false)
        assert.equal(r.code, 3)
        assert.ok(r.ms < 3000 + 4000, `took ${r.ms} ms`)
    })

    it('a server that sends headers and then nothing ends at --duration', async () => {
        const url = await serve((_, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders() })
        const r = await run(['probe', url, '--duration', '2'], { limitMs: 15_000 })
        assert.equal(r.killed, false)
        assert.ok(r.ms < 2000 + 4000, `took ${r.ms} ms`)
        assert.ok([0, 1].includes(r.code), `exit ${r.code}`)
    })

    it('--idle-timeout ends a silent stream before --duration', async () => {
        const url = await serve((_, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: a\n\n') })
        const r = await run(['probe', url, '--duration', '20', '--idle-timeout', '1'], { limitMs: 20_000 })
        assert.equal(r.killed, false)
        assert.ok(r.ms < 8000, `took ${r.ms} ms`)
    })

    it('--max-events ends a busy stream', async () => {
        const url = await serve((_, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); const t = setInterval(() => res.write('data: x\n\n'), 5); res.on('close', () => clearInterval(t)) })
        const r = await run(['probe', url, '--duration', '20', '--max-events', '5'], { limitMs: 20_000 })
        assert.equal(r.killed, false)
        assert.ok(r.ms < 8000, `took ${r.ms} ms`)
    })

    it('a server that closes at once does not leave it reconnecting past --duration', async () => {
        const url = await serve((_, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: a\n\n') })
        const r = await run(['probe', url, '--duration', '3'], { limitMs: 20_000 })
        assert.equal(r.killed, false)
        assert.ok(r.ms < 3000 + 4000, `took ${r.ms} ms`)
    })

    it('an enormous answer with no newline is stopped by --max-mb', async () => {
        const url = await serve((_, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); const chunk = 'z'.repeat(64 * 1024); const t = setInterval(() => { for (let i = 0; i < 8; i++) res.write(chunk) }, 1); res.on('close', () => clearInterval(t)) })
        const r = await run(['probe', url, '--duration', '20', '--max-mb', '2'], { limitMs: 25_000 })
        assert.equal(r.killed, false)
        assert.ok(r.ms < 10_000, `took ${r.ms} ms`)
    })

    it('a server that accepts and never answers ends at --timeout', async () => {
        const url = await serve(() => { /* never respond */ })
        const r = await run(['probe', url, '--duration', '20', '--timeout', '1'], { limitMs: 25_000 })
        assert.equal(r.killed, false)
        assert.ok(r.ms < 8000, `took ${r.ms} ms`)
        assert.equal(r.code, 3, `exit ${r.code}`)
    })
})

describe('F6: the CLI expands a glob itself, so a shell that does not (Windows) runs every file', () => {
    it('an unexpanded scenarios/ci/pass/*.json runs both files', async () => {
        const r = await run(['test', 'scenarios/ci/pass/*.json'])
        assert.equal(r.code, 0, r.stderr)
        assert.equal((r.stdout.match(/^PASS /gm) ?? []).length, 2, r.stdout)
    })
})
