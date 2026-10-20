// Replay of .sse-capture v2 files by the mock server: reading a capture into a compact session, and planning what to
// write when. Plain JavaScript (the server and the Vercel functions do not run TypeScript).
//
// Two fidelities, chosen by what the capture holds:
//  - chunk-faithful: the capture kept the wire bytes (Base64) or the redacted text of each network read. Each read is
//    written again at its recorded time, so lumps, split frames and comments reproduce as they happened.
//  - event-level: the capture has only events (an imported v1 recording), or the replay must change what is sent (resume
//    after Last-Event-ID, skip ids). Frames are rebuilt from the events or cut out of the recorded text.
// Sanitized captures replay their redacted text; they are timing-faithful, not byte-identical.

const MAX_CAPTURE_BYTES = 20 * 1024 * 1024
const MAX_RECORDS = 500_000
const KEEP_KINDS = new Set(['chunk', 'event'])

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Is this request body a capture (an NDJSON string, or a JSON envelope holding one)? */
export function looksLikeCapture(body) {
    if (typeof body === 'string' || Buffer.isBuffer(body)) return true
    return isObject(body) && (isObject(body.capture) || typeof body.capture === 'string' || (isObject(body.header) && body.header.format === 'sse-capture'))
}

function fromObject(value) {
    const header = value.header
    if (!isObject(header) || header.format !== 'sse-capture') return { error: 'Not an sse-capture: the header is missing' }
    const major = Number(String(header.version ?? '').split('.')[0])
    if (major !== 2) return { error: `Unsupported capture version "${header.version}" (this server reads 2.x)` }
    const records = Array.isArray(value.records) ? value.records : []
    if (records.length > MAX_RECORDS) return { error: `Too many records (max ${MAX_RECORDS})` }
    return { header, records, footer: isObject(value.footer) ? value.footer : undefined }
}

/** Reads NDJSON text. A cut-off last line is ignored, like the real reader does. */
function fromNdjson(text) {
    const lines = text.split('\n').filter((l) => l.trim() !== '')
    if (lines.length === 0) return { error: 'The capture is empty' }
    let header
    try { header = JSON.parse(lines[0]) } catch { return { error: 'The first line is not JSON; this is not an sse-capture' } }
    const records = []
    let footer
    for (let i = 1; i < lines.length; i++) {
        if (records.length > MAX_RECORDS) return { error: `Too many records (max ${MAX_RECORDS})` }
        let value
        try { value = JSON.parse(lines[i]) } catch {
            if (i === lines.length - 1) continue
            return { error: `Line ${i + 1} is not valid JSON` }
        }
        if (!isObject(value)) return { error: `Line ${i + 1} is not an object` }
        if (isObject(value.footer)) footer = value.footer
        else records.push(value)
    }
    return fromObject({ header, records, footer })
}

/** Turns a request body into a compact capture session, or an error. Only chunk and event records are kept. */
export function sessionFromCapture(body) {
    let parsed
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
        const text = Buffer.isBuffer(body) ? body.toString('utf8') : body
        if (Buffer.byteLength(text) > MAX_CAPTURE_BYTES) return { error: 'Capture is too large' }
        parsed = fromNdjson(text)
    } else if (typeof body.capture === 'string') {
        if (Buffer.byteLength(body.capture) > MAX_CAPTURE_BYTES) return { error: 'Capture is too large' }
        parsed = fromNdjson(body.capture)
    } else {
        parsed = fromObject(isObject(body.capture) ? body.capture : body)
    }
    if (parsed.error) return { error: parsed.error }

    const chunks = []
    const events = []
    let bytes = 0
    for (const r of parsed.records) {
        if (!isObject(r) || !KEEP_KINDS.has(r.kind) || typeof r.t !== 'number' || typeof r.conn !== 'number') continue
        if (r.kind === 'chunk') {
            const b64 = typeof r.b64 === 'string' ? r.b64 : undefined
            const text = typeof r.text === 'string' ? r.text : undefined
            if (b64 === undefined && text === undefined) continue
            bytes += (b64 ?? text).length
            chunks.push({ conn: r.conn, t: r.t, ...(b64 !== undefined ? { b64 } : { text }) })
        } else if (typeof r.data === 'string') {
            bytes += r.data.length
            events.push({ conn: r.conn, t: r.t, id: typeof r.sseId === 'string' ? r.sseId.replace(/[\r\n\0]/g, '') : '', name: typeof r.event === 'string' ? r.event.replace(/[\r\n]/g, '') : 'message', data: r.data })
        }
        if (bytes > MAX_CAPTURE_BYTES) return { error: 'Recording is too large' }
    }
    if (chunks.length === 0 && events.length === 0) {
        return { error: 'This capture holds no payload to replay (it has neither the stream bytes nor event data). Capture with full fidelity, or import a v1 recording.' }
    }
    return { session: { kind: 'capture', captureKind: parsed.header.kind === 'sanitized' ? 'sanitized' : 'local-full', endReason: parsed.footer?.endReason ?? 'unknown', chunks, events } }
}

// ---------------------------------------------------------------- planning

function decodeConnection(chunks) {
    const decoder = new TextDecoder('utf-8')
    return chunks.map((c) => (c.text !== undefined ? c.text : decoder.decode(Buffer.from(c.b64, 'base64'), { stream: true })))
}

/** Splits stream text into frames: each block ends at its blank line, a trailing unterminated piece is kept as the last one. */
function blocksOf(text) {
    const out = []
    const re = /\r\n\r\n|\n\n|\r\r/g
    let last = 0
    let m
    while ((m = re.exec(text)) !== null) {
        out.push({ text: text.slice(last, m.index + m[0].length), end: m.index + m[0].length })
        last = m.index + m[0].length
    }
    if (last < text.length) out.push({ text: text.slice(last), end: text.length })
    return out
}

const idOf = (block) => {
    const m = /^id:[ ]?(.*?)\r?$/m.exec(block)
    return m ? m[1] : undefined
}

/** What a replayed connection is made of, as { atMs, id?, text } with times relative to its first byte. */
function framesForLog(session, connections) {
    const frames = []
    const seen = new Set()
    const withChunks = connections.filter((c) => session.chunks.some((k) => k.conn === c))
    for (const conn of withChunks) {
        const chunks = session.chunks.filter((k) => k.conn === conn)
        const pieces = decodeConnection(chunks)
        const full = pieces.join('')
        const ends = []
        let acc = 0
        pieces.forEach((p, i) => { acc += p.length; ends.push({ end: acc, t: chunks[i].t }) })
        const t0 = chunks[0].t
        let ci = 0
        for (const block of blocksOf(full)) {
            while (ci < ends.length - 1 && ends[ci].end < block.end) ci++
            const id = idOf(block.text)
            // after a reconnect the server may have resent frames already in the log; keep each id once
            if (id !== undefined && id !== '' && seen.has(id)) continue
            if (id) seen.add(id)
            frames.push({ atMs: Math.max(0, ends[ci].t - t0), id, text: block.text })
        }
    }
    if (frames.length === 0) {
        const events = session.events.filter((e) => connections.includes(e.conn))
        const t0 = events[0]?.t ?? 0
        for (const e of events) {
            if (e.id && seen.has(e.id)) continue
            if (e.id) seen.add(e.id)
            let text = e.id ? `id: ${e.id}\n` : ''
            if (e.name && e.name !== 'message') text += `event: ${e.name}\n`
            for (const line of e.data.split(/\r\n|\r|\n/)) text += `data: ${line}\n`
            frames.push({ atMs: Math.max(0, e.t - t0), id: e.id || undefined, text: text + '\n' })
        }
    }
    return frames
}

/**
 * Plans one connection of a replay.
 *   connection         which recorded connection to serve (a later request than recorded gets the last one)
 *   honorLastEventId   resume after `lastEventId` instead of replaying the recorded bytes as they were
 *   unknownId          what to do with an id that is not in the capture: 'from-start' | '400' | 'ignore'
 *   skipIds, dropAfter test aids: leave frames out; end the connection after N frames
 * Returns { steps: [{ atMs, write }], mode, error? }. `atMs` is relative to the start and already divided by `speed`.
 * @param {any} session
 * @param {{ connection?: number, speed?: number, honorLastEventId?: boolean, lastEventId?: string, unknownId?: string, skipIds?: string[], dropAfter?: number }} [opts]
 * @returns {{ steps: Array<{ atMs: number, write: string | Buffer }>, mode: string, error?: { status: number, message: string } }}
 */
export function planReplay(session, opts = {}) {
    const speed = opts.speed > 0 ? opts.speed : 1
    const all = [...new Set([...session.chunks.map((c) => c.conn), ...session.events.map((e) => e.conn)])].sort((a, b) => a - b)
    const wanted = opts.connection ?? 0
    const conn = all.includes(wanted) ? wanted : (all[all.length - 1] ?? 0)
    const skip = new Set(opts.skipIds ?? [])
    const changes = Boolean(opts.honorLastEventId) || skip.size > 0

    if (!changes && session.chunks.some((c) => c.conn === conn)) {
        const chunks = session.chunks.filter((c) => c.conn === conn)
        let steps = chunks.map((c) => ({ atMs: Math.max(0, c.t - chunks[0].t) / speed, write: c.b64 !== undefined ? Buffer.from(c.b64, 'base64') : c.text }))
        if (opts.dropAfter !== undefined) steps = steps.slice(0, Math.max(0, opts.dropAfter))
        return { steps, mode: 'chunk-faithful' }
    }

    // The recorded log of every connection, so a resumed connection continues where the earlier ones stopped.
    let frames = framesForLog(session, opts.honorLastEventId ? all : [conn])
    if (opts.honorLastEventId && opts.lastEventId) {
        const at = frames.findIndex((f) => f.id === opts.lastEventId)
        if (at >= 0) frames = frames.slice(at + 1)
        else if (opts.unknownId === '400') return { steps: [], mode: 'event-level', error: { status: 400, message: `Unknown Last-Event-ID "${opts.lastEventId}"` } }
        else if (opts.unknownId === 'ignore') frames = []
        // 'from-start' (default): the whole log
    }
    if (skip.size > 0) frames = frames.filter((f) => f.id === undefined || !skip.has(f.id))
    if (opts.dropAfter !== undefined) frames = frames.slice(0, Math.max(0, opts.dropAfter))
    const base = frames[0]?.atMs ?? 0
    return { steps: frames.map((f) => ({ atMs: Math.max(0, f.atMs - base) / speed, write: f.text })), mode: 'event-level' }
}

export const END_BEHAVIOURS = ['close', 'hold', 'rst', 'end-event']
