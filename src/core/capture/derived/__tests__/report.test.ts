// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildReport } from '../report'
import { analyze, type Analysis, type RuleCoverage } from '../../../diagnostics'
import type { Finding } from '../../../diagnostics/finding'
import { newHeader } from '../../format'
import { capture, healthyStart } from '../../../testing/captureBuilder'
import { captureOf, redacted, textCapture } from './helpers'

const HOSTILE = `<script>alert("x")</script> & 'q' "d"`

function finding(over: Partial<Finding> = {}): Finding {
    return {
        key: 'x.test', ruleId: 'x', ruleVersion: 1, severity: 'warning', title: 'A title', summary: 'A summary.',
        facts: [{ text: 'A measured thing.', evidence: [{ seq: 4, t: 1500, note: 'response' }] }],
        deductions: [{ statement: 'Likely: something upstream.', confidence: 'medium', basis: [4], alternatives: ['another cause'] }],
        nextCheck: { description: 'Do the check.', command: 'curl -N x' },
        limits: ['Cannot see inside.'],
        status: 'open', firstSeenT: 1500, lastSeenT: 1500, occurrences: 1,
        ...over,
    }
}

const coverage = (over: Partial<RuleCoverage> = {}): RuleCoverage => ({ ruleId: 'r.x', ruleVersion: 1, title: 'A rule', status: 'evaluated', missingCapabilities: [], missingKinds: [], notes: [], ...over })

function analysisOf(findings: Finding[], cov: RuleCoverage[] = []): Analysis {
    return { ...analyze([]), findings, coverage: cov }
}

const withRequest = (c: ReturnType<typeof captureOf>) => redacted({ ...c, header: { ...c.header, request: { url: 'https://api.test/s?token=[redacted]', method: 'GET', headers: { Authorization: 'x' } } } })

describe('buildReport markdown', () => {
    it('shows header facts, findings by severity, measured facts and "Likely:" deductions', () => {
        const cap = withRequest(captureOf(healthyStart().frame('tick', '1').silence(1000).frame('tick', '2')))
        const md = buildReport(cap, analysisOf([
            finding({ key: 'a', severity: 'info', title: 'Quiet note', firstSeenT: 1 }),
            finding({ key: 'b', severity: 'error', title: 'Loud problem', firstSeenT: 9 }),
            finding({ key: 'c', severity: 'warning', title: 'Middle issue', deductions: [{ statement: 'no prefix here', confidence: 'low', basis: [], alternatives: [] }] }),
        ]))
        expect(md).toContain('# SSE Observatory report')
        expect(md).toContain('Kind: sanitized')
        expect(md).toContain('Duration: 1 s')
        expect(md).toMatch(/Records: .*chunk 2.*event 2/)
        const order = ['Loud problem', 'Middle issue', 'Quiet note'].map((t) => md.indexOf(t))
        expect(order.every((i) => i > 0)).toBe(true)
        expect([...order].sort((x, y) => x - y)).toEqual(order)
        expect(md).toContain('[ERROR]')
        expect(md).toContain('Observed:')
        expect(md).toContain('seq 4 at 1.5 s (response)')
        expect(md).toContain('Likely: something upstream.')
        expect(md).toContain('Likely: no prefix here') // a deduction without the prefix still reads as a guess
        expect(md).toContain('confidence: medium')
        expect(md).toContain('Other explanations: another cause')
        expect(md).toContain('Next check: Do the check.')
        expect(md).toContain('Limits:')
        expect(md).toContain('Cannot see inside.')
    })

    it('lists checks that could not run and does not present them as healthy', () => {
        const a = analyze(capture().connect().response().build()) // no chunks, so the stream rules cannot run
        const notEvaluated = a.coverage.filter((c) => c.status === 'not-evaluated')
        expect(notEvaluated.length).toBeGreaterThan(0)
        const md = buildReport(redacted(captureOf(capture().connect().response())), a)
        const section = md.slice(md.indexOf('## What we could not determine'))
        for (const c of notEvaluated) expect(section).toContain(c.title)
        expect(section).toContain('says nothing about whether the stream is healthy')
        const evaluated = a.coverage.find((c) => c.status === 'evaluated')
        if (evaluated) expect(section).not.toContain(`- ${evaluated.title} (${evaluated.ruleId})`)
    })

    it('says when every check could run, and when there are no findings', () => {
        const md = buildReport(redacted(captureOf(healthyStart())), analysisOf([], [coverage()]))
        expect(md).toContain('Every check could run on this capture.')
        expect(md).toContain('No finding was raised')
    })

    it('includes a Reproduce section with the curl output and the variables to set', () => {
        const md = buildReport(withRequest(captureOf(healthyStart())), analysisOf([]))
        const section = md.slice(md.indexOf('## Reproduce'))
        expect(section).toContain('curl -N')
        expect(section).toContain('${STREAM_AUTHORIZATION}')
        expect(section).toContain('`STREAM_TOKEN`')
        expect(section).toContain('curl.exe -N')
    })

    it('quotes at most 5 events and 200 characters each', () => {
        const events = Array.from({ length: 8 }, (_, i) => ({ id: String(i), data: i === 0 ? 'z'.repeat(500) : `payload-${i}` }))
        const md = buildReport(redacted(textCapture(events)), analysisOf([]))
        expect(md).toContain('## Event excerpts')
        expect(md).toContain('payload-4')
        expect(md).not.toContain('payload-5')
        expect(md).toContain('z'.repeat(200))
        expect(md).not.toContain('z'.repeat(201))
        expect(md).toContain('(cut)')
    })

    it('has no excerpt section when the capture has no payload text', () => {
        expect(buildReport(redacted(captureOf(healthyStart().frame('t', '1'))), analysisOf([]))).not.toContain('Event excerpts')
    })

    it('escapes Markdown in strings from the capture and keeps hostile text inside a longer fence', () => {
        const md = buildReport(redacted(textCapture([{ data: 'x ``` y\n```\n# not a heading' }])), analysisOf([finding({ title: '*bold* <b>x</b> [l](u)' })]))
        expect(md).toContain('\\*bold\\* \\<b\\>x\\</b\\> \\[l\\](u)')
        expect(md).toContain('````') // the fence is longer than any run of backticks in the excerpt
    })

    it('mentions what limits the capture itself', () => {
        const base = captureOf(healthyStart())
        const cap = redacted({ ...base, header: newHeader({ kind: 'sanitized', source: { kind: 'import-v1', synthetic: true }, limits: { truncated: true } }) })
        const md = buildReport(cap, analysisOf([]))
        expect(md).toContain('rebuilt from an imported recording')
        expect(md).toContain('size cap')
        expect(md).toContain('not finished')
    })
})

describe('buildReport html', () => {
    const hostileAnalysis = analysisOf(
        [finding({
            title: HOSTILE, summary: HOSTILE,
            facts: [{ text: HOSTILE, evidence: [{ seq: 1, t: 2, note: HOSTILE }] }],
            deductions: [{ statement: HOSTILE, confidence: 'low', basis: [], alternatives: [HOSTILE] }],
            nextCheck: { description: HOSTILE, command: HOSTILE }, limits: [HOSTILE], key: HOSTILE,
        })],
        [coverage({ status: 'not-evaluated', title: HOSTILE, ruleId: HOSTILE, notes: [HOSTILE] })],
    )
    const hostile = redacted({
        header: newHeader({ kind: 'sanitized', source: { kind: 'fixture', client: HOSTILE }, request: { url: `https://h.test/${HOSTILE}?a=[redacted]`, method: 'GET', headers: { [HOSTILE]: 'v' } } }),
        records: textCapture([{ event: HOSTILE, id: HOSTILE, data: HOSTILE }]).records,
    })

    it('is one self-contained document with inline CSS, no scripts and no external requests', () => {
        const html = buildReport(hostile, hostileAnalysis, { format: 'html' })
        expect(html.startsWith('<!doctype html>')).toBe(true)
        expect(html.match(/<html/g)).toHaveLength(1)
        expect(html).toContain('<style>')
        expect(html).toContain('prefers-color-scheme: dark')
        expect(html).toContain('color-scheme: light dark')
        expect(html).not.toMatch(/<link\b/i)
        expect(html).not.toMatch(/<script\b/i)
        expect(html).not.toMatch(/\s(src|href|srcset|action|formaction)\s*=/i)
        expect(html).not.toMatch(/@import|url\(/i)
        expect(html).toContain(`default-src 'none'`)
    })

    it('escapes every dynamic string, including titles, facts, notes, keys, excerpts and the request', () => {
        const html = buildReport(hostile, hostileAnalysis, { format: 'html' })
        const escaped = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39; &quot;d&quot;'
        expect(html).not.toContain('<script>alert')
        expect(html).not.toContain('alert("x")')
        // title, summary, fact, evidence note, statement, alternative, next check (twice), limit, key, rule title, rule id, note, event name, id, excerpt, request, client
        expect(html.split(escaped).length - 1).toBeGreaterThanOrEqual(15)
        // the only tags are the ones the report writes
        const tags = new Set([...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1]!.toLowerCase()))
        expect([...tags].sort()).toEqual(['body', 'code', 'dd', 'dl', 'dt', 'h1', 'h2', 'h3', 'h4', 'head', 'html', 'li', 'main', 'meta', 'ol', 'p', 'pre', 'section', 'span', 'style', 'title', 'ul'])
    })

    it('shows findings, the not-evaluated section and the reproduce commands', () => {
        const html = buildReport(withRequest(captureOf(healthyStart())), analysisOf([finding()], [coverage({ status: 'not-evaluated', title: 'Heartbeat', notes: ['Not evaluated: no comments.'] })]), { format: 'html' })
        expect(html).toContain('<h2>What we could not determine</h2>')
        expect(html).toContain('Not evaluated: no comments.')
        expect(html).toContain('class="finding warning"')
        expect(html).toContain('Likely: something upstream.')
        expect(html).toContain('$env:STREAM_AUTHORIZATION')
    })
})

describe('buildReport json', () => {
    it('is { schemaVersion: 1, capture, findings, coverage }', () => {
        const a = analysisOf([finding({ deductions: [{ statement: 'plain guess', confidence: 'low', basis: [], alternatives: [] }] })], [coverage({ status: 'not-evaluated', notes: ['n'] }), coverage({ ruleId: 'r.y' })])
        const out = buildReport(withRequest(captureOf(healthyStart().frame('tick', '1'))), a, { format: 'json' })
        const json = JSON.parse(out) as Record<string, unknown>
        expect(Object.keys(json).sort()).toEqual(['capture', 'coverage', 'findings', 'schemaVersion'])
        expect(json.schemaVersion).toBe(1)
        const cap = json.capture as Record<string, unknown>
        expect(cap.kind).toBe('sanitized')
        expect(cap.url).toBe('https://api.test/s?token=[redacted]')
        expect(cap.counts).toMatchObject({ chunk: 1, event: 1 })
        expect(typeof cap.durationMs).toBe('number')
        const findings = json.findings as Finding[]
        expect(findings).toHaveLength(1)
        expect(findings[0]!.deductions[0]!.statement).toBe('Likely: plain guess')
        expect((json.coverage as RuleCoverage[]).map((c) => c.status)).toEqual(['not-evaluated', 'evaluated'])
    })
})
