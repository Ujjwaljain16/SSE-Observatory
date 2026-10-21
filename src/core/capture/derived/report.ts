/**
 * A report for sharing: what a capture showed and what could not be told from it, as Markdown, one self-contained HTML
 * page, or JSON. It takes a RedactedCapture only, because it may quote event text and rebuild the request.
 *
 * Wording policy, as in the engine: observations are measurements, deductions start "Likely:", and a check that could
 * not run is listed as not evaluated, never as healthy.
 */

import type { Analysis } from '../../diagnostics/engine'
import type { Evidence, Finding } from '../../diagnostics/finding'
import { fmtMs } from '../../diagnostics/rules/util'
import type { RedactedCapture } from '../redacted'
import { buildReportModel, likely, type ReportModel } from './reportModel'

export type ReportFormat = 'md' | 'html' | 'json'

export interface ReportOptions { format?: ReportFormat | undefined }

const evidenceText = (e: Evidence): string => `seq ${e.seq} at ${fmtMs(e.t)}${e.note ? ` (${e.note})` : ''}`
const countsText = (counts: Record<string, number>): string => {
    const entries = Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))
    return entries.length === 0 ? 'no records' : entries.map(([k, n]) => `${k} ${n}`).join(', ')
}
const sourceText = (m: ReportModel): string => {
    const s = m.capture.source
    return [s.kind, s.client, s.synthetic ? 'rebuilt, not measured' : undefined].filter(Boolean).join(', ')
}
const occurrenceText = (f: Finding): string =>
    `${f.occurrences} ${f.occurrences === 1 ? 'time' : 'times'} (first at ${fmtMs(f.firstSeenT)}, last at ${fmtMs(f.lastSeenT)}), ${f.status}`

const NOT_EVALUATED_NOTE = 'These checks could not run on this capture. That says nothing about whether the stream is healthy for them.'

// ---------------------------------------------------------------- Markdown

/** Escapes what Markdown would act on. Applied to every string that came from the capture or a rule. */
const mdText = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/[\\`*_[\]<>|#~]/g, '\\$&')

function fenced(text: string, lang = ''): string {
    const longest = (text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0)
    const fence = '`'.repeat(Math.max(3, longest + 1))
    return `${fence}${lang}\n${text}\n${fence}`
}

function renderMarkdown(m: ReportModel): string {
    const out: string[] = []
    const c = m.capture
    out.push('# SSE Observatory report', '')
    out.push(`- Kind: ${mdText(c.kind)}`)
    out.push(`- Source: ${mdText(sourceText(m))}`)
    if (c.url) out.push(`- Request: ${mdText(c.method ?? 'GET')} ${mdText(c.url)}`)
    out.push(`- Recorded: ${mdText(c.createdAt)} by ${mdText(`${c.tool.name} ${c.tool.version}`)}`)
    out.push(`- Duration: ${fmtMs(c.durationMs)}`)
    if (c.endReason) out.push(`- Ended: ${mdText(c.endReason)}`)
    out.push(`- Records: ${mdText(countsText(c.counts))}`, '')

    out.push(`## Findings (${m.findings.length})`, '')
    if (m.findings.length === 0) out.push('No finding was raised by the checks that could run. See the section below for the ones that could not.', '')
    m.findings.forEach((f, i) => {
        out.push(`### ${i + 1}. [${f.severity.toUpperCase()}] ${mdText(f.title)}`, '')
        out.push(mdText(f.summary), '')
        out.push(`Check ${mdText(f.key)}. Seen ${occurrenceText(f)}.`, '')
        if (f.facts.length > 0) {
            out.push('Observed:')
            for (const fact of f.facts) {
                out.push(`- ${mdText(fact.text)}${fact.evidence.length ? ` [${fact.evidence.map((e) => mdText(evidenceText(e))).join('; ')}]` : ''}`)
            }
            out.push('')
        }
        if (f.deductions.length > 0) {
            out.push('Deduced:')
            for (const d of f.deductions) {
                const alt = d.alternatives.length ? ` Other explanations: ${d.alternatives.map(mdText).join('; ')}` : ''
                out.push(`- ${mdText(likely(d.statement))} (confidence: ${d.confidence}).${alt}`)
            }
            out.push('')
        }
        if (f.nextCheck) {
            out.push(`Next check: ${mdText(f.nextCheck.description)}${f.nextCheck.command ? ` \`${f.nextCheck.command.replace(/`/g, "'")}\`` : ''}`, '')
        }
        if (f.limits.length > 0) {
            out.push('Limits:')
            for (const l of f.limits) out.push(`- ${mdText(l)}`)
            out.push('')
        }
    })

    out.push('## What we could not determine', '')
    if (m.notEvaluated.length === 0) out.push('Every check could run on this capture.', '')
    if (m.notEvaluated.length > 0) {
        out.push(NOT_EVALUATED_NOTE, '')
        for (const cov of m.notEvaluated) {
            out.push(`- ${mdText(cov.title)} (${mdText(cov.ruleId)}): ${cov.notes.length ? cov.notes.map(mdText).join(' ') : 'not evaluated.'}`)
        }
        out.push('')
    }
    if (m.caveats.length > 0) {
        out.push('About this capture:')
        for (const cav of m.caveats) out.push(`- ${mdText(cav)}`)
        out.push('')
    }

    if (m.excerpts.length > 0) {
        out.push('## Event excerpts', '', `The first ${m.excerpts.length} events as recorded after redaction, cut at 200 characters.`, '')
        for (const x of m.excerpts) {
            out.push(`${x.n}. event \`${x.event.replace(/`/g, "'")}\`${x.id ? `, id \`${x.id.replace(/`/g, "'")}\`` : ''}${x.cut ? ' (cut)' : ''}`, '')
            out.push(fenced(x.text), '')
        }
    }

    out.push('## Reproduce', '')
    out.push('The command repeats the request. Header and query values are not in it: set these environment variables first.', '')
    if (m.reproduce.variables.length > 0) out.push(m.reproduce.variables.map((v) => `- \`${v}\``).join('\n'), '')
    out.push('POSIX shell:', '', fenced(m.reproduce.posix, 'sh'), '', 'PowerShell:', '', fenced(m.reproduce.powershell, 'powershell'), '')
    return out.join('\n')
}

// ---------------------------------------------------------------- HTML

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const CSS = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1b1f24; --muted: #5b6570; --line: #d6dbe0; --panel: #f5f7f9; --info: #2d6cdf; --warning: #a15c00; --error: #b42318; --critical: #8f1d6b; }
@media (prefers-color-scheme: dark) { :root { --bg: #14171a; --fg: #e6e9ec; --muted: #9aa5b1; --line: #2e353c; --panel: #1c2024; --info: #7aa7ff; --warning: #f0b45a; --error: #ff8a7d; --critical: #f08fd0; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 12px; }
h2 { font-size: 1.2rem; margin: 32px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
h3 { font-size: 1.02rem; margin: 0 0 6px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
section.finding { background: var(--panel); border: 1px solid var(--line); border-left-width: 4px; border-radius: 6px; padding: 12px 14px; margin: 12px 0; }
section.finding.info { border-left-color: var(--info); }
section.finding.warning { border-left-color: var(--warning); }
section.finding.error { border-left-color: var(--error); }
section.finding.critical { border-left-color: var(--critical); }
.sev { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; margin-right: 6px; }
.sev.info { color: var(--info); } .sev.warning { color: var(--warning); } .sev.error { color: var(--error); } .sev.critical { color: var(--critical); }
.muted { color: var(--muted); font-size: 0.9rem; }
h4 { font-size: 0.85rem; color: var(--muted); margin: 10px 0 2px; text-transform: uppercase; letter-spacing: 0.04em; }
ul, ol { margin: 4px 0; padding-left: 22px; }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; overflow-x: auto; margin: 6px 0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
`

function renderHtml(m: ReportModel): string {
    const c = m.capture
    const out: string[] = []
    out.push('<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">')
    // nothing in this page loads anything; the policy keeps it that way even if an escape were ever missed
    out.push(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">`)
    out.push('<title>SSE Observatory report</title>', `<style>${CSS}</style>`, '</head>', '<body>', '<main>', '<h1>SSE Observatory report</h1>')

    const rows: Array<[string, string]> = [['Kind', c.kind], ['Source', sourceText(m)]]
    if (c.url) rows.push(['Request', `${c.method ?? 'GET'} ${c.url}`])
    rows.push(['Recorded', `${c.createdAt} by ${c.tool.name} ${c.tool.version}`], ['Duration', fmtMs(c.durationMs)])
    if (c.endReason) rows.push(['Ended', c.endReason])
    rows.push(['Records', countsText(c.counts)])
    out.push('<dl>', ...rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`), '</dl>')

    out.push(`<h2>Findings (${m.findings.length})</h2>`)
    if (m.findings.length === 0) out.push('<p>No finding was raised by the checks that could run. See the section below for the ones that could not.</p>')
    m.findings.forEach((f, i) => {
        const sev = SEVERITY_CLASSES.has(f.severity) ? f.severity : 'info' // only a known word is ever written into an attribute
        out.push(`<section class="finding ${sev}">`)
        out.push(`<h3><span class="sev ${sev}">${esc(sev)}</span>${i + 1}. ${esc(f.title)}</h3>`)
        out.push(`<p>${esc(f.summary)}</p>`, `<p class="muted">Check ${esc(f.key)}. Seen ${esc(occurrenceText(f))}.</p>`)
        if (f.facts.length > 0) {
            out.push('<h4>Observed</h4>', '<ul>')
            for (const fact of f.facts) {
                out.push(`<li>${esc(fact.text)}${fact.evidence.length ? ` <span class="muted">[${fact.evidence.map((e) => esc(evidenceText(e))).join('; ')}]</span>` : ''}</li>`)
            }
            out.push('</ul>')
        }
        if (f.deductions.length > 0) {
            out.push('<h4>Deduced</h4>', '<ul>')
            for (const d of f.deductions) {
                const alt = d.alternatives.length ? ` <span class="muted">Other explanations: ${d.alternatives.map(esc).join('; ')}</span>` : ''
                out.push(`<li>${esc(likely(d.statement))} <span class="muted">(confidence: ${esc(d.confidence)})</span>${alt}</li>`)
            }
            out.push('</ul>')
        }
        if (f.nextCheck) {
            out.push('<h4>Next check</h4>', `<p>${esc(f.nextCheck.description)}${f.nextCheck.command ? ` <code>${esc(f.nextCheck.command)}</code>` : ''}</p>`)
        }
        if (f.limits.length > 0) out.push('<h4>Limits</h4>', '<ul>', ...f.limits.map((l) => `<li>${esc(l)}</li>`), '</ul>')
        out.push('</section>')
    })

    out.push('<h2>What we could not determine</h2>')
    if (m.notEvaluated.length === 0) out.push('<p>Every check could run on this capture.</p>')
    if (m.notEvaluated.length > 0) {
        out.push(`<p>${esc(NOT_EVALUATED_NOTE)}</p>`, '<ul>')
        for (const cov of m.notEvaluated) out.push(`<li>${esc(cov.title)} <span class="muted">(${esc(cov.ruleId)})</span>: ${esc(cov.notes.length ? cov.notes.join(' ') : 'not evaluated.')}</li>`)
        out.push('</ul>')
    }
    if (m.caveats.length > 0) out.push('<h4>About this capture</h4>', '<ul>', ...m.caveats.map((x) => `<li>${esc(x)}</li>`), '</ul>')

    if (m.excerpts.length > 0) {
        out.push('<h2>Event excerpts</h2>', `<p class="muted">The first ${m.excerpts.length} events as recorded after redaction, cut at 200 characters.</p>`, '<ol>')
        for (const x of m.excerpts) {
            out.push(`<li>event <code>${esc(x.event)}</code>${x.id ? `, id <code>${esc(x.id)}</code>` : ''}${x.cut ? ' (cut)' : ''}<pre>${esc(x.text)}</pre></li>`)
        }
        out.push('</ol>')
    }

    out.push('<h2>Reproduce</h2>', '<p>The command repeats the request. Header and query values are not in it: set these environment variables first.</p>')
    if (m.reproduce.variables.length > 0) out.push('<ul>', ...m.reproduce.variables.map((v) => `<li><code>${esc(v)}</code></li>`), '</ul>')
    out.push('<h4>POSIX shell</h4>', `<pre>${esc(m.reproduce.posix)}</pre>`, '<h4>PowerShell</h4>', `<pre>${esc(m.reproduce.powershell)}</pre>`)
    out.push('</main>', '</body>', '</html>')
    return out.join('\n') + '\n'
}

// ---------------------------------------------------------------- entry point

const SEVERITY_CLASSES = new Set<string>(['info', 'warning', 'error', 'critical'])

export function buildReport(capture: RedactedCapture, analysis: Analysis, opts: ReportOptions = {}): string {
    const model = buildReportModel(capture, analysis)
    switch (opts.format ?? 'md') {
        case 'html': return renderHtml(model)
        case 'json': return JSON.stringify({ schemaVersion: 1, capture: model.capture, findings: model.findings, coverage: model.coverage }, null, 2) + '\n'
        default: return renderMarkdown(model)
    }
}
