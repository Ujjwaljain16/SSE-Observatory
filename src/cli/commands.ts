import { analyze, type Analysis } from '../core/diagnostics/engine'
import type { EngineInput } from '../core/diagnostics/streamModel'
import type { StreamProfile } from '../core/diagnostics/thresholds'
import { parseCapture, serializeCapture, newHeader, captureEndT, CaptureFormatError, type Capture, type CaptureRecord } from '../core/capture/format'
import { importV1, isV1Recording, V1ImportError } from '../core/capture/importV1'
import { redactCapture, RedactionError, type RedactionReport } from '../core/capture/redact'
import type { RedactedCapture } from '../core/capture/redacted'
import { buildReport } from '../core/capture/derived/report'
import { compareCaptures } from '../core/capture/derived/compare'
import { toCurl } from '../core/capture/derived/curl'
import { minimizeCapture } from '../core/capture/derived/minimize'
import { serializeScenario, toScenario } from '../core/scenario'
import { SEVERITY_RANK } from '../core/diagnostics/finding'
import { localCapture } from '../core/capture/build'
import { createObservedStream } from '../core/sse/observedStream'
import { redactUrl } from '../core/observe/redactUrl'
import { parseProfile, probeConfigOf } from '../core/diagnostics/profile'
import { numberFlag, stringFlag, type ParsedArgs } from './args'
import { CliError, EXIT, requireFiles, type CliIo } from './io'
import { parseFailOn, parseFormat, render, gate, type Result } from './output'
import type { SecretRegistry } from './secretRegistry'

// ---------------------------------------------------------------- reading input

/** Reads a capture file: `.sse-capture` v2 (NDJSON) or an old `.sse-record` v1 recording. */
async function loadCapture(io: CliIo, path: string): Promise<{ capture: Capture; warnings: string[] }> {
    const files = requireFiles(io)
    let text: string
    try { text = await files.readText(path) } catch { throw new CliError(`Cannot read "${path}".`, EXIT.couldNotRun) }
    try {
        if (text.trimStart().startsWith('{')) {
            let whole: unknown
            try { whole = JSON.parse(text) } catch { whole = undefined }
            if (isV1Recording(whole)) return { capture: importV1(whole), warnings: ['Imported an old .sse-record file: its timeline is rebuilt from event gaps, so rules that need chunks, headers or reconnects are not evaluated.'] }
        }
        const parsed = parseCapture(text)
        return { capture: parsed.capture, warnings: parsed.warnings }
    } catch (error) {
        if (error instanceof CaptureFormatError || error instanceof V1ImportError) throw new CliError(`"${path}": ${error.message}`, EXIT.usage)
        throw error
    }
}

async function loadProfile(io: CliIo, args: ParsedArgs, fallback: StreamProfile | undefined): Promise<StreamProfile | undefined> {
    const path = stringFlag(args, 'profile')
    if (!path) return fallback
    const files = requireFiles(io)
    let value: unknown
    try { value = JSON.parse(await files.readText(path)) } catch { throw new CliError(`Cannot read a JSON profile from "${path}".`, EXIT.usage) }
    const checked = parseProfile(value)
    if (!checked.ok) throw new CliError(`The profile in "${path}" is not valid:\n- ${checked.errors.join('\n- ')}`, EXIT.usage)
    return checked.profile
}

function analysisOf(capture: Capture, profile: StreamProfile | undefined): Analysis {
    return analyze(capture.records as EngineInput[], { ...(profile ? { profile } : {}), endT: captureEndT(capture) })
}

function show(io: CliIo, result: Result, args: ParsedArgs): number {
    const failOn = parseFailOn(stringFlag(args, 'fail-on'))
    const text = render(result, parseFormat(stringFlag(args, 'format')), { failOn, verbose: args.flags['verbose'] === true })
    if (args.flags['quiet'] !== true || result.findings.length > 0) io.out(text)
    return gate(result.findings, failOn)
}

/** What a person must look at before sending a redacted file: ids that look like tokens, and anything the scan still flags. Never prints a value. */
function warnAboutRedaction(io: CliIo, report: RedactionReport): void {
    for (const w of report.idWarnings) io.err(`warning: ${w}\n`)
    if (report.residual.length > 0) {
        io.err(`warning: ${report.residual.length} thing${report.residual.length === 1 ? '' : 's'} still look like secrets after redaction (values not shown). Look before sharing:\n`)
        for (const hit of report.residual.slice(0, 10)) io.err(`  - ${hit.where} (${hit.rule})\n`)
    }
}

/** Reports and curl commands accept only a RedactedCapture. A sanitized file is run through the redactor again (it is idempotent) to get the type. */
function shareable(io: CliIo, capture: Capture, args: ParsedArgs): RedactedCapture {
    if (capture.header.kind === 'local-full' && args.flags['redact'] !== true) {
        throw new CliError('This capture is a local full-fidelity capture and may contain secrets. Run "sse-doctor redact" first, or add --redact to redact it for this command.', EXIT.usage)
    }
    try {
        const result = redactCapture(capture)
        warnAboutRedaction(io, result.report)
        return result.capture
    } catch (error) {
        if (error instanceof RedactionError) throw new CliError(error.message, EXIT.couldNotRun)
        throw error
    }
}

// ---------------------------------------------------------------- commands

export async function analyzeCommand(io: CliIo, args: ParsedArgs): Promise<number> {
    const path = args.positionals[1]
    if (!path) throw new CliError('Usage: sse-doctor analyze <capture>', EXIT.usage)
    const { capture, warnings } = await loadCapture(io, path)
    const profile = await loadProfile(io, args, capture.header.profile)
    const a = analysisOf(capture, profile)
    return show(io, { command: 'analyze', subject: path, findings: a.findings, coverage: a.coverage, notes: warnings }, args)
}

export async function reportCommand(io: CliIo, args: ParsedArgs): Promise<number> {
    const path = args.positionals[1]
    if (!path) throw new CliError('Usage: sse-doctor report <capture> [--format md|html|json] [--output file]', EXIT.usage)
    const raw = stringFlag(args, 'format') ?? 'md'
    if (raw !== 'md' && raw !== 'html' && raw !== 'json') throw new CliError(`--format for report must be md, html or json, got "${raw}".`, EXIT.usage)
    const { capture } = await loadCapture(io, path)
    const safe = shareable(io, capture, args)
    const profile = await loadProfile(io, args, safe.header.profile)
    const text = buildReport(safe, analysisOf(safe, profile), { format: raw })
    const out = stringFlag(args, 'output')
    if (out) await requireFiles(io).writeText(out, text)
    else io.out(text.endsWith('\n') ? text : text + '\n')
    return EXIT.ok
}

export async function redactCommand(io: CliIo, args: ParsedArgs): Promise<number> {
    const path = args.positionals[1]
    const out = stringFlag(args, 'output')
    if (!path || !out) throw new CliError('Usage: sse-doctor redact <capture> --output <file>', EXIT.usage)
    const { capture } = await loadCapture(io, path)
    let result
    try { result = redactCapture(capture) } catch (error) {
        if (error instanceof RedactionError) throw new CliError(error.message, EXIT.couldNotRun)
        throw error
    }
    await requireFiles(io).writeText(out, serializeCapture(result.capture))
    const { placeholders, residual, idWarnings } = result.report
    io.out(`Wrote ${out}: ${placeholders} value${placeholders === 1 ? '' : 's'} replaced.\n`)
    for (const w of idWarnings) io.err(`warning: ${w}\n`)
    if (residual.length > 0) {
        io.err(`warning: ${residual.length} thing${residual.length === 1 ? '' : 's'} still look like secrets (not shown). Look before sharing:\n`)
        for (const hit of residual.slice(0, 10)) io.err(`  - ${hit.where} (${hit.rule})\n`)
    }
    return EXIT.ok
}

export async function compareCommand(io: CliIo, args: ParsedArgs): Promise<number> {
    const [, a, b] = args.positionals
    if (!a || !b) throw new CliError('Usage: sse-doctor compare <captureA> <captureB>', EXIT.usage)
    const first = await loadCapture(io, a)
    const second = await loadCapture(io, b)
    const findings = compareCaptures(first.capture, second.capture)
    const coverage = [{ ruleId: 'compare', ruleVersion: 1, title: 'Capture comparison', status: 'evaluated' as const, missingCapabilities: [], missingKinds: [], notes: [] }]
    return show(io, { command: 'compare', subject: `${a} vs ${b}`, findings, coverage, notes: [...first.warnings, ...second.warnings] }, args)
}

export async function curlCommand(io: CliIo, args: ParsedArgs): Promise<number> {
    const target = args.positionals[1]
    if (!target) throw new CliError('Usage: sse-doctor curl <capture|url>', EXIT.usage)
    let safe: RedactedCapture
    if (/^https?:\/\//i.test(target)) {
        const stub: Capture = { header: newHeader({ kind: 'local-full', source: { kind: 'cli' }, request: { url: redactUrl(target), method: 'GET', headers: {} } }), records: [] }
        safe = redactCapture(stub).capture
    } else safe = shareable(io, (await loadCapture(io, target)).capture, args)
    const shell = stringFlag(args, 'shell') ?? (io.env?.['ComSpec'] && !io.env['SHELL'] ? 'powershell' : 'posix')
    if (shell !== 'posix' && shell !== 'powershell') throw new CliError('--shell must be posix or powershell.', EXIT.usage)
    io.out(toCurl(safe, { shell }) + '\n')
    return EXIT.ok
}

// ---------------------------------------------------------------- probe

function resolveEnv(io: CliIo, name: string, secrets: SecretRegistry, what: string): string {
    const value = io.env?.[name]
    if (value === undefined || value === '') throw new CliError(`${what}: the environment variable ${name} is not set.`, EXIT.usage)
    if (!secrets.register(value)) io.err(`warning: the value of ${name} is shorter than 4 characters and cannot be scrubbed from output reliably.\n`)
    return value
}

function requestFor(io: CliIo, args: ParsedArgs, url: string, secrets: SecretRegistry): { url: string; headers: Record<string, string>; sentNames: string[] } {
    const headers: Record<string, string> = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' }
    const authEnv = stringFlag(args, 'auth-env')
    if (authEnv) headers['Authorization'] = `Bearer ${resolveEnv(io, authEnv, secrets, '--auth-env')}`
    const cookieEnv = stringFlag(args, 'cookie-env')
    if (cookieEnv) headers['Cookie'] = resolveEnv(io, cookieEnv, secrets, '--cookie-env')
    for (const spec of args.multi['header-env'] ?? []) {
        const eq = spec.indexOf('=')
        if (eq <= 0) throw new CliError(`--header-env needs Name=VARIABLE, got "${spec}".`, EXIT.usage)
        headers[spec.slice(0, eq)] = resolveEnv(io, spec.slice(eq + 1), secrets, `--header-env ${spec.slice(0, eq)}`)
    }
    for (const spec of args.multi['header'] ?? []) {
        const colon = spec.indexOf(':')
        if (colon <= 0) throw new CliError(`--header needs "Name: value", got a value without a colon.`, EXIT.usage)
        const value = spec.slice(colon + 1).trim()
        secrets.register(value)
        io.err('warning: a literal --header value is visible in your shell history and process list; prefer --header-env Name=VARIABLE.\n')
        headers[spec.slice(0, colon).trim()] = value
    }
    let full = url
    for (const spec of args.multi['query-env'] ?? []) {
        const eq = spec.indexOf('=')
        if (eq <= 0) throw new CliError(`--query-env needs param=VARIABLE, got "${spec}".`, EXIT.usage)
        const value = resolveEnv(io, spec.slice(eq + 1), secrets, `--query-env ${spec.slice(0, eq)}`)
        full += `${full.includes('?') ? '&' : '?'}${encodeURIComponent(spec.slice(0, eq))}=${encodeURIComponent(value)}`
    }
    return { url: full, headers, sentNames: Object.keys(headers).map((h) => h.toLowerCase()) }
}

export async function probeCommand(io: CliIo, args: ParsedArgs, secrets: SecretRegistry): Promise<number> {
    const target = args.positionals[1]
    if (!target || !/^https?:\/\//i.test(target)) throw new CliError('Usage: sse-doctor probe <http(s) url> [--duration s] [--max-events n] [--idle-timeout s] [--out capture]', EXIT.usage)
    const durationMs = numberFlag(args, 'duration', 30) * 1000
    const maxEvents = numberFlag(args, 'max-events', 0)
    const idleMs = numberFlag(args, 'idle-timeout', 0) * 1000
    const profile = await loadProfile(io, args, undefined)
    const req = requestFor(io, args, target, secrets)
    const out = stringFlag(args, 'out')
    if (out && args.flags['no-redact'] === true) io.err('warning: --no-redact writes a capture that may contain secrets. Do not share it.\n')

    const records: CaptureRecord[] = []
    let events = 0
    let lastActivity = Date.now()
    let finish!: (reason: string) => void
    const done = new Promise<string>((resolve) => { finish = resolve })
    const stream = createObservedStream({
        request: () => ({ url: req.url, headers: req.headers }),
        sinks: {
            onMessage: () => { events++; if (maxEvents > 0 && events >= maxEvents) finish('max-events') },
            onPhase: (phase) => { if (phase === 'ended' || phase === 'failed') finish(phase) },
        },
        recording: {
            ...(Object.keys(probeConfigOf(profile)).length > 0 ? { profile: probeConfigOf(profile) } : {}),
            captureBytes: true,
            onObservations: (batch) => { for (const o of batch) records.push(o); lastActivity = Date.now() },
            flushMs: 25,
        },
        clientOptions: { maxRetries: 2 },
    })
    const timer = setTimeout(() => finish('duration'), durationMs)
    const idle = idleMs > 0 ? setInterval(() => { if (Date.now() - lastActivity >= idleMs) finish('idle') }, Math.min(250, idleMs)) : undefined
    const onAbort = () => finish('interrupted')
    io.signal?.addEventListener('abort', onAbort)
    stream.start()
    const reason = await done
    clearTimeout(timer)
    if (idle) clearInterval(idle)
    io.signal?.removeEventListener('abort', onAbort)
    stream.flushObservations()
    stream.stop()

    const endT = records.at(-1)?.t ?? 0
    const capture = localCapture(records, {
        source: { kind: 'cli', client: 'node-undici' },
        request: { url: target, method: 'GET', headers: Object.fromEntries(req.sentNames.map((n) => [n, '[redacted]'])) },
        ...(profile ? { profile } : {}),
        captureId: stream.captureId,
        endReason: reason === 'failed' ? 'failed' : reason === 'ended' ? 'completed' : 'stopped',
    })
    if (out) {
        const files = requireFiles(io)
        if (args.flags['no-redact'] === true) await files.writeText(out, serializeCapture(capture))
        else {
            const result = redactCapture(capture) // secrets never reach the disk
            warnAboutRedaction(io, result.report)
            await files.writeText(out, serializeCapture(result.capture))
        }
    }
    const a = analysisOf(capture, profile)
    const notes = [`Observed ${events} event${events === 1 ? '' : 's'} for ${(endT / 1000).toFixed(1)} s (stopped: ${reason}).`, ...(out ? [`Capture written to ${out}${args.flags['no-redact'] === true ? ' (NOT redacted)' : ' (redacted)'}.`] : [])]
    const code = show(io, { command: 'probe', subject: redactUrl(target), findings: a.findings, coverage: a.coverage, notes }, args)
    // An interrupted probe still reports what it saw and saves the capture; only the exit code says it was cut short.
    if (reason === 'interrupted') return EXIT.interrupted
    if (reason === 'failed' && code === EXIT.ok && a.findings.length === 0) return EXIT.couldNotRun
    return code
}

// ---------------------------------------------------------------- repro

const testTemplate = (key: string, captureFile: string): string => `// Generated by "sse-doctor repro". Reports a finding from a minimal capture; once the bug is fixed, flip the assertion.
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// Path to the built CLI (npm run build:cli) or override with SSE_DOCTOR_BIN.
const bin = process.env.SSE_DOCTOR_BIN ?? 'dist-cli/bin/sse-doctor.mjs'

describe('${key}', () => {
    it('is reported for the minimal capture', () => {
        const run = spawnSync(process.execPath, [bin, 'analyze', ${JSON.stringify(captureFile)}, '--format', 'json'], { encoding: 'utf8' })
        const keys: string[] = JSON.parse(run.stdout).findings.map((f: { key: string }) => f.key)
        expect(keys).toContain(${JSON.stringify(key)})
    })
})
`

export async function reproCommand(io: CliIo, args: ParsedArgs): Promise<number> {
    const path = args.positionals[1]
    const out = stringFlag(args, 'output')
    if (!path || !out) throw new CliError('Usage: sse-doctor repro <capture> --output <minimal.sse-capture> [--finding <key>] [--scenario file.json] [--test file.test.ts]', EXIT.usage)
    const { capture } = await loadCapture(io, path)
    const profile = await loadProfile(io, args, capture.header.profile)
    const full = analysisOf(capture, profile)
    let key = stringFlag(args, 'finding')
    if (!key) {
        const worst = full.findings.filter((f) => f.status === 'open').sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0]
        if (!worst) throw new CliError('This capture has no open finding to reproduce.', EXIT.usage)
        key = worst.key
    }
    if (capture.records.length > 20_000) io.err(`warning: ${capture.records.length} records; shrinking tries many analyses and stops after 3000, so the result may not be minimal.\n`)
    const result = minimizeCapture(capture, key, { profile })
    if (!result.reproduced) throw new CliError(`The capture does not report "${key}". Findings it does report: ${full.findings.map((f) => f.key).join(', ') || 'none'}.`, EXIT.usage)

    // What leaves the machine is the redacted copy, and it must still show the finding.
    let redacted: RedactedCapture
    try {
        const done = redactCapture(result.capture)
        warnAboutRedaction(io, done.report)
        redacted = done.capture
    } catch (error) {
        if (error instanceof RedactionError) throw new CliError(error.message, EXIT.couldNotRun)
        throw error
    }
    const again = analysisOf(redacted, profile)
    const still = again.findings.some((f) => f.status === 'open' && (f.key === key || f.key.startsWith(`${key}:`)))
    const files = requireFiles(io)
    await files.writeText(out, serializeCapture(redacted))
    io.out(`Reduced ${result.originalRecords} records to ${result.minimalRecords} that still report ${key} (${result.runs} analyses${result.complete ? '' : ', stopped at the limit: not guaranteed minimal'}).\nWrote ${out} (redacted).\n`)
    if (!still) io.err('warning: after redaction the finding is no longer reported; the written capture may not reproduce it.\n')

    const scenarioFile = stringFlag(args, 'scenario')
    if (scenarioFile) {
        try {
            const { scenario, notes } = toScenario(redacted, again)
            await files.writeText(scenarioFile, serializeScenario(scenario))
            io.out(`Wrote the scenario ${scenarioFile}.\n`)
            for (const note of notes) io.out(`  note: ${note}\n`)
        } catch (error) {
            io.err(`warning: could not generate a scenario: ${error instanceof Error ? error.message : String(error)}\n`)
        }
    }
    const testFile = stringFlag(args, 'test')
    if (testFile) {
        await files.writeText(testFile, testTemplate(key, out))
        io.out(`Wrote the test template ${testFile}.\n`)
    }
    return still ? EXIT.ok : EXIT.gateFailed
}
