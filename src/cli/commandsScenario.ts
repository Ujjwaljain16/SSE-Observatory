import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseScenarioText } from '../core/scenario'
import { planReplay, sessionFromCapture, END_BEHAVIOURS } from '../../lib/mock/capturePlan.js'
import { FIXTURE_ROUTES, startFixtureServer } from '../fixtures/server'
import { numberFlag, stringFlag, type ParsedArgs } from './args'
import { CliError, EXIT, requireFiles, type CliIo } from './io'
import { runScenario, type CheckStatus, type ScenarioRun } from './scenarioRunner'
import type { SecretRegistry } from './secretRegistry'

const xml = (s: string): string => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!)
const MARK: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', inconclusive: 'INCONCLUSIVE' }

function renderHuman(runs: ScenarioRun[]): string {
    const lines: string[] = []
    for (const r of runs) {
        lines.push(`${MARK[r.status]}  ${r.name}  (${r.file}, ${r.events} events, ${(r.durationMs / 1000).toFixed(1)} s)`)
        for (const c of r.checks) lines.push(`  ${c.status === 'pass' ? 'ok  ' : c.status === 'fail' ? 'FAIL' : '?   '} ${c.name}: ${c.message}`)
        const skipped = r.coverage.filter((c) => c.status === 'not-evaluated').length
        if (skipped > 0) lines.push(`  (${skipped} rule${skipped === 1 ? '' : 's'} could not be evaluated; not the same as healthy)`)
        lines.push('')
    }
    const count = (s: CheckStatus) => runs.filter((r) => r.status === s).length
    lines.push(`${runs.length} scenario${runs.length === 1 ? '' : 's'}: ${count('pass')} passed, ${count('fail')} failed, ${count('inconclusive')} inconclusive`)
    return lines.join('\n') + '\n'
}

function renderMarkdown(runs: ScenarioRun[]): string {
    const lines = ['## sse-doctor scenarios', '', '| Scenario | Result | Events |', '|---|---|---|']
    for (const r of runs) lines.push(`| ${r.name} | ${MARK[r.status]} | ${r.events} |`)
    for (const r of runs.filter((x) => x.status !== 'pass')) {
        lines.push('', `### ${r.name}`, '')
        for (const c of r.checks.filter((x) => x.status !== 'pass')) lines.push(`- **${MARK[c.status]}** ${c.name}: ${c.message}`)
    }
    return lines.join('\n') + '\n'
}

/** One testsuite per scenario, one testcase per check. An inconclusive check is reported as skipped, never as passed. */
function renderJunit(runs: ScenarioRun[]): string {
    const suites = runs.map((r) => {
        const cases = r.checks.map((c) => `    <testcase classname="${xml(r.name)}" name="${xml(c.name)}">${c.status === 'fail' ? `<failure message="${xml(c.message)}"/>` : c.status === 'inconclusive' ? `<skipped message="${xml(c.message)}"/>` : ''}</testcase>`)
        return `  <testsuite name="${xml(r.name)}" tests="${r.checks.length}" failures="${r.checks.filter((c) => c.status === 'fail').length}" skipped="${r.checks.filter((c) => c.status === 'inconclusive').length}" time="${(r.durationMs / 1000).toFixed(3)}">\n${cases.join('\n')}\n  </testsuite>`
    })
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join('\n')}\n</testsuites>\n`
}

export async function testCommand(io: CliIo, args: ParsedArgs, secrets: SecretRegistry): Promise<number> {
    const files = args.positionals.slice(1)
    if (files.length === 0) throw new CliError('Usage: sse-doctor test <scenario.json>... [--format human|json|md|junit] [--output file] [--allow-inconclusive]', EXIT.usage)
    const fs = requireFiles(io)
    const runs: ScenarioRun[] = []
    for (const file of files) {
        let text: string
        try { text = await fs.readText(file) } catch { throw new CliError(`Cannot read "${file}".`, EXIT.couldNotRun) }
        const { value, errors } = parseScenarioText(text)
        if (!value) {
            const lines = errors.map((e) => `  ${e.line !== undefined ? `line ${e.line}, column ${e.column}` : e.pointer || '(document)'}: ${e.message}`)
            throw new CliError(`"${file}" is not a valid scenario:\n${lines.join('\n')}`, EXIT.usage)
        }
        runs.push(await runScenario(value, file, io, secrets))
    }
    const format = stringFlag(args, 'format') ?? 'human'
    let text: string
    if (format === 'json') text = JSON.stringify({ schemaVersion: 1, scenarios: runs }, null, 2) + '\n'
    else if (format === 'junit') text = renderJunit(runs)
    else if (format === 'md') text = renderMarkdown(runs)
    else if (format === 'human') text = renderHuman(runs)
    else throw new CliError(`--format must be human, json, md or junit, got "${format}".`, EXIT.usage)
    const out = stringFlag(args, 'output')
    if (out) { await fs.writeText(out, text); io.out(renderHuman(runs)) } else io.out(text)
    if (runs.some((r) => r.status === 'fail')) return EXIT.gateFailed
    if (runs.some((r) => r.status === 'inconclusive')) return args.flags['allow-inconclusive'] === true ? EXIT.ok : EXIT.inconclusive
    return EXIT.ok
}

/** Serves a capture as a local SSE endpoint, so a client or a test can be pointed at a recorded behaviour. */
export async function replayCommand(io: CliIo, args: ParsedArgs): Promise<number> {
    const path = args.positionals[1]
    if (!path) throw new CliError('Usage: sse-doctor replay <capture> [--port n] [--speed x] [--honor-last-event-id] [--drop-after n] [--skip-ids a,b] [--end close|hold|rst|end-event]', EXIT.usage)
    const text = await requireFiles(io).readText(path).catch(() => { throw new CliError(`Cannot read "${path}".`, EXIT.couldNotRun) })
    const { session, error } = sessionFromCapture(text)
    if (!session) throw new CliError(`"${path}": ${error ?? 'cannot be replayed'}`, EXIT.usage)
    const end = stringFlag(args, 'end') ?? 'close'
    if (!END_BEHAVIOURS.includes(end)) throw new CliError(`--end must be one of ${END_BEHAVIOURS.join(', ')}.`, EXIT.usage)
    const speed = numberFlag(args, 'speed', 1) || 1
    const dropAfter = args.flags['drop-after'] !== undefined ? numberFlag(args, 'drop-after', 0) : undefined
    const skipIds = (stringFlag(args, 'skip-ids') ?? '').split(',').filter(Boolean)
    let requests = 0
    const server = http.createServer((req, res) => {
        const plan = planReplay(session, {
            connection: requests++, speed, honorLastEventId: args.flags['honor-last-event-id'] === true,
            lastEventId: String(req.headers['last-event-id'] ?? ''), skipIds, ...(dropAfter !== undefined ? { dropAfter } : {}),
        })
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'X-Mock-Fidelity': plan.mode })
        let closed = false
        res.on('close', () => { closed = true })
        void (async () => {
            const start = Date.now()
            for (const step of plan.steps) {
                const wait = step.atMs - (Date.now() - start)
                if (wait > 0) await new Promise((r) => setTimeout(r, wait))
                if (closed) return
                res.write(step.write)
            }
            if (end === 'hold') return
            if (end === 'rst') { res.destroy(); return }
            if (end === 'end-event') res.write('event: end\ndata: {"done":true}\n\n')
            res.end()
        })()
    })
    await new Promise<void>((resolve) => server.listen(numberFlag(args, 'port', 0), '127.0.0.1', resolve))
    io.out(`Replaying ${path} at http://127.0.0.1:${(server.address() as AddressInfo).port}/ (Ctrl+C to stop)\n`)
    await new Promise<void>((resolve) => {
        if (io.signal?.aborted) resolve()
        io.signal?.addEventListener('abort', () => resolve())
    })
    server.closeAllConnections()
    server.close()
    return EXIT.interrupted
}

/** `fixtures list` prints the known-faulty and healthy streams; `fixtures serve` starts them locally. */
export async function fixturesCommand(io: CliIo, args: ParsedArgs): Promise<number> {
    const sub = args.positionals[1] ?? 'list'
    if (sub === 'list') {
        for (const r of FIXTURE_ROUTES) io.out(`${r.id.padEnd(16)} ${r.family.padEnd(4)} ${r.path.padEnd(22)} ${r.title}\n`)
        return EXIT.ok
    }
    if (sub !== 'serve') throw new CliError('Usage: sse-doctor fixtures list | serve [--port n]', EXIT.usage)
    const server = await startFixtureServer({ port: numberFlag(args, 'port', 0) })
    io.out(`Fixture streams at ${server.url}/ (a JSON list of routes). Add ?scale=0.05 to shorten delays. Ctrl+C to stop.\n`)
    await new Promise<void>((resolve) => {
        if (io.signal?.aborted) resolve()
        io.signal?.addEventListener('abort', () => resolve())
    })
    await server.close()
    return EXIT.interrupted
}
