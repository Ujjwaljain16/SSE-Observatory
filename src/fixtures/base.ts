/** The first fixture families: wrong content types and statuses (F01), unterminated frames (F02), silence (F04), a token in the URL (F08) and the healthy streams. */
import { FINDINGS_NEVER_ON_HEALTHY, frame, lead, numericId, steady, uuidId, type FixtureFamily, type FixtureRoute, type Script } from './kit'

const routes: FixtureRoute[] = [
    { id: 'f01-text-plain', family: 'F01', path: '/f01/text-plain', title: 'Wrong content type: text/plain', description: 'A 200 response labelled text/plain.', expectedFindings: ['proto.content-type'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01' },
    { id: 'f01-text-html', family: 'F01', path: '/f01/text-html', title: 'Wrong content type: text/html', description: 'A 200 response labelled text/html, like an error or login page.', expectedFindings: ['proto.content-type'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01' },
    { id: 'f01-json', family: 'F01', path: '/f01/application-json', title: 'Wrong content type: application/json', description: 'A 200 JSON response.', expectedFindings: ['proto.content-type'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01' },
    { id: 'f01-401', family: 'F01', path: '/f01/401', title: 'HTTP 401', description: 'Credentials rejected.', expectedFindings: ['http.status'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01' },
    { id: 'f01-404', family: 'F01', path: '/f01/404', title: 'HTTP 404', description: 'No such stream.', expectedFindings: ['http.status'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01' },
    { id: 'f01-502', family: 'F01', path: '/f01/502', title: 'HTTP 502', description: 'A gateway error (retryable).', expectedFindings: ['http.status'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01' },
    { id: 'f02-closed', family: 'F02', path: '/f02/closed', title: 'Event never terminated, connection closed', description: '"data: x" with no blank line, then the connection closes.', expectedFindings: ['proto.framing:UNTERMINATED_FRAME'], forbiddenFindings: ['proto.content-type'], healthyTwin: 'h01' },
    { id: 'f02-open', family: 'F02', path: '/f02/open', title: 'Event never terminated, connection open', description: '"data: x" with no blank line and the connection stays open. R05(iii) would name this; it is not evaluated yet, so the silence is reported.', expectedFindings: ['stall.silent:bytes'], forbiddenFindings: ['proto.content-type'], healthyTwin: 'h01' },
    { id: 'f04-silent', family: 'F04', path: '/f04/silent', title: 'Events, then silence', description: 'N events one second apart, then nothing at all.', expectedFindings: ['stall.silent:bytes'], forbiddenFindings: ['stall.silent:origin', 'stall.silent:events'], healthyTwin: 'h02' },
    { id: 'f04-heartbeats', family: 'F04', path: '/f04/heartbeats', title: 'Events, then heartbeats only', description: 'N events, then only origin comments.', expectedFindings: ['stall.silent:events'], forbiddenFindings: ['stall.silent:bytes', 'stall.silent:origin'], healthyTwin: 'h02' },
    { id: 'f04-masked', family: 'F04', path: '/f04/masked', title: 'Events, then only proxy heartbeats', description: 'N events, then only proxy-tagged comments: the proxy hides an upstream stall.', expectedFindings: ['stall.silent:origin'], forbiddenFindings: ['stall.silent:bytes'], healthyTwin: 'h02' },
    { id: 'f08-token', family: 'F08', path: '/f08', title: 'Token in the URL', description: 'Requires ?token=; the value is a canary that must never appear in any output.', expectedFindings: ['security.credentials-in-metadata:url'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01' },
    { id: 'h01', family: 'H01', path: '/h01', title: 'Healthy: steady 1 s events', description: 'One event per second.', expectedFindings: [], forbiddenFindings: FINDINGS_NEVER_ON_HEALTHY, healthyTwin: null },
    { id: 'h02', family: 'H02', path: '/h02', title: 'Healthy: sparse events with 15 s heartbeats', description: 'An event every 20 s, a heartbeat comment every 15 s.', expectedFindings: [], forbiddenFindings: FINDINGS_NEVER_ON_HEALTHY, healthyTwin: null },
    { id: 'h03', family: 'H03', path: '/h03', title: 'Healthy: CRLF, split multi-byte UTF-8, comments', description: 'CRLF line endings, characters split across writes, comments.', expectedFindings: [], forbiddenFindings: FINDINGS_NEVER_ON_HEALTHY, healthyTwin: null },
    { id: 'h04', family: 'H04', path: '/h04', title: 'Healthy: uuid ids', description: 'Steady events with uuid ids and resume support.', expectedFindings: [], forbiddenFindings: FINDINGS_NEVER_ON_HEALTHY, healthyTwin: null },
]

const scripts: Record<string, Script> = {
    '/h01': steady(numericId, 1000),
    '/h04': steady(uuidId, 1000),

    '/h02': async (ctx) => {
        // events at 0, 20, 40 ... s and heartbeats at 15, 30, 45 ... s
        const events = Math.min(ctx.n, 6)
        const timeline: Array<{ at: number; text: string }> = []
        for (let i = ctx.from; i < events; i++) timeline.push({ at: (i - ctx.from) * 20_000, text: frame(numericId(i), 'tick', JSON.stringify({ n: i + 1 })) })
        const horizon = Math.max(0, (events - 1 - ctx.from) * 20_000)
        for (let t = 15_000; t < horizon; t += 15_000) timeline.push({ at: t, text: ': keep-alive\n\n' })
        timeline.sort((a, b) => a.at - b.at)
        let now = 0
        for (const item of timeline) {
            if (!(await ctx.sleep(item.at - now))) return
            now = item.at
            ctx.write(item.text)
        }
        ctx.write('event: end\ndata: done\n\n')
    },

    '/h03': async (ctx) => {
        // CRLF throughout, a comment, and characters whose UTF-8 bytes are split across two writes.
        ctx.write(': connected\r\n\r\n')
        const texts = ['café €5', '日本語 ✓', 'emoji 😀 ok']
        for (let i = ctx.from; i < Math.min(ctx.n, texts.length); i++) {
            if (!(await ctx.sleep(1000))) return
            const bytes = Buffer.from(frame(numericId(i), 'tick', JSON.stringify({ text: texts[i] }), '\r\n'))
            const cut = bytes.indexOf(0xc3) >= 0 ? bytes.indexOf(0xc3) + 1 : bytes.indexOf(0xe2) >= 0 ? bytes.indexOf(0xe2) + 1 : bytes.indexOf(0xf0) >= 0 ? bytes.indexOf(0xf0) + 2 : bytes.length >> 1
            ctx.write(bytes.subarray(0, cut))
            if (!(await ctx.sleep(30))) return
            ctx.write(bytes.subarray(cut))
            ctx.write(': tick\r\n\r\n')
        }
        ctx.write('event: end\r\ndata: done\r\n\r\n')
    },

    '/f02/closed': async (ctx) => {
        ctx.write('data: x')
        await ctx.sleep(50)
        ctx.res.end()
    },
    '/f02/open': async (ctx) => {
        ctx.write('data: x')
        while (await ctx.sleep(1000)) { /* hold the connection open */ }
    },

    '/f04/silent': async (ctx) => {
        if (!(await lead(ctx, ctx.n, 1000))) return
        while (await ctx.sleep(1000)) { /* nothing more, ever */ }
    },
    '/f04/heartbeats': async (ctx) => {
        if (!(await lead(ctx, ctx.n, 1000))) return
        while (await ctx.sleep(1000)) ctx.write(': keep-alive\n\n')
    },
    '/f04/masked': async (ctx) => {
        if (!(await lead(ctx, ctx.n, 1000))) return
        let k = 0
        let idle = 0
        while (await ctx.sleep(1000)) { idle += 1000; ctx.write(`: sse-proxy hb up_idle=${Math.round(idle * ctx.scale)} n=${++k}\n\n`) }
    },
}

export const baseFamily: FixtureFamily = { routes, scripts }
