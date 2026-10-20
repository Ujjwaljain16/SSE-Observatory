import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { analyze, type RuleCoverage } from '../core/diagnostics/engine'
import { SEVERITY_RANK, type Finding, type Severity } from '../core/diagnostics/finding'
import type { EngineInput } from '../core/diagnostics/streamModel'
import type { StreamProfile } from '../core/diagnostics/thresholds'
import type { CaptureRecord } from '../core/capture/format'
import type { PayloadProbeConfig } from '../core/observe/payloadProbe'
import { createObservedStream } from '../core/sse/observedStream'
import type { Scenario, ScenarioStep } from '../core/scenario/types'
import { planReplay, sessionFromCapture } from '../../lib/mock/capturePlan.js'
import { FIXTURE_ROUTES, startFixtureServer } from '../fixtures/server'
import { CliError, EXIT, requireFiles, type CliIo } from './io'
import type { SecretRegistry } from './secretRegistry'

export type CheckStatus = 'pass' | 'fail' | 'inconclusive'
export interface CheckResult { name: string; status: CheckStatus; message: string }

export interface ScenarioRun {
    name: string
    file: string
    status: CheckStatus
    checks: CheckResult[]
    findings: Finding[]
    coverage: RuleCoverage[]
    events: number
    durationMs: number
}

const ENV_REF = /\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}/g
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Replaces `${ENV:NAME}` with the variable's value and registers every value as a secret. Names that are not set are all reported at once. */
function substitute(text: string, io: CliIo, secrets: SecretRegistry, missing: Set<string>): string {
    return text.replace(ENV_REF, (_m, name: string) => {
        const value = io.env?.[name]
        if (value === undefined || value === '') { missing.add(name); return '' }
        secrets.register(value)
        return value
    })
}

function profileOf(scenario: Scenario): StreamProfile {
    const seq = scenario.target.sequence
    return {
        ...(seq ? { sequence: { ...(seq.use_sse_id ? { useSseId: true } : { field: seq.field }), policy: seq.policy } } : {}),
        ...(scenario.target.delivery ? { delivery: scenario.target.delivery } : {}),
    }
}

function probeOf(profile: StreamProfile): PayloadProbeConfig {
    return profile.sequence ? { sequence: { ...(profile.sequence.field ? { field: profile.sequence.field } : {}), ...(profile.sequence.useSseId ? { useSseId: true } : {}) } } : {}
}

/** Serves a capture from this process, one recorded connection per request, so a scenario needs no live server. */
async function serveReplay(scenario: Scenario, io: CliIo): Promise<{ url: string; close(): Promise<void> }> {
    const replay = scenario.target.replay!
    const text = await requireFiles(io).readText(replay.capture).catch(() => { throw new CliError(`Cannot read the capture "${replay.capture}".`, EXIT.couldNotRun) })
    const { session, error } = sessionFromCapture(text)
    if (!session) throw new CliError(`The capture "${replay.capture}": ${error ?? 'cannot be replayed'}`, EXIT.usage)
    let requests = 0
    const server = http.createServer((req, res) => {
        const plan = planReplay(session, {
            connection: requests++,
            honorLastEventId: replay.honor_last_event_id === true,
            lastEventId: String(req.headers['last-event-id'] ?? ''),
            skipIds: replay.test_aids?.skip_ids ?? [],
            ...(replay.test_aids?.drop_after !== undefined ? { dropAfter: replay.test_aids.drop_after } : {}),
        })
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        let closed = false
        res.on('close', () => { closed = true })
        void (async () => {
            const start = Date.now()
            for (const step of plan.steps) {
                const wait = step.atMs - (Date.now() - start)
                if (wait > 0) await sleep(wait)
                if (closed) return
                res.write(step.write)
            }
            res.end()
        })()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/replay`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

async function resolveTarget(scenario: Scenario, io: CliIo, secrets: SecretRegistry, cleanup: Array<() => Promise<void>>): Promise<{ url: string; headers: Record<string, string> }> {
    const missing = new Set<string>()
    const headers = Object.fromEntries(Object.entries(scenario.target.headers ?? {}).map(([k, v]) => [k, substitute(v, io, secrets, missing)]))
    let url: string
    const raw = scenario.target.url
    if (scenario.target.replay) {
        const served = await serveReplay(scenario, io)
        cleanup.push(served.close)
        url = served.url
    } else if (raw?.startsWith('fixture://')) {
        const [name, query = ''] = raw.slice('fixture://'.length).split('?')
        const route = FIXTURE_ROUTES.find((r) => r.id === name!.toLowerCase()) ?? FIXTURE_ROUTES.find((r) => r.family.toLowerCase() === name!.toLowerCase())
        if (!route) throw new CliError(`No fixture "${name}". Run "sse-doctor fixtures list".`, EXIT.usage)
        const fixtures = await startFixtureServer({ port: 0 })
        cleanup.push(() => fixtures.close())
        url = `${fixtures.url}${route.path}${query ? `?${query}` : ''}`
    } else if (raw) {
        url = substitute(raw, io, secrets, missing)
    } else throw new CliError('The scenario has no target.url and no target.replay.', EXIT.usage)
    if (missing.size > 0) throw new CliError(`Environment variable${missing.size > 1 ? 's' : ''} not set: ${[...missing].join(', ')}.`, EXIT.usage)
    return { url, headers }
}

const mediaType = (value: string): string => value.split(';')[0]!.trim().toLowerCase()

export async function runScenario(scenario: Scenario, file: string, io: CliIo, secrets: SecretRegistry): Promise<ScenarioRun> {
    const cleanup: Array<() => Promise<void>> = []
    const startedAt = Date.now()
    try {
        const target = await resolveTarget(scenario, io, secrets, cleanup)
        const profile = profileOf(scenario)
        const records: CaptureRecord[] = []
        let events = 0
        let phase = ''
        const stream = createObservedStream({
            request: () => ({ url: target.url, headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', ...target.headers } }),
            sinks: { onMessage: () => { events++ }, onPhase: (p) => { phase = p } },
            recording: { ...(Object.keys(probeOf(profile)).length > 0 ? { profile: probeOf(profile) } : {}), onObservations: (batch) => { records.push(...batch) }, flushMs: 10 },
            clientOptions: { initialDelayMs: 20, maxDelayMs: 200, jitter: 0, maxRetries: 5 },
        })
        const waitFor = async (done: () => boolean, timeoutMs: number): Promise<boolean> => {
            const until = Date.now() + timeoutMs
            while (!done()) {
                if (io.signal?.aborted) throw new CliError('Interrupted.', EXIT.interrupted)
                if (Date.now() > until) return false
                await sleep(10)
            }
            return true
        }

        const checks: CheckResult[] = []
        const check = (name: string, ok: boolean, message: string) => checks.push({ name, status: ok ? 'pass' : 'fail', message })
        const ended = () => phase === 'ended' || phase === 'failed'

        stream.start()
        let index = 0
        for (const step of scenario.steps as ScenarioStep[]) {
            index++
            if ('collect_events' in step) {
                const goal = events + step.collect_events
                const ok = await waitFor(() => events >= goal || ended(), step.timeout_ms ?? 30_000)
                const got = events - (goal - step.collect_events)
                check(`step ${index}: collect ${step.collect_events} events`, ok && events >= goal, events >= goal ? `received ${got}` : ended() ? `the stream ${phase} after ${got}` : `received ${got} of ${step.collect_events} before the timeout`)
            } else if ('disconnect' in step) {
                if (step.disconnect.mode === 'client') {
                    stream.stop()
                    check(`step ${index}: disconnect (client)`, true, 'closed by the client')
                } else {
                    const ok = await waitFor(() => phase === 'reconnecting' || ended(), 15_000)
                    check(`step ${index}: disconnect (server)`, ok, ok ? 'the server dropped the connection' : 'the server did not drop the connection')
                }
            } else if ('reconnect' in step) {
                if (step.reconnect.after_ms) await sleep(step.reconnect.after_ms)
                if (step.reconnect.resume_from_last_event_id === false) stream.forgetLastEventId()
                if (!stream.isRunning) stream.start()
                check(`step ${index}: reconnect`, true, step.reconnect.resume_from_last_event_id === false ? 'without Last-Event-ID' : `with Last-Event-ID "${stream.lastId}"`)
            } else if ('wait' in step) await sleep(step.wait.ms)
        }
        stream.flushObservations()
        stream.stop()

        const endT = records.at(-1)?.t ?? 0
        const analysis = analyze(records as EngineInput[], { profile, endT })
        // Gaps the scenario declares as expected (allow_gaps) are explained: their findings count neither for the gap check nor for
        // the severity gates. A gap finding is explained only if an entry covers every number in every one of its ranges.
        const allowed = scenario.allow_gaps ?? []
        const rangesOf = (f: Finding): Array<{ from: number; to: number }> => (f.data?.['ranges'] as Array<{ from: number; to: number }> | undefined) ?? []
        const isGapFinding = (f: Finding) => f.key.startsWith('seq.integrity:gap') || f.key.startsWith('resume.last-event-id:skipped')
        const explained = (f: Finding) => isGapFinding(f) && f.data?.['truncated'] !== true && rangesOf(f).length > 0 && rangesOf(f).every((r) => allowed.some((a) => a.from <= r.from && r.to <= a.to))
        const open = analysis.findings.filter((f) => f.status === 'open' && !explained(f))
        const hasKey = (...prefixes: string[]) => open.filter((f) => prefixes.some((p) => f.key.startsWith(p)))

        // what the scenario expects of the response
        const response = records.find((r) => r.kind === 'response') as { status: number; contentType: string } | undefined
        const exp = scenario.expect
        if (exp?.status !== undefined) check('expect status', response?.status === exp.status, response ? `got ${response.status}, expected ${exp.status}` : 'no response was received')
        if (exp?.content_type !== undefined) check('expect content type', response !== undefined && mediaType(response.contentType) === mediaType(exp.content_type), response ? `got ${response.contentType}, expected ${exp.content_type}` : 'no response was received')
        if (exp?.first_event_within_ms !== undefined) {
            const connect = records.find((r) => r.kind === 'connect')
            const first = records.find((r) => r.kind === 'event')
            const took = connect && first ? first.t - connect.t : undefined
            check('expect first event in time', took !== undefined && took <= exp.first_event_within_ms, took === undefined ? 'no event arrived' : `first event after ${Math.round(took)} ms, limit ${exp.first_event_within_ms} ms`)
        }

        // what the scenario asks to verify; sequence checks without a declared contract are inconclusive, never a silent pass
        const needContract = (name: string, run: () => CheckResult): void => {
            if (!scenario.target.sequence) checks.push({ name, status: 'inconclusive', message: 'no sequence contract is declared (target.sequence), so continuity cannot be verified' })
            else checks.push(run())
        }
        for (const v of scenario.verify ?? []) {
            if (v === 'no_unexplained_sequence_gaps') {
                needContract(v, () => {
                    const found = hasKey('seq.integrity:gap', 'resume.last-event-id:skipped') // what allow_gaps did not explain
                    const covered = analysis.findings.filter((f) => f.status === 'open' && explained(f)).flatMap(rangesOf)
                    if (found.length > 0 && allowed.length > 0 && found.some((f) => f.data?.['truncated'] === true)) return { name: v, status: 'inconclusive', message: 'more gaps than the tool lists (1000), so they cannot all be checked against allow_gaps' }
                    if (found.length > 0) {
                        const missing = found.flatMap(rangesOf).filter((r) => !allowed.some((a) => a.from <= r.from && r.to <= a.to))
                        const list = missing.slice(0, 5).map((r) => (r.from === r.to ? r.from : `${r.from}-${r.to}`)).join(', ')
                        return { name: v, status: 'fail', message: allowed.length > 0 && missing.length > 0 ? `numbers missing that no allow_gaps entry covers: ${list}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}` : found.map((f) => f.summary).join(' ') }
                    }
                    return { name: v, status: 'pass', message: covered.length > 0 ? `${covered.length} gap${covered.length === 1 ? '' : 's'}, all covered by allow_gaps` : 'no number is missing' }
                })
            } else if (v === 'no_unexpected_duplicates') {
                needContract(v, () => {
                    const bad = hasKey('seq.integrity:duplicate', 'seq.integrity:conflict', ...(scenario.target.delivery && scenario.target.delivery !== 'at_least_once' ? ['seq.integrity:replay'] : []))
                    return { name: v, status: bad.length ? 'fail' : 'pass', message: bad.length ? bad.map((f) => f.summary).join(' ') : 'no unexpected duplicate' }
                })
            } else if (v === 'preserve_event_order') {
                needContract(v, () => {
                    const bad = hasKey('seq.integrity:reorder', 'seq.integrity:regression')
                    return { name: v, status: bad.length ? 'fail' : 'pass', message: bad.length ? bad.map((f) => f.summary).join(' ') : 'events arrived in order' }
                })
            } else {
                const level = v.no_findings_at_or_above
                const bad = open.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[level])
                checks.push({ name: `no findings at or above ${level}`, status: bad.length ? 'fail' : 'pass', message: bad.length ? bad.map((f) => `${f.key}: ${f.summary}`).join(' | ') : 'none' })
            }
        }
        const gateLevel: Severity = scenario.fail_on_severity ?? 'error'
        const bad = open.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[gateLevel])
        checks.push({ name: `findings below ${gateLevel}`, status: bad.length ? 'fail' : 'pass', message: bad.length ? bad.map((f) => `${f.key}: ${f.summary}`).join(' | ') : 'none at or above the threshold' })

        const status: CheckStatus = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'inconclusive') ? 'inconclusive' : 'pass'
        return { name: scenario.name, file, status, checks, findings: analysis.findings, coverage: analysis.coverage, events, durationMs: Date.now() - startedAt }
    } finally {
        for (const close of cleanup) await close()
    }
}
