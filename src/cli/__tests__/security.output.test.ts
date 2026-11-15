// @vitest-environment node
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { main, type CliIo } from '../index'
import { newHeader, serializeCapture, type Capture } from '../../core/capture/format'
import { capture } from '../../core/testing/captureBuilder'

// jsdom has no type declarations here and is only a test oracle (its XML parser is strict), so it is loaded without them
interface Doc { getElementsByTagName(n: string): ArrayLike<unknown>; querySelectorAll(s: string): ArrayLike<{ attributes: ArrayLike<{ name: string }> }> }
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, o?: { contentType: string }) => { window: { document: Doc } } }

// Campaign E3, output sanitisation end to end. A server controls the text that ends up in the Doctor's findings (a content type, a field name,
// an event name, an id). Whatever it sends must not be able to drive the user's terminal, break the XML that CI reads, or inject markup into a
// report. The unit tests of `sanitizeText` and `render` (hardening.test.ts, S13) use a hand-made result; this feeds hostile bytes in at the
// input and reads every command's output at the other end, with a real XML parser (jsdom's, which is strict) as the oracle for JUnit.

const ESC = '\u001b'
const HOSTILE = `weird${'\u0001'}${'\u0000'}${ESC}[2J${ESC}]0;pwned\u0007<img src=x onerror=alert(1)>]]>&amp;${'\u009b'}31m`
/** Any raw C0 control (but tab, LF, CR), DEL, C1, or an XML-illegal noncharacter. */
const RAW_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]|￾|￿/

function host(files: Record<string, string> = {}, env: Record<string, string> = {}) {
    let out = ''
    let err = ''
    const io: CliIo = { out: (t) => { out += t }, err: (t) => { err += t }, readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') }, writeText: async (p, t) => { files[p] = t }, env }
    return { io, files, get out() { return out }, get err() { return err } }
}

const servers: http.Server[] = []
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() } })
async function serve(handler: http.RequestListener): Promise<string> {
    const s = http.createServer(handler)
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

/** A capture whose every piece of server-controlled text is hostile. */
function hostileCapture(): string {
    const b = capture().connect({ url: 'http://stream.test/events' }).response({ contentType: `text/plain${HOSTILE}`, headers: { [`x-${'evil'}`]: HOSTILE } })
        .at(200).frame(HOSTILE, '1').violation('UNKNOWN_FIELD', `The field "${HOSTILE}" is not part of the protocol.`).violation('UNKNOWN_FIELD', HOSTILE)
        .silence(500).frame('message', HOSTILE)
    const c: Capture = { header: newHeader({ kind: 'local-full', source: { kind: 'cli' } }), records: b.build() as never }
    return serializeCapture(c)
}

/** What a live server can do: header values cannot carry control bytes, but the body can (field names, ids, event names). */
const hostileBody = (_: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`id: ${HOSTILE}\nevent: ${HOSTILE}\ndata: one\n\n`)
    res.write(`${'\u0001'}evil${ESC}[31m${ESC}]0;title\u0007: v\n`)
    res.write(`data: two\n\n`)
    setTimeout(() => res.end(), 300)
}

const checkText = (text: string, what: string) => {
    expect(text, `${what}: a raw control character reached the output`).not.toMatch(RAW_CONTROL)
    expect(text, `${what}: an escape sequence reached the output`).not.toContain(ESC)
}
const parseXml = (text: string) => new JSDOM(text, { contentType: 'application/xml' }).window.document

describe('hostile text from a stream, through every command and format', () => {
    const FORMATS = ['human', 'md', 'junit', 'json'] as const

    for (const format of FORMATS) {
        it(`analyze of a hostile capture, --format ${format}`, async () => {
            const h = host({ 'x.sse-capture': hostileCapture() })
            await main(['analyze', 'x.sse-capture', '--format', format], h.io)
            expect(h.out.length).toBeGreaterThan(100)
            if (format === 'json') { const parsed = JSON.parse(h.out); expect(parsed).toBeTypeOf('object') } // JSON escapes control characters itself
            else checkText(h.out, `analyze ${format}`)
            if (format === 'junit') {
                const doc = parseXml(h.out) // throws on malformed XML
                expect(doc.getElementsByTagName('testsuite').length).toBeGreaterThan(0)
            }
        })

        it(`probe of a server that sends hostile bodies, --format ${format}`, async () => {
            const url = await serve(hostileBody)
            const h = host()
            await main(['probe', url, '--duration', '2', '--max-events', '5', '--format', format], h.io)
            if (format === 'json') JSON.parse(h.out)
            else checkText(h.out, `probe ${format}`)
            if (format === 'junit') parseXml(h.out)
            checkText(h.err, `probe ${format} (stderr)`)
        }, 30_000)
    }

    for (const format of ['md', 'html', 'issue', 'json'] as const) {
        it(`report of a hostile capture, --format ${format}`, async () => {
            const h = host({ 'x.sse-capture': hostileCapture() })
            const code = await main(['report', 'x.sse-capture', '--format', format, '--redact'], h.io)
            expect([0, 1]).toContain(code)
            expect(h.out.length).toBeGreaterThan(100)
            if (format === 'json') JSON.parse(h.out)
            else checkText(h.out, `report ${format}`)
            if (format === 'html') {
                // the hostile markup must be text, not elements: no <img>, no inline handlers, and the page parses with no script it did not bring
                const doc = new JSDOM(h.out).window.document
                expect(doc.querySelectorAll('img').length).toBe(0)
                expect(h.out).not.toMatch(/<img src=x onerror/i)
                expect(Array.from(doc.querySelectorAll('*')).some((el) => Array.from(el.attributes).some((a) => /^on/i.test(a.name)))).toBe(false)
            }
            // markdown escapes the angle bracket (\<img), so it shows as text; an unescaped one would be rendered as an element in an issue
            if (format === 'md' || format === 'issue') expect(h.out).not.toMatch(/(^|[^\\])<img src=x/i)
        })
    }

    it('test (scenario) against a hostile stream, --format junit, parses as XML and shows no raw control', async () => {
        const url = await serve(hostileBody)
        const scenario = JSON.stringify({ version: 1, name: `hostile ${HOSTILE}`, target: { url: '${ENV:STREAM_URL}' }, steps: [{ collect_events: 2, timeout_ms: 10_000 }], verify: [{ no_findings_at_or_above: 'warning' }], fail_on_severity: 'warning' })
        const h = host({ 's.json': scenario }, { STREAM_URL: url })
        await main(['test', 's.json', '--format', 'junit'], h.io)
        checkText(h.out, 'test junit')
        parseXml(h.out)
        const doc = parseXml(h.out)
        expect(doc.getElementsByTagName('testcase').length).toBeGreaterThan(0)
    }, 30_000)

    it('the hostile input reached the findings at all (so the checks above are not vacuous)', async () => {
        const h = host({ 'x.sse-capture': hostileCapture() })
        await main(['analyze', 'x.sse-capture', '--format', 'human', '--verbose'], h.io)
        // the escape shows as text (\u001B), which is the proof the sequence came through and was neutralised, not absent
        expect(h.out).toMatch(/\\u001B|\\u0001|\\u0000/)
    })
})
