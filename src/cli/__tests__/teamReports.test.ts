import { describe, expect, it } from 'vitest'
import { main, EXIT, type CliIo } from '../index'
import { newHeader, serializeCapture } from '../../core/capture/format'
import { capture as build, healthyStart } from '../../core/testing/captureBuilder'
import { ISSUE_MARKER } from '../../core/capture/derived/report'

/** An in-memory host, as in commands.test.ts. */
function host(files: Record<string, string> = {}, env: Record<string, string> = {}) {
    const written: Record<string, string> = {}
    let out = ''
    let err = ''
    const io: CliIo = {
        out: (t) => { out += t }, err: (t) => { err += t },
        readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') },
        writeText: async (p, t) => { written[p] = t; files[p] = t },
        env,
    }
    return { io, written, get out() { return out }, get err() { return err } }
}

const asFile = (b: ReturnType<typeof build>, kind: 'local-full' | 'sanitized' = 'sanitized') =>
    serializeCapture({ header: newHeader({ kind, source: { kind: 'fixture' }, request: { url: 'https://api.test/s?token=[redacted]', method: 'GET', headers: {} } }), records: b.build() })

const wrongType = () => asFile(build().connect().response({ contentType: 'text/html' }))
const healthy = () => asFile(healthyStart().repeat(3, 500, (b, i) => b.frame('tick', String(i + 1))))

describe('report --format issue', () => {
    it('writes a body for a ticket: the verdict, the table, how to reproduce, the full report folded, and the marker last', async () => {
        const h = host({ 'bad.sse-capture': wrongType() })
        expect(await main(['report', 'bad.sse-capture', '--format', 'issue'], h.io)).toBe(EXIT.ok)
        expect(h.out).toMatch(/^## Stream check: \d+ findings?, worst error\n/)
        expect(h.out).toContain('| # | Severity | Finding | Seen |')
        expect(h.out).toContain('### How to reproduce')
        expect(h.out).toContain('<summary>Full report</summary>')
        expect(h.out.trimEnd().endsWith(ISSUE_MARKER)).toBe(true)
    })

    it('says plainly when there are no findings, and that this is not proof of health', async () => {
        const h = host({ 'ok.sse-capture': healthy() })
        await main(['report', 'ok.sse-capture', '--format', 'issue'], h.io)
        expect(h.out).toMatch(/^## Stream check: no findings\n/)
        expect(h.out).toContain('No finding was raised by the checks that could run.')
    })

    it('goes to a file with --output, and a full local capture still needs --redact', async () => {
        const h = host({ 'bad.sse-capture': wrongType(), 'raw.sse-capture': asFile(build().connect().response({ contentType: 'text/html' }), 'local-full') })
        expect(await main(['report', 'bad.sse-capture', '--format', 'issue', '--output', 'issue.md'], h.io)).toBe(EXIT.ok)
        expect(h.written['issue.md']).toContain('## Stream check')
        const refused = host({ 'raw.sse-capture': asFile(build().connect().response({ contentType: 'text/html' }), 'local-full') })
        expect(await main(['report', 'raw.sse-capture', '--format', 'issue'], refused.io)).toBe(EXIT.usage)
        const allowed = host({ 'raw.sse-capture': asFile(build().connect().response({ contentType: 'text/html' }), 'local-full') })
        expect(await main(['report', 'raw.sse-capture', '--format', 'issue', '--redact'], allowed.io)).toBe(EXIT.ok)
    })

    it('names the format in the error for one that does not exist', async () => {
        const h = host({ 'ok.sse-capture': healthy() })
        expect(await main(['report', 'ok.sse-capture', '--format', 'pdf'], h.io)).toBe(EXIT.usage)
        expect(h.err).toContain('md, html, json or issue')
    })
})

describe('test --summary', () => {
    const scenario = JSON.stringify({
        version: 1, name: 'a steady stream',
        target: { url: 'fixture://h01?scale=0.05&n=6' },
        expect: { status: 200, content_type: 'text/event-stream' },
        steps: [{ collect_events: 3, timeout_ms: 10000 }],
        fail_on_severity: 'error',
    })

    it('writes a Markdown summary whatever the output format is, and still prints in that format', async () => {
        const h = host({ 's.json': scenario })
        expect(await main(['test', 's.json', '--format', 'junit', '--summary', 'sum.md'], h.io)).toBe(EXIT.ok)
        expect(h.out).toContain('<testsuite')
        expect(h.written['sum.md']).toContain('## sse-doctor scenarios')
        expect(h.written['sum.md']).toContain('a steady stream')
    })

    it('writes nothing extra without the option', async () => {
        const h = host({ 's.json': scenario })
        await main(['test', 's.json'], h.io)
        expect(Object.keys(h.written)).toEqual([])
    })

    it('writes the summary for a failing run too, so a comment can say what failed', async () => {
        const failing = JSON.stringify({ ...JSON.parse(scenario), expect: { status: 418 } })
        const h = host({ 'f.json': failing })
        expect(await main(['test', 'f.json', '--summary', 'sum.md'], h.io)).toBe(EXIT.gateFailed)
        expect(h.written['sum.md']).toMatch(/fail/i)
    })
})
