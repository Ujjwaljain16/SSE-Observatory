/**
 * What can be taken out of the Doctor, and how each thing is made safe to share. Pure functions over a capture, so the
 * dialog only has to show their result.
 *
 * Two kinds of output:
 *  - the local capture, which is the recording as it is and may contain secrets: never to be shared;
 *  - everything else, which is made from `redactCapture()`'s result only (the types enforce it), with the redaction
 *    report and the scan for what still looks secret handed back so a person can look before anything is saved.
 */

import { analyze } from '../core/diagnostics/engine'
import type { EngineInput } from '../core/diagnostics/streamModel'
import { redactCapture, scanResidual, RedactionError, type RedactionReport, type ResidualHit } from '../core/capture/redact'
import { captureEndT, serializeCapture, type Capture } from '../core/capture/format'
import { buildReport } from '../core/capture/derived/report'
import { toCurl, type CurlShell } from '../core/capture/derived/curl'
import { minimizeCapture } from '../core/capture/derived/minimize'
import { serializeScenario, toScenario } from '../core/scenario/toScenario'

export type ArtifactKind = 'capture-local' | 'capture-shared' | 'report-md' | 'report-html' | 'report-json' | 'curl' | 'scenario' | 'repro'

export interface ArtifactChoice {
    kind: ArtifactKind
    label: string
    description: string
    /** Made from the redacted capture, so it may leave the machine once the scan is clear or acknowledged. */
    shareable: boolean
}

export const ARTIFACTS: ArtifactChoice[] = [
    { kind: 'report-md', label: 'Report (Markdown)', description: 'The findings, the evidence and what could not be determined, redacted, ready to paste into a ticket.', shareable: true },
    { kind: 'report-html', label: 'Report (HTML)', description: 'The same report as one self-contained page that makes no outside requests.', shareable: true },
    { kind: 'report-json', label: 'Report (JSON)', description: 'The same report as data, for other tools.', shareable: true },
    { kind: 'capture-shared', label: 'Capture to share (.sse-capture)', description: 'The recording with secrets replaced by numbered placeholders. Opens in the CLI and can be replayed.', shareable: true },
    { kind: 'curl', label: 'curl command', description: 'Repeats the request. Header and query values are not in it; it names the environment variables to set.', shareable: true },
    { kind: 'scenario', label: 'Test scenario (JSON)', description: 'Turns what this capture showed into a test that sse-doctor can run in CI. Secrets come from environment variables.', shareable: true },
    { kind: 'repro', label: 'Smallest capture that still shows a finding', description: 'Removes records until nothing more can go and the chosen finding still appears. Redacted.', shareable: true },
    { kind: 'capture-local', label: 'Full local capture (.sse-capture)', description: 'The recording exactly as held in this tab. It may contain secrets. Keep it on this machine.', shareable: false },
]

export interface ArtifactOptions {
    shell?: CurlShell
    /** For the smallest-capture choice: the finding key to keep reproducing. */
    findingKey?: string
}

export interface Prepared {
    kind: ArtifactKind
    filename: string
    mime: string
    text: string
    shareable: boolean
    /** What redaction replaced (shareable artifacts only). */
    redaction?: RedactionReport
    /** What still looks secret after redaction. Empty means the scan found nothing. */
    residual: ResidualHit[]
    notes: string[]
}

const stem = (capture: Capture): string => `sse-${(capture.header.captureId ?? 'capture').slice(0, 8)}`

export function prepare(kind: ArtifactKind, capture: Capture, options: ArtifactOptions = {}): Prepared {
    const base = stem(capture)
    if (kind === 'capture-local') {
        return { kind, filename: `${base}.local.sse-capture`, mime: 'application/x-ndjson', text: serializeCapture(capture), shareable: false, residual: [], notes: ['This file is not redacted.'] }
    }

    let source = capture
    const notes: string[] = []
    if (kind === 'repro') {
        if (!options.findingKey) throw new RedactionError('Choose which finding the smaller capture must still show.')
        const result = minimizeCapture(capture, options.findingKey, { maxRuns: 400, ...(capture.header.profile ? { profile: capture.header.profile } : {}) })
        if (!result.reproduced) notes.push('That finding does not appear when the capture is analysed again, so the capture is unchanged.')
        else notes.push(`Reduced from ${result.originalRecords} to ${result.minimalRecords} records in ${result.runs} runs${result.complete ? '' : ' (stopped at the run limit, so it may be reducible further)'}.`)
        source = result.capture
    }

    const { capture: safe, report } = redactCapture(source)
    const residual = scanResidual(safe)
    const endT = captureEndT(safe)
    const analysis = () => analyze(safe.records as EngineInput[], { endT, ...(safe.header.profile ? { profile: safe.header.profile } : {}) })
    notes.push(...report.idWarnings)
    const shared = { shareable: true, redaction: report, residual }

    switch (kind) {
        case 'capture-shared':
            return { kind, filename: `${base}.sse-capture`, mime: 'application/x-ndjson', text: serializeCapture(safe), ...shared, notes }
        case 'repro':
            return { kind, filename: `${base}.minimal.sse-capture`, mime: 'application/x-ndjson', text: serializeCapture(safe), ...shared, notes }
        case 'report-md':
            return { kind, filename: `${base}.report.md`, mime: 'text/markdown', text: buildReport(safe, analysis(), { format: 'md' }), ...shared, notes }
        case 'report-html':
            return { kind, filename: `${base}.report.html`, mime: 'text/html', text: buildReport(safe, analysis(), { format: 'html' }), ...shared, notes }
        case 'report-json':
            return { kind, filename: `${base}.report.json`, mime: 'application/json', text: buildReport(safe, analysis(), { format: 'json' }), ...shared, notes }
        case 'curl':
            return { kind, filename: `${base}.curl.sh`, mime: 'text/x-shellscript', text: toCurl(safe, { shell: options.shell ?? 'posix' }) + '\n', ...shared, notes }
        case 'scenario': {
            const { scenario, notes: scenarioNotes } = toScenario(safe, analysis())
            return { kind, filename: `${base}.scenario.json`, mime: 'application/json', text: serializeScenario(scenario), ...shared, notes: [...notes, ...scenarioNotes] }
        }
        default:
            throw new RedactionError(`Unknown export: ${String(kind)}`)
    }
}
