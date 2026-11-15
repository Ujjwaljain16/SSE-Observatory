/**
 * What a shared report says, before it is written out as Markdown, HTML or JSON. Building it once keeps the three
 * formats from drifting apart.
 */

import type { Analysis, RuleCoverage } from '../../diagnostics/engine'
import { SEVERITY_RANK, type Finding } from '../../diagnostics/finding'
import { countByKind } from '../format'
import type { RedactedCapture } from '../redacted'
import { framesOf } from '../streamText'
import { toCurl } from './curl'
import { durationOf, ofKind } from './records'

export const EXCERPT_EVENTS = 5
export const EXCERPT_CHARS = 200

export interface ReportExcerpt {
    n: number
    event: string
    id: string
    text: string
    /** True when the event text was longer than the excerpt limit. */
    cut: boolean
}

export interface CaptureSummary {
    kind: string
    source: { kind: string; client?: string | undefined; synthetic?: boolean | undefined }
    createdAt: string
    tool: { name: string; version: string }
    url?: string | undefined
    method?: string | undefined
    durationMs: number
    endReason?: string | undefined
    counts: Record<string, number>
    redaction?: { policy: string; version: number; placeholders: number } | undefined
}

export interface ReportModel {
    capture: CaptureSummary
    findings: Finding[]
    coverage: RuleCoverage[]
    notEvaluated: RuleCoverage[]
    /** Things about the capture itself that limit what any reader can conclude. */
    caveats: string[]
    excerpts: ReportExcerpt[]
    reproduce: { posix: string; powershell: string; variables: string[] }
}

/** The first `max` code points, so a surrogate pair is never cut in half. */
function clip(text: string, max: number): { text: string; cut: boolean } {
    const points = Array.from(text)
    return points.length <= max ? { text, cut: false } : { text: points.slice(0, max).join(''), cut: true }
}

export function buildReportModel(capture: RedactedCapture, analysis: Analysis): ReportModel {
    const h = capture.header
    const connect = ofKind(capture.records, 'connect')[0]
    const url = h.request?.url ?? connect?.url
    const method = h.request?.method ?? connect?.method

    const summary: CaptureSummary = {
        kind: h.kind,
        source: { kind: h.source.kind, client: h.source.client, synthetic: h.source.synthetic },
        createdAt: h.createdAt,
        tool: h.tool,
        url,
        method,
        durationMs: durationOf(capture.records),
        endReason: capture.footer?.endReason,
        counts: countByKind(capture.records),
        redaction: h.redaction ? { policy: h.redaction.policy, version: h.redaction.version, placeholders: h.redaction.placeholders } : undefined,
    }

    const findings = [...analysis.findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.firstSeenT - b.firstSeenT || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((f) => ({ ...f, deductions: f.deductions.map((d) => ({ ...d, statement: likely(d.statement) })) }))
    const notEvaluated = analysis.coverage.filter((c) => c.status === 'not-evaluated')

    const caveats: string[] = []
    if (h.source.synthetic) caveats.push('The timeline was rebuilt from an imported recording, not measured. Timings in this report are approximate.')
    if (h.limits?.truncated) caveats.push('The recorder stopped at its size cap. Anything after that point is not in this capture.')
    if (!capture.footer || capture.footer.endReason === 'crashed') caveats.push('The capture was not finished (no footer, or the recorder crashed). It may end before the stream did.')
    if (summary.redaction) caveats.push(`Payload text and query values were redacted (${summary.redaction.placeholders} placeholders), so this report cannot show them.`)

    const excerpts: ReportExcerpt[] = framesOf(capture).slice(0, EXCERPT_EVENTS).map((f, i) => {
        const visible = f.data.replace(/\r/g, '\\r').replace(/\n/g, '\\n')
        const { text, cut } = clip(visible, EXCERPT_CHARS)
        return { n: i + 1, event: f.event, id: f.id, text, cut }
    })

    const posix = toCurl(capture, { shell: 'posix' })
    const powershell = toCurl(capture, { shell: 'powershell' })
    const variables = [...new Set(posix.match(/\$\{STREAM_[A-Z0-9_]+\}/g) ?? [])].map((v) => v.slice(2, -1))

    return { capture: summary, findings, coverage: analysis.coverage, notEvaluated, caveats, excerpts, reproduce: { posix, powershell, variables } }
}

/** Deductions are always worded as guesses. A rule that forgot the prefix still reaches the reader as one. */
export function likely(statement: string): string {
    return /^likely:/i.test(statement.trim()) ? statement.trim() : `Likely: ${statement.trim()}`
}
