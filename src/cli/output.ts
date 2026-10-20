import { SEVERITY_RANK, type Finding, type Severity } from '../core/diagnostics/finding'
import type { RuleCoverage } from '../core/diagnostics/engine'
import { CliError, EXIT } from './io'

export type OutputFormat = 'human' | 'json' | 'md' | 'junit'

export interface Result {
    command: string
    subject: string
    findings: Finding[]
    coverage: RuleCoverage[]
    notes: string[]
}

export function parseFormat(raw: string | undefined): OutputFormat {
    if (raw === undefined) return 'human'
    if (raw === 'human' || raw === 'json' || raw === 'md' || raw === 'junit') return raw
    throw new CliError(`--format must be human, json, md or junit, got "${raw}".`, EXIT.usage)
}

export function parseFailOn(raw: string | undefined): Severity {
    if (raw === undefined) return 'error'
    if (raw === 'info' || raw === 'warning' || raw === 'error' || raw === 'critical') return raw
    throw new CliError(`--fail-on must be info, warning, error or critical, got "${raw}".`, EXIT.usage)
}

/** 1 when an open finding reaches the threshold, otherwise 0. A resolved finding is history, not a failure. */
export function gate(findings: Finding[], failOn: Severity): number {
    return findings.some((f) => f.status === 'open' && SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) ? EXIT.gateFailed : EXIT.ok
}

const LABEL: Record<Severity, string> = { info: 'INFO', warning: 'WARN', error: 'ERROR', critical: 'CRITICAL' }

const evidenceText = (f: Finding): string => {
    const seqs = [...new Set(f.facts.flatMap((fact) => fact.evidence.map((e) => e.seq)))].slice(0, 8)
    return seqs.length > 0 ? ` (records ${seqs.join(', ')})` : ''
}

function human(r: Result, verbose: boolean): string {
    const lines = [`sse-doctor ${r.command}: ${r.subject}`, '']
    if (r.findings.length === 0) lines.push('No findings.')
    for (const f of r.findings) {
        lines.push(`[${LABEL[f.severity]}] ${f.title}  (${f.key}${f.occurrences > 1 ? `, ${f.occurrences} times` : ''}${f.status === 'resolved' ? ', resolved' : ''})`)
        lines.push(`  ${f.summary}`)
        for (const fact of f.facts.slice(0, verbose ? 99 : 2)) lines.push(`  - ${fact.text}${evidenceText({ ...f, facts: [fact] })}`)
        for (const d of f.deductions) lines.push(`  ${d.statement} [${d.confidence} confidence]`)
        if (f.nextCheck) lines.push(`  Next check: ${f.nextCheck.description}${f.nextCheck.command ? `  $ ${f.nextCheck.command}` : ''}`)
        if (verbose) for (const l of f.limits) lines.push(`  Limit: ${l}`)
        lines.push('')
    }
    const skipped = r.coverage.filter((c) => c.status === 'not-evaluated')
    if (skipped.length > 0) {
        lines.push('Not evaluated (this is not the same as healthy):')
        for (const c of skipped) lines.push(`  - ${c.title}: ${c.notes[0] ?? `needs ${c.missingCapabilities.join(', ')}`}`)
        lines.push('')
    }
    for (const note of r.notes) lines.push(note)
    return lines.join('\n').trimEnd() + '\n'
}

function markdown(r: Result): string {
    const lines = [`## sse-doctor ${r.command}`, '', `Subject: \`${r.subject}\``, '']
    if (r.findings.length === 0) lines.push('No findings.', '')
    for (const f of r.findings) {
        lines.push(`### ${LABEL[f.severity]}: ${f.title}`, '', `\`${f.key}\`${f.occurrences > 1 ? `, ${f.occurrences} times` : ''}`, '', f.summary, '')
        for (const fact of f.facts) lines.push(`- ${fact.text}${evidenceText({ ...f, facts: [fact] })}`)
        for (const d of f.deductions) lines.push(`- ${d.statement} _(${d.confidence} confidence)_`)
        if (f.nextCheck) lines.push(`- Next check: ${f.nextCheck.description}`)
        lines.push('')
    }
    const skipped = r.coverage.filter((c) => c.status === 'not-evaluated')
    if (skipped.length > 0) {
        lines.push('### Not evaluated', '', 'Not evaluated is not the same as healthy.', '')
        for (const c of skipped) lines.push(`- ${c.title}: ${c.notes[0] ?? ''}`)
        lines.push('')
    }
    return lines.join('\n').trimEnd() + '\n'
}

const xml = (s: string): string => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!)

/** One testsuite, one testcase per rule. A rule with an open finding at or above the threshold fails; a rule that could not look is skipped. */
function junit(r: Result, failOn: Severity): string {
    const cases = r.coverage.map((c) => {
        const own = r.findings.filter((f) => f.ruleId === c.ruleId)
        const failing = own.filter((f) => f.status === 'open' && SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn])
        const body = c.status === 'not-evaluated'
            ? `<skipped message="${xml(c.notes[0] ?? 'not evaluated')}"/>`
            : failing.length > 0
                ? `<failure message="${xml(failing.map((f) => f.summary).join(' | '))}">${xml(failing.map((f) => `${f.key}: ${f.facts.map((x) => x.text).join(' ')}`).join('\n'))}</failure>`
                : ''
        return `    <testcase classname="sse-doctor.${xml(r.command)}" name="${xml(c.ruleId)}">${body}</testcase>`
    })
    const failures = r.coverage.filter((c) => c.status === 'evaluated' && r.findings.some((f) => f.ruleId === c.ruleId && f.status === 'open' && SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn])).length
    const skipped = r.coverage.filter((c) => c.status === 'not-evaluated').length
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="${xml(`sse-doctor ${r.command} ${r.subject}`)}" tests="${r.coverage.length}" failures="${failures}" skipped="${skipped}">\n${cases.join('\n')}\n  </testsuite>\n</testsuites>\n`
}

export function render(r: Result, format: OutputFormat, opts: { failOn: Severity; verbose: boolean }): string {
    switch (format) {
        case 'json': return JSON.stringify({ schemaVersion: 1, command: r.command, subject: r.subject, findings: r.findings, coverage: r.coverage, notes: r.notes }, null, 2) + '\n'
        case 'md': return markdown(r)
        case 'junit': return junit(r, opts.failOn)
        default: return human(r, opts.verbose)
    }
}
