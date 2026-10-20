/**
 * Turns a redacted capture and its analysis into a scenario file that replays the same shape of session against a
 * stream. Nothing is copied from the capture that could be a secret: the URL and every header value become
 * `${ENV:...}` placeholders, and only header NAMES are read.
 */

import type { CaptureRecord } from '../capture/format'
import type { RedactedCapture } from '../capture/redacted'
import type { Analysis } from '../diagnostics/engine'
import { SEVERITY_RANK, type Finding, type Severity } from '../diagnostics/finding'
import type { Observation, ObservationKind } from '../observe/observation'
import { SCENARIO_SCHEMA_URL } from './schema'
import type { Delivery, Scenario, ScenarioSequence, ScenarioStep, SequencePolicy, VerifyCheck } from './types'
import { validateScenario } from './validate'

export interface ToScenarioOptions {
    name?: string | undefined
    /** Most events one collect step waits for. Default 100. */
    maxEvents?: number | undefined
}

const MAX_RECONNECTS = 3
/** The runner sets these itself, and they hold nothing worth a variable. */
const SKIPPED_HEADERS = new Set(['accept', 'cache-control', 'last-event-id'])

type Of<K extends ObservationKind> = Extract<Observation, { kind: K }>
const isKind = <K extends ObservationKind>(r: CaptureRecord, kind: K): r is Of<K> => r.kind === kind

/** `x-api-key` -> `STREAM_X_API_KEY`. */
export const headerEnvName = (header: string): string => `STREAM_${header.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** What a profile may declare about sequence numbers. The shared StreamProfile type does not have it yet, so it is read defensively. */
interface ProfileContract { sequence?: { field?: unknown; useSseId?: unknown; policy?: unknown } | undefined; delivery?: unknown }

function sequenceOf(profile: unknown): ScenarioSequence | undefined {
    const seq = (profile as ProfileContract | undefined)?.sequence
    if (!seq || typeof seq !== 'object') return undefined
    const policy: SequencePolicy = seq.policy === 'monotonic' ? 'monotonic' : 'consecutive'
    if (typeof seq.field === 'string' && seq.field.startsWith('$.') && seq.field.length > 2) return { field: seq.field, policy }
    if (seq.useSseId === true) return { use_sse_id: true, policy }
    return undefined
}

const DELIVERIES: readonly Delivery[] = ['at_least_once', 'exactly_once', 'at_most_once']
const deliveryOf = (profile: unknown): Delivery | undefined => {
    const d = (profile as ProfileContract | undefined)?.delivery
    return DELIVERIES.find((x) => x === d)
}

const isSequenceFinding = (f: Finding): boolean => /^(seq|sequence|delivery|ordering)/i.test(f.key) || /^(seq|sequence)/i.test(f.ruleId)

function verifyFrom(findings: readonly Finding[]): { verify: VerifyCheck[]; threshold: Severity } {
    const sequenceKeys = findings.filter(isSequenceFinding).map((f) => f.key.toLowerCase())
    const verify: VerifyCheck[] = []
    if (sequenceKeys.some((k) => /gap|missing/.test(k))) verify.push('no_unexplained_sequence_gaps')
    if (sequenceKeys.some((k) => /dup|replay/.test(k))) verify.push('no_unexpected_duplicates')
    if (sequenceKeys.some((k) => /order|regress|backward/.test(k))) verify.push('preserve_event_order')

    const serious = findings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.error)
    const threshold = serious.reduce<Severity>((low, f) => (SEVERITY_RANK[f.severity] < SEVERITY_RANK[low] ? f.severity : low), serious[0]?.severity ?? 'error')
    verify.push({ no_findings_at_or_above: threshold })
    return { verify, threshold }
}

export function toScenario(capture: RedactedCapture, analysis: Analysis, opts: ToScenarioOptions = {}): { scenario: Scenario; notes: string[] } {
    const notes: string[] = []
    const maxEvents = Math.max(1, opts.maxEvents ?? 100)
    const records = capture.records
    const header = capture.header

    const connects = records.filter((r): r is Of<'connect'> => isKind(r, 'connect'))
    const response = records.find((r): r is Of<'response'> => isKind(r, 'response'))
    const events = records.filter((r): r is Of<'event'> => isKind(r, 'event'))
    const reconnects = records.filter((r): r is Of<'reconnect'> => isKind(r, 'reconnect'))
    const startT = connects[0]?.t ?? records[0]?.t ?? 0

    // Target: the URL always comes from the environment; the capture's origin is kept for reference only.
    const envNames = ['STREAM_URL']
    const headers: Record<string, string> = {}
    const requestHeaderNames = header.request ? Object.keys(header.request.headers) : connects[0]?.headerNames ?? []
    for (const name of requestHeaderNames) {
        if (SKIPPED_HEADERS.has(name.toLowerCase())) continue
        const env = headerEnvName(name)
        if (envNames.includes(env)) continue
        envNames.push(env)
        headers[name] = `\${ENV:${env}}`
    }

    let origin: string | undefined
    const capturedUrl = connects[0]?.url ?? header.request?.url
    if (capturedUrl) {
        try { origin = new URL(capturedUrl).origin } catch { notes.push('The captured URL could not be parsed, so the origin was not recorded.') }
    }

    const target: Scenario['target'] = { url: '${ENV:STREAM_URL}' }
    if (Object.keys(headers).length > 0) target.headers = headers

    const sequence = sequenceOf(header.profile)
    if (sequence) target.sequence = sequence
    else notes.push('Sequence checks were left out because no sequence contract was declared in the capture profile. Add target.sequence to check for gaps, duplicates and ordering.')
    const delivery = deliveryOf(header.profile)
    if (delivery) target.delivery = delivery

    // Expectations from what the first response did.
    const expectBlock: NonNullable<Scenario['expect']> = {}
    if (response) {
        expectBlock.status = response.status
        const mediaType = response.contentType.split(';')[0]!.trim().toLowerCase()
        if (mediaType) expectBlock.content_type = mediaType
        if (response.status !== 200 || !/text\/event-stream/.test(mediaType)) {
            notes.push(`The captured response was ${response.status} ${mediaType || 'with no content type'}; the scenario expects the same. Change "expect" if that was the problem being investigated.`)
        }
    } else {
        notes.push('The capture has no response record, so the scenario does not check the status or content type.')
    }
    if (events.length > 0) {
        const observed = Math.max(0, events[0]!.t - startT)
        expectBlock.first_event_within_ms = Math.round(Math.max(1000, observed * 3) / 100) * 100
    } else {
        notes.push('The capture has no events, so the scenario waits for one event and does not check the time to the first event.')
    }

    // Steps: one collect step per connection segment, with a disconnect and reconnect between segments.
    const modelled = reconnects.slice(0, MAX_RECONNECTS)
    if (reconnects.length > modelled.length) notes.push(`The capture reconnected ${reconnects.length} times; only the first ${MAX_RECONNECTS} are in the scenario.`)
    const steps: ScenarioStep[] = []
    for (let i = 0; i <= modelled.length; i++) {
        const lo = i === 0 ? -Infinity : modelled[i - 1]!.seq
        const hi = modelled[i]?.seq ?? Infinity
        const inSegment = events.filter((e) => e.seq > lo && e.seq < hi)
        const from = i === 0 ? startT : modelled[i - 1]!.t
        const span = inSegment.length > 0 ? inSegment[inSegment.length - 1]!.t - from : 0
        steps.push({ collect_events: clamp(inSegment.length, 1, maxEvents), timeout_ms: clamp(Math.ceil((span * 3) / 1000) * 1000, 10_000, 120_000) })
        const next = modelled[i]
        if (next) {
            steps.push({ disconnect: { mode: /server/i.test(next.reason) ? 'server' : 'client' } })
            steps.push({ reconnect: { after_ms: Math.max(0, Math.round(next.delayMs / 100) * 100), resume_from_last_event_id: next.lastEventIdSent !== '' } })
        }
    }

    const { verify, threshold } = verifyFrom(analysis.findings)
    notes.push(`Set these environment variables before running: ${envNames.join(', ')}.`)

    const scenario: Scenario = {
        $schema: SCENARIO_SCHEMA_URL,
        version: 1,
        name: opts.name ?? 'scenario generated from a capture',
        target,
        ...(Object.keys(expectBlock).length > 0 ? { expect: expectBlock } : {}),
        steps,
        verify,
        fail_on_severity: threshold,
        meta: { ...(origin ? { origin } : {}), notes: [...notes] },
    }

    // Nothing generated here may carry a secret or break the format; if it does, that is a bug to surface, not to ship.
    const problems = validateScenario(scenario)
    if (problems.length > 0) throw new Error(`the generated scenario is not valid: ${problems.map((p) => `${p.pointer || '/'} ${p.message}`).join('; ')}`)
    return { scenario, notes }
}

/** The text of a scenario file. */
export const serializeScenario = (scenario: Scenario): string => JSON.stringify(scenario, null, 2) + '\n'
