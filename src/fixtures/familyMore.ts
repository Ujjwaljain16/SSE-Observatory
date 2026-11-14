/**
 * The fixtures that close the gaps the campaign found (plan A3): a server that ignores Last-Event-ID, a stream that is allowed to be idle,
 * a stream of comments only, a slow start, a compressed stream, malformed framing, a late heartbeat and a constant rate.
 *
 * F05  `/f05/ignores`       one drop after half of the events; the second connection ignores Last-Event-ID, starts again from 1 and runs
 *                           to the end (n=6 sends ids 1,2,3 and then 1,2,3,4,5,6). Twin: f05-resumes.
 * H05  `/h05`               events 40 s apart with no heartbeat at all, and a profile that says up to 60 s of silence is normal. A declared
 *                           idle is not a stall, so it must be silent. (`f04-silent` is the same shape without the declaration.)
 * H06  `/h06`               only comment lines, one a second from the first byte, then the end event (`?bare=1` closes without it, which
 *                           makes the client reconnect). No event is ever dispatched until the end: nothing is wrong with it.
 * F04  `/f04/late-heartbeat` an event, heartbeats a second apart, then one that comes four seconds after the one before (R10). Twin: h06.
 * F11  `/f11/slow-start`    headers at once, the first byte 4 s later (a comment), the first event 7 s after that (R04). `?byteMs=` and
 *                           `?eventMs=` change the two delays. A fixture cannot hold the headers back (the server writes them before the
 *                           script runs), so the slow stages are the first byte and the first event. Twin: h01.
 * F12  `/f12/gzip-sync`     h01, gzip-compressed with a sync flush after every event, and `Content-Encoding: gzip` (R03). The client's fetch
 *                           decodes it, so the events still arrive one by one. Twin: h01.
 * F15  `/f15/malformed`     a byte order mark, an unknown field, `Data:` in the wrong case, a NUL in an id, `retry: x`, CRLF in the middle of
 *                           a stream that was LF, and then good events (R02: an info and warning mix). Twin: h03.
 * F16  `/f16/rate`          a constant rate: `?rate=500&bytes=100` is ten events every 20 ms tick, each with a data field of 100 bytes, ids 1..N.
 *                           For the performance harness; nothing is wrong with it.
 */
import zlib from 'node:zlib'
import { FINDINGS_NEVER_ON_HEALTHY, frame, numericId, type Ctx, type FixtureFamily, type FixtureRoute, type Script } from './kit'

const END = 'event: end\ndata: done\n\n'
const tick = (i: number) => frame(numericId(i), 'tick', JSON.stringify({ n: i + 1 }))
const number = (ctx: Ctx, name: string, fallback: number): number => {
    const value = Number(ctx.query.get(name) ?? fallback)
    return Number.isFinite(value) && value >= 0 ? value : fallback
}

/** The stream's silence, in stream milliseconds, that the declared idle of h05 stays inside. The default 30 s limit would flag it. */
export const IDLE_GAP_MS = 40_000
export const DECLARED_MAX_SILENCE_MS = 60_000

const routes: FixtureRoute[] = [
    {
        id: 'f05-ignores', family: 'F05', path: '/f05/ignores', title: 'The server ignores Last-Event-ID after a drop',
        description: 'One drop after half of the events; the next connection sends Last-Event-ID, is answered from the first event again and runs to the end.',
        // under the profile below, a restart that sends ids 1..3 again is a replay the stream said it would not have (exactly once); with no profile the cursor is all there is to judge
        expectedFindings: ['resume.last-event-id:ignored', 'seq.integrity:replay'], forbiddenFindings: ['stall.silent', 'reconnect.loop', 'seq.integrity:gap'], healthyTwin: 'f05-resumes', defaultN: 6,
        profile: { sequence: { useSseId: true, policy: 'consecutive' }, delivery: 'exactly_once' },
    },
    {
        id: 'h05-declared-idle', family: 'H05', path: '/h05', title: 'Healthy: idle for 40 s between events, and said to be',
        description: 'An event every 40 s with no heartbeats, on a stream whose profile says silences of up to 60 s are normal.',
        expectedFindings: [], forbiddenFindings: FINDINGS_NEVER_ON_HEALTHY, healthyTwin: null, defaultN: 3,
        profile: { expected: { maxSilenceMs: DECLARED_MAX_SILENCE_MS } },
    },
    {
        id: 'h06-comments-only', family: 'H06', path: '/h06', title: 'Healthy: comments only, then the end',
        description: 'A comment line a second from the first byte, for N seconds, and then the end event. Nothing is dispatched as an event before it.',
        expectedFindings: [], forbiddenFindings: FINDINGS_NEVER_ON_HEALTHY, healthyTwin: null, defaultN: 4,
    },
    {
        id: 'f04-late-heartbeat', family: 'F04', path: '/f04/late-heartbeat', title: 'A heartbeat arrives late',
        description: 'An event, then heartbeat comments a second apart, then one four seconds after the one before it, then the rhythm returns.',
        expectedFindings: ['heartbeat.late:origin'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h06-comments-only', defaultN: 4,
    },
    {
        id: 'f11-slow-start', family: 'F11', path: '/f11/slow-start', title: 'Slow first byte and slow first event',
        description: 'The headers come at once; the first byte 4 s later and the first event 7 s after that (?byteMs= and ?eventMs= change them).',
        expectedFindings: ['timing.first-event:first-byte', 'timing.first-event:first-event'], forbiddenFindings: ['stall.silent', 'proto'], healthyTwin: 'h01', defaultN: 3,
    },
    {
        id: 'f12-gzip-sync', family: 'F12', path: '/f12/gzip-sync', title: 'Compressed event stream',
        description: 'A stream of ticks gzip-compressed with a sync flush after every event, with Content-Encoding: gzip.',
        expectedFindings: ['proto.headers-hints:content-encoding'], forbiddenFindings: ['stall.silent', 'proto.content-type', 'proto.framing'], healthyTwin: 'h01', defaultN: 5,
    },
    {
        id: 'f15-malformed', family: 'F15', path: '/f15/malformed', title: 'Malformed framing, then good events',
        description: 'A byte order mark, an unknown field, "Data:" in the wrong case, a NUL in an id, "retry: x" and a change of line endings, and then well-formed events.',
        expectedFindings: ['proto.framing:BOM_STRIPPED', 'proto.framing:UNKNOWN_FIELD', 'proto.framing:WRONG_CASE_FIELD', 'proto.framing:NUL_IN_ID', 'proto.framing:INVALID_RETRY', 'proto.framing:MIXED_LINE_ENDINGS'],
        forbiddenFindings: ['stall.silent', 'proto.content-type'], healthyTwin: 'h03', defaultN: 6,
    },
    {
        id: 'f16-rate', family: 'F16', path: '/f16/rate', title: 'Healthy: a constant rate',
        description: 'Ten events every 20 ms (?rate=500, ?bytes=100 for the size of each data field), ids 1..N. For measuring, not for diagnosing.',
        expectedFindings: [], forbiddenFindings: FINDINGS_NEVER_ON_HEALTHY, healthyTwin: null, defaultN: 1000,
    },
]

/** A server that drops once and then ignores the cursor it is given. */
const ignores: Script = async (ctx) => {
    // The first connection (no cursor) is dropped after half of the events. Every later one carries a cursor, ignores it and starts again.
    const first = ctx.lastEventId === ''
    const count = first ? Math.ceil(ctx.n / 2) : ctx.n
    for (let i = 0; i < count; i++) {
        if (!(await ctx.sleep(450))) return
        ctx.write(tick(i))
    }
    if (!first) ctx.write(END)
}

const declaredIdle: Script = async (ctx) => {
    for (let i = ctx.from; i < ctx.n; i++) {
        // the first event goes out at once; every later one comes IDLE_GAP_MS after the one before
        if (i > ctx.from && !(await ctx.sleep(IDLE_GAP_MS))) return
        ctx.write(tick(i))
    }
    ctx.write(END)
}

const commentsOnly: Script = async (ctx) => {
    for (let i = 0; i < ctx.n; i++) {
        ctx.write(': keep-alive\n\n')
        if (!(await ctx.sleep(1000))) return
    }
    // ?bare=1 closes without the end event, so the client treats it as a drop and comes back
    if (ctx.query.get('bare') !== '1') ctx.write(END)
}

const lateHeartbeat: Script = async (ctx) => {
    // one event to start (a stream of comments alone would also be slow to its first event), then n heartbeats a second apart (n=4 is three
    // intervals: enough for a rhythm), one four seconds after the last of them, and the rhythm again
    ctx.write(tick(0))
    for (let i = 0; i < ctx.n; i++) {
        ctx.write(': keep-alive\n\n')
        if (!(await ctx.sleep(i < ctx.n - 1 ? 1000 : 4000))) return
    }
    ctx.write(': keep-alive\n\n')
    if (!(await ctx.sleep(1000))) return
    ctx.write(': keep-alive\n\n')
    if (!(await ctx.sleep(1000))) return
    ctx.write(END)
}

const slowStart: Script = async (ctx) => {
    if (!(await ctx.sleep(number(ctx, 'byteMs', 4000)))) return
    ctx.write(': warming up\n\n')
    if (!(await ctx.sleep(number(ctx, 'eventMs', 7000)))) return
    for (let i = ctx.from; i < ctx.n; i++) {
        if (i > ctx.from && !(await ctx.sleep(1000))) return
        ctx.write(tick(i))
    }
    if (!(await ctx.sleep(1000))) return
    ctx.write(END)
}

/** h01's stream through a real gzip stream, flushed after every event so the client can decode each one as it arrives. */
const gzipSync: Script = async (ctx) => {
    const gz = zlib.createGzip()
    gz.on('data', (bytes: Buffer) => ctx.write(bytes))
    gz.on('error', () => undefined) // the client left: nothing to tell it
    const push = (text: string) => new Promise<void>((resolve) => { gz.write(text); gz.flush(zlib.constants.Z_SYNC_FLUSH, () => resolve()) })
    try {
        for (let i = ctx.from; i < ctx.n; i++) {
            if (!(await ctx.sleep(1000))) return
            await push(tick(i))
        }
        await push(END)
        await new Promise<void>((resolve) => { gz.once('end', () => resolve()); gz.end() })
    } finally { gz.destroy() }
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const malformed: Script = async (ctx) => {
    const payload = (i: number) => JSON.stringify({ n: i + 1 })
    const NUL = String.fromCharCode(0)
    const prelude: Array<string | Uint8Array> = [
        // a byte order mark at the very start: the specification strips it
        Buffer.concat([BOM, Buffer.from(': malformed fixture\n\n')]),
        // a field that is not part of the protocol
        `foo: bar\nid: 1\nevent: tick\ndata: ${payload(0)}\n\n`,
        // the wrong case: the line is ignored, so the event is delivered without it
        `Data: lost\nid: 2\nevent: tick\ndata: ${payload(1)}\n\n`,
        // a NUL in an id: the id is ignored, so the cursor stays where it was
        `id: a${NUL}b\nevent: tick\ndata: ${payload(2)}\n\n`,
        // a retry that is not a number of milliseconds
        `retry: x\nid: 4\nevent: tick\ndata: ${payload(3)}\n\n`,
        // CRLF in a stream that was LF so far
        `id: 5\r\nevent: tick\r\ndata: ${payload(4)}\r\n\r\n`,
    ]
    for (const piece of prelude) {
        if (!(await ctx.sleep(200))) return
        ctx.write(piece)
    }
    for (let i = 5; i < ctx.n; i++) {
        if (!(await ctx.sleep(200))) return
        ctx.write(tick(i))
    }
    ctx.write(END)
}

const rate: Script = async (ctx) => {
    const perSecond = Math.max(1, number(ctx, 'rate', 500))
    const bytes = number(ctx, 'bytes', 100)
    const tickMs = 20
    const perTick = Math.max(1, Math.round(perSecond * tickMs / 1000))
    const t0 = Date.now()
    let i = ctx.from
    for (let at = tickMs; i < ctx.n; at += tickMs) {
        // wait for the tick's own moment, so timer granularity does not slow the rate down; never more than one tick, so a stepped clock moves it
        const behind = at - (Date.now() - t0) / ctx.scale
        if (!(await ctx.sleep(Math.min(tickMs, Math.max(0, behind))))) return
        let batch = ''
        for (let k = 0; k < perTick && i < ctx.n; k++, i++) {
            const base = JSON.stringify({ n: i + 1, p: '' })
            batch += frame(numericId(i), 'tick', JSON.stringify({ n: i + 1, p: 'x'.repeat(Math.max(0, bytes - base.length)) }))
        }
        ctx.write(batch)
    }
    ctx.write(END)
}

export const moreFamily: FixtureFamily = {
    routes,
    scripts: {
        '/f05/ignores': ignores,
        '/h05': declaredIdle,
        '/h06': commentsOnly,
        '/f04/late-heartbeat': lateHeartbeat,
        '/f11/slow-start': slowStart,
        '/f12/gzip-sync': gzipSync,
        '/f15/malformed': malformed,
        '/f16/rate': rate,
    },
    headers: { '/f12/gzip-sync': { 'Content-Encoding': 'gzip' } },
}
