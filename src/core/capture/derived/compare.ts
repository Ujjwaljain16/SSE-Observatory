/**
 * Comparing two saved captures, for example the same stream read directly and through a proxy. Results use the
 * engine's Finding shape (ruleId `compare`) so they can be shown and reported like any other finding.
 *
 * The same rule applies as for the engine: differences are measurements, "Likely: ..." is a guess, and anything that
 * could not be compared says so. The two captures are called A and B; no layer is ever named, because a difference
 * between two paths cannot say which hop caused it.
 */

import { SEVERITY_RANK, type Confidence, type Deduction, type Evidence, type Fact, type Finding, type NextCheck, type Severity } from '../../diagnostics/finding'
import { fmtMs, plural } from '../../diagnostics/rules/util'
import type { Capture } from '../format'
import { alignEvents, eventViews, movedCount, type EventView } from './align'
import { durationOf, median, ofKind, type Of } from './records'

export type ComparisonFinding = Finding & { ruleId: 'compare' }

// Thresholds are deliberately plain numbers here: this is a comparison aid, not a rule with a stream profile.
const BLOCK_SIZES = [4096, 8192, 16384, 65536]
const BLOCK_TOLERANCE = 0.02
const MIN_BLOCK_CHUNKS = 4
const MIN_BLOCK_SHARE = 0.5
const LUMP_MIN_EVENTS = 8
const LUMP_EVENTS_PER_CHUNK = 4

const nearBlock = (bytes: number): boolean => BLOCK_SIZES.some((size) => Math.abs(bytes - size) <= size * BLOCK_TOLERANCE)

interface Side {
    label: 'A' | 'B'
    capture: Capture
    /** Time of the first connect: every timing below is measured from it, on the capture's own clock. */
    originT: number
    duration: number
    response: Of<'response'> | undefined
    chunks: Of<'chunk'>[]
    events: Of<'event'>[]
    comments: Of<'comment'>[]
    series: Of<'heartbeatSeries'>[]
    firstData: { seq: number; t: number } | undefined
    client: string | undefined
}

function sideOf(label: 'A' | 'B', capture: Capture): Side {
    const rs = capture.records
    const firstData = rs.find((r) => r.kind === 'chunk' || r.kind === 'comment' || r.kind === 'event' || r.kind === 'heartbeatSeries')
    return {
        label, capture,
        originT: ofKind(rs, 'connect')[0]?.t ?? 0,
        duration: durationOf(rs),
        response: ofKind(rs, 'response')[0],
        chunks: ofKind(rs, 'chunk'),
        events: ofKind(rs, 'event'),
        comments: ofKind(rs, 'comment'),
        series: ofKind(rs, 'heartbeatSeries'),
        firstData: firstData ? { seq: firstData.seq, t: firstData.t } : undefined,
        client: capture.header.source.client,
    }
}

const ev = (s: Side, r: { seq: number; t: number }, note: string): Evidence => ({ seq: r.seq, t: r.t, note: `${s.label}: ${note}` })
const hasWire = (s: Side): boolean => s.chunks.length + s.comments.length + s.series.length > 0

interface Draft {
    key: string
    severity: Severity
    title: string
    summary: string
    facts: Fact[]
    deductions?: Deduction[]
    nextCheck?: NextCheck | undefined
    limits: string[]
}

function make(d: Draft): ComparisonFinding {
    const times = d.facts.flatMap((f) => f.evidence.map((e) => e.t))
    return {
        key: d.key, ruleId: 'compare', ruleVersion: 1, severity: d.severity, title: d.title, summary: d.summary,
        facts: d.facts, deductions: d.deductions ?? [], nextCheck: d.nextCheck, limits: d.limits, status: 'open',
        firstSeenT: times.length ? Math.min(...times) : 0, lastSeenT: times.length ? Math.max(...times) : 0, occurrences: 1,
    }
}

/** A check that could not run: stated as such, at info severity, so it is never read as "no difference". */
function notCompared(key: string, what: string, reasons: string[]): ComparisonFinding {
    return make({
        key, severity: 'info', title: `${what} not compared`,
        summary: `${what} was not evaluated: ${reasons.join('; ')}. This is not the same as no difference.`,
        facts: reasons.map((text) => ({ text, evidence: [] })), limits: [`${what} is not evaluated for this pair of captures.`],
    })
}

const CLIENT_LIMIT = 'Clients chunk and time bytes differently, so a difference can also come from how each capture was recorded.'
const clientLimits = (a: Side, b: Side): string[] => {
    if (a.client !== b.client) return [`The captures were recorded by different clients (A: ${a.client ?? 'unknown'}, B: ${b.client ?? 'unknown'}). ${CLIENT_LIMIT}`]
    return [CLIENT_LIMIT]
}

// ---------------------------------------------------------------- status and content type

function compareStatus(a: Side, b: Side): ComparisonFinding[] {
    if (!a.response || !b.response) {
        const missing = [a, b].filter((s) => !s.response).map((s) => `${s.label} has no response record`)
        return [notCompared('compare.status', 'Response status and content type', missing)]
    }
    const ra = a.response
    const rb = b.response
    const ctA = ra.contentType.trim().toLowerCase()
    const ctB = rb.contentType.trim().toLowerCase()
    const facts: Fact[] = []
    let severity: Severity = 'warning'
    const ok = (s: number): boolean => s >= 200 && s < 300
    if (ra.status !== rb.status) {
        facts.push({ text: `A answered HTTP ${ra.status}; B answered HTTP ${rb.status}.`, evidence: [ev(a, ra, 'response'), ev(b, rb, 'response')] })
        if (!ok(ra.status) || !ok(rb.status)) severity = 'error'
    }
    if (ctA !== ctB) {
        facts.push({ text: `A's Content-Type is "${ra.contentType || 'none'}"; B's is "${rb.contentType || 'none'}".`, evidence: [ev(a, ra, 'response'), ev(b, rb, 'response')] })
        if (/text\/event-stream/.test(ctA) !== /text\/event-stream/.test(ctB)) severity = 'error'
    }
    if (ra.redirected !== rb.redirected) {
        facts.push({ text: `${ra.redirected ? 'A' : 'B'} was redirected; ${ra.redirected ? 'B' : 'A'} was not.`, evidence: [ev(a, ra, 'response'), ev(b, rb, 'response')] })
    }
    if (facts.length === 0) return []
    return [make({
        key: 'compare.status', severity, title: 'Response status or content type differs',
        summary: 'The two captures were not answered in the same way.',
        facts,
        deductions: [{ statement: 'Likely: the two requests did not reach the same component or code path.', confidence: 'low', basis: [ra.seq, rb.seq], alternatives: ['The server answers differently depending on the request headers or credentials.', 'The stream failed in one run and not in the other.'] }],
        nextCheck: { description: 'Send both requests with curl -N and compare the full response heads.' },
        limits: ['Only the first response of each capture is compared.'],
    })]
}

// ---------------------------------------------------------------- headers

const HEADER_ALWAYS = ['content-encoding', 'cache-control', 'x-accel-buffering', 'via', 'transfer-encoding', 'x-cache', 'cf-cache-status']
/** Headers whose value changes on every request: only whether they are present is compared. */
const HEADER_PRESENCE = ['content-length', 'age', 'x-sse-upstream-ttfb-ms']
const HEADER_BUFFERING = new Set(['content-encoding', 'x-accel-buffering', 'transfer-encoding', 'via', 'content-length'])

function compareHeaders(a: Side, b: Side): ComparisonFinding[] {
    if (!a.response || !b.response) return [] // reported under compare.status
    const ha = a.response.headers
    const hb = b.response.headers
    const blind = [a, b].filter((s) => Object.keys(s.response!.headers).length === 0).map((s) => `${s.label}'s response record carries no headers (hidden from the page, or not recorded)`)
    if (blind.length > 0) return [notCompared('compare.headers', 'Response headers', blind)]

    const names = new Set<string>([...HEADER_ALWAYS, ...HEADER_PRESENCE])
    for (const h of [ha, hb]) for (const k of Object.keys(h)) if (k.toLowerCase().startsWith('x-sse-')) names.add(k.toLowerCase())
    const get = (h: Record<string, string>, name: string): string | undefined => {
        const key = Object.keys(h).find((k) => k.toLowerCase() === name)
        return key === undefined ? undefined : h[key]!.trim()
    }
    const facts: Fact[] = []
    let severity: Severity = 'info'
    for (const name of [...names].sort()) {
        const va = get(ha, name)
        const vb = get(hb, name)
        const same = HEADER_PRESENCE.includes(name) ? (va === undefined) === (vb === undefined) : va === vb
        if (same) continue
        const show = (v: string | undefined): string => (v === undefined ? 'absent' : HEADER_PRESENCE.includes(name) ? 'present' : `"${v}"`)
        facts.push({ text: `${name}: A ${show(va)}; B ${show(vb)}.`, evidence: [ev(a, a.response, 'response headers'), ev(b, b.response, 'response headers')] })
        if (HEADER_BUFFERING.has(name)) severity = 'warning'
    }
    if (facts.length === 0) return []
    return [make({
        key: 'compare.headers', severity, title: 'Response headers differ',
        summary: `${plural(facts.length, 'response header')} differ${facts.length === 1 ? 's' : ''} between A and B.`,
        facts,
        deductions: severity === 'warning' ? [{ statement: 'Likely: a layer between A and B adds or rewrites response headers; some of these headers can change how a stream is buffered, but they do not show that it is.', confidence: 'low', basis: [a.response.seq, b.response.seq], alternatives: ['The two servers are configured differently.', 'The two requests carried different request headers.'] }] : [],
        nextCheck: { description: 'Request both endpoints with curl -N -i and compare the response heads line by line.' },
        limits: ['Only the response headers the recorder keeps are compared, and a header the browser hides from the page cannot be seen. Request headers are not compared.'],
    })]
}

// ---------------------------------------------------------------- first byte and first event

const ratio = (x: number, y: number): number => Math.max(x, y) / Math.max(Math.min(x, y), 1)

function grade(x: number, y: number): Severity | undefined {
    const diff = Math.abs(x - y)
    if (diff >= 1000 && ratio(x, y) >= 2) return 'warning'
    if (diff >= 250 && ratio(x, y) >= 1.5) return 'info'
    return undefined
}

function compareFirstByte(a: Side, b: Side): ComparisonFinding[] {
    const reasons: string[] = []
    for (const s of [a, b]) if (!s.firstData) reasons.push(`${s.label} has no chunk, comment or event records`)
    if (reasons.length > 0) return [notCompared('compare.first-byte', 'Time to first byte', reasons)]
    const byteA = a.firstData!.t - a.originT
    const byteB = b.firstData!.t - b.originT
    const firstEvA = a.events[0]
    const firstEvB = b.events[0]
    const eventA = firstEvA ? firstEvA.t - a.originT : undefined
    const eventB = firstEvB ? firstEvB.t - b.originT : undefined

    const facts: Fact[] = []
    let severity: Severity | undefined
    const byteGrade = grade(byteA, byteB)
    if (byteGrade) {
        facts.push({ text: `Time to first byte: A ${fmtMs(byteA)}, B ${fmtMs(byteB)}.`, evidence: [ev(a, a.firstData!, 'first byte'), ev(b, b.firstData!, 'first byte')] })
        severity = byteGrade
    }
    if (firstEvA && firstEvB && eventA !== undefined && eventB !== undefined) {
        const eventGrade = grade(eventA, eventB)
        if (eventGrade) {
            facts.push({ text: `Time to first event: A ${fmtMs(eventA)}, B ${fmtMs(eventB)}.`, evidence: [ev(a, firstEvA, 'first event'), ev(b, firstEvB, 'first event')] })
            severity = !severity || SEVERITY_RANK[eventGrade] > SEVERITY_RANK[severity] ? eventGrade : severity
        }
    }
    if (!severity) return []
    const slower = (eventA !== undefined && eventB !== undefined ? eventA > eventB : byteA > byteB) ? 'A' : 'B'
    return [make({
        key: 'compare.first-byte', severity, title: 'Time to first byte or first event differs',
        summary: `${slower} waited noticeably longer for its first data than the other capture.`,
        facts,
        deductions: [{ statement: `Likely: a layer between A and B holds back the first bytes on the ${slower} path (for example until a buffer fills).`, confidence: 'low', basis: [a.firstData!.seq, b.firstData!.seq], alternatives: ['The server was slower to start on that run.', 'A connection setup cost (DNS, TLS, a cold start) fell in one run only.'] }],
        nextCheck: { description: 'Repeat both captures a few times: a one-off difference is noise, a repeatable one is not.' },
        limits: ['Each time is measured from the capture\'s own first connect, so network distance and a cold start count too.', ...clientLimits(a, b)],
    })]
}

// ---------------------------------------------------------------- heartbeat cadence

interface Beats { gaps: number[]; count: number; proxy: number; upstream: number }

function beatsOf(s: Side): Beats {
    const gaps: number[] = []
    const lastByConn = new Map<number, number>()
    let proxy = 0
    let upstream = 0
    for (const c of s.comments) {
        const prev = lastByConn.get(c.conn)
        if (prev !== undefined) gaps.push(c.t - prev)
        lastByConn.set(c.conn, c.t)
        if (c.source === 'proxy') proxy++; else upstream++
    }
    let count = s.comments.length
    for (const h of s.series) {
        count += h.count
        if (h.source === 'proxy') proxy += h.count; else upstream += h.count
        for (let i = 0; i < Math.min(h.count - 1, 50); i++) gaps.push(h.meanGapMs)
    }
    return { gaps, count, proxy, upstream }
}

const dominantSource = (b: Beats): string => (b.count === 0 ? 'none' : b.proxy >= b.upstream ? 'proxy' : 'upstream')

function compareHeartbeat(a: Side, b: Side): ComparisonFinding[] {
    const reasons = [a, b].filter((s) => !hasWire(s)).map((s) => `${s.label} has no chunk or comment records`)
    if (reasons.length > 0) return [notCompared('compare.heartbeat-cadence', 'Heartbeat cadence', reasons)]
    const ba = beatsOf(a)
    const bb = beatsOf(b)
    const ma = median(ba.gaps)
    const mb = median(bb.gaps)
    const enough = (x: Beats): boolean => x.gaps.length >= 2
    if (!enough(ba) && !enough(bb)) {
        if (ba.count > 0 || bb.count > 0) return [notCompared('compare.heartbeat-cadence', 'Heartbeat cadence', [`too few heartbeats to measure a cadence (A ${ba.count}, B ${bb.count})`])]
        return []
    }
    const evidence = (s: Side): Evidence[] => [...s.comments.slice(0, 1), ...s.series.slice(0, 1)].map((r) => ev(s, r, 'heartbeat'))
    const limits = ['Cadence is the median gap between comment records on one connection; a comment that carries other text is counted as a heartbeat too.', ...clientLimits(a, b)]
    const nextCheck: NextCheck = { description: 'Read both streams for a few minutes with curl -N and note when each comment line arrives.' }

    if (enough(ba) !== enough(bb)) {
        const withBeats = enough(ba) ? a : b
        const other = enough(ba) ? b : a
        const otherBeats = enough(ba) ? bb : ba
        const gap = enough(ba) ? ma! : mb!
        if (otherBeats.count > 0 || other.duration - other.originT < gap * 2) {
            return [notCompared('compare.heartbeat-cadence', 'Heartbeat cadence', [`${withBeats.label} shows heartbeats about ${fmtMs(gap)} apart, but ${other.label} has ${plural(otherBeats.count, 'heartbeat')} and ran ${fmtMs(other.duration - other.originT)}, too little to measure a cadence`])]
        }
        return [make({
            key: 'compare.heartbeat-cadence', severity: 'warning', title: 'Heartbeats appear in only one capture',
            summary: `${withBeats.label} shows heartbeats; ${other.label} shows none over ${fmtMs(other.duration - other.originT)}.`,
            facts: [
                { text: `${withBeats.label} has ${plural(enough(ba) ? ba.count : bb.count, 'heartbeat')} about ${fmtMs(gap)} apart.`, evidence: evidence(withBeats) },
                { text: `${other.label} has no comment records in ${fmtMs(other.duration - other.originT)}.`, evidence: [] },
            ],
            deductions: [{ statement: `Likely: a layer between A and B ${withBeats === a ? 'drops or never forwards' : 'adds'} heartbeat comments.`, confidence: 'low', basis: [], alternatives: ['The two servers are configured with different heartbeat settings.', 'The proxy that sends heartbeats was on one path only.'] }],
            nextCheck, limits,
        })]
    }

    const r = ratio(ma!, mb!)
    const diff = Math.abs(ma! - mb!)
    const sourceDiffers = ba.count > 0 && bb.count > 0 && dominantSource(ba) !== dominantSource(bb)
    const cadence: Severity | undefined = r >= 2 && diff >= 500 ? 'warning' : r >= 1.25 && diff >= 500 ? 'info' : undefined
    if (!cadence && !sourceDiffers) return []
    const facts: Fact[] = []
    if (cadence) facts.push({ text: `Median heartbeat gap: A ${fmtMs(ma!)}, B ${fmtMs(mb!)}.`, evidence: [...evidence(a), ...evidence(b)] })
    if (sourceDiffers) facts.push({ text: `A's heartbeats are marked ${dominantSource(ba)}; B's are marked ${dominantSource(bb)}.`, evidence: [...evidence(a), ...evidence(b)] })
    return [make({
        key: 'compare.heartbeat-cadence', severity: cadence ?? 'info', title: 'Heartbeat cadence differs',
        summary: 'The two captures keep the connection alive in different ways.',
        facts,
        deductions: [{ statement: 'Likely: a layer between A and B changes how heartbeats are produced or forwarded.', confidence: 'low', basis: [], alternatives: ['The two servers use different heartbeat intervals.', 'Heartbeats were folded or delayed by the recorder under memory pressure.'] }],
        nextCheck, limits,
    })]
}

// ---------------------------------------------------------------- chunk sizes

interface ChunkShape {
    count: number
    median: number
    max: number
    aligned: number
    blockSignature: boolean
    lumpSignature: boolean
    eventsPerChunk: number
}

function shapeOf(s: Side): ChunkShape {
    const sizes = s.chunks.map((c) => c.bytes)
    const aligned = sizes.filter(nearBlock).length
    const eventsPerChunk = s.events.length / Math.max(s.chunks.length, 1)
    return {
        count: sizes.length,
        median: median(sizes) ?? 0,
        max: Math.max(0, ...sizes),
        aligned,
        blockSignature: aligned >= MIN_BLOCK_CHUNKS && aligned / sizes.length >= MIN_BLOCK_SHARE,
        lumpSignature: s.events.length >= LUMP_MIN_EVENTS && sizes.length >= 2 && eventsPerChunk >= LUMP_EVENTS_PER_CHUNK,
        eventsPerChunk,
    }
}

function describeShape(label: string, sh: ChunkShape): string {
    const parts = [`${plural(sh.count, 'chunk')}, median ${sh.median} bytes, largest ${sh.max}`]
    if (sh.aligned > 0) parts.push(`${sh.aligned} near 4096/8192/16384/65536 bytes`)
    if (sh.lumpSignature) parts.push(`${sh.eventsPerChunk.toFixed(1)} events per chunk`)
    return `${label}: ${parts.join(', ')}.`
}

function compareChunks(a: Side, b: Side): ComparisonFinding[] {
    const reasons = [a, b].filter((s) => s.chunks.length === 0).map((s) => `${s.label} has no chunk records`)
    if (reasons.length > 0) return [notCompared('compare.chunk-sizes', 'Chunk-size distribution', reasons)]
    const sa = shapeOf(a)
    const sb = shapeOf(b)
    const sigA = sa.blockSignature || sa.lumpSignature
    const sigB = sb.blockSignature || sb.lumpSignature
    const evidence = (s: Side): Evidence[] => s.chunks.filter((c) => nearBlock(c.bytes)).slice(0, 2).concat(s.chunks.slice(0, 1)).map((c) => ev(s, c, `chunk of ${c.bytes} bytes`))
    const facts: Fact[] = [{ text: describeShape('A', sa), evidence: evidence(a) }, { text: describeShape('B', sb), evidence: evidence(b) }]
    const limits = ['Chunk sizes show how the bytes were delivered to the client, not what any layer did with them.', 'The block sizes checked are 4096, 8192, 16384 and 65536 bytes (within 2%); other buffer sizes are not recognised.', ...clientLimits(a, b)]

    if (sigA !== sigB) {
        const flagged = sigA ? 'A' : 'B'
        const shape = sigA ? sa : sb
        const confidence: Confidence = shape.blockSignature && shape.lumpSignature ? 'medium' : 'low'
        return [make({
            key: 'compare.chunk-sizes', severity: 'warning', title: 'Only one capture shows a buffering signature',
            summary: `${flagged} received its data in block-sized or lumped chunks; the other did not.`,
            facts,
            deductions: [{ statement: `Likely: a layer between A and B buffers the stream (the signature is in ${flagged} only).`, confidence, basis: [], alternatives: ['The two clients read the stream with different buffer sizes.', 'The servers sent differently sized writes.', 'The stream was bursty at the source during one run only.'] }],
            nextCheck: { description: 'Repeat both captures with the same client, and with the suspected layer bypassed if you can.' },
            limits,
        })]
    }
    if (sigA && sigB) {
        return [make({
            key: 'compare.chunk-sizes', severity: 'info', title: 'Both captures show a buffering signature',
            summary: 'Both received block-sized or lumped chunks, so this comparison does not separate the two paths.',
            facts, limits,
        })]
    }
    if (ratio(sa.median, sb.median) >= 4 && Math.abs(sa.median - sb.median) >= 256) {
        return [make({ key: 'compare.chunk-sizes', severity: 'info', title: 'Chunk sizes differ', summary: 'The typical chunk is much larger in one capture, without a buffering signature in either.', facts, limits })]
    }
    return []
}

// ---------------------------------------------------------------- events

const brief = (v: EventView): string => `${v.name}${v.id ? ` id ${v.id}` : ''} (seq ${v.seq})`
const listSome = (views: readonly EventView[], n = 3): string => views.slice(0, n).map(brief).join(', ') + (views.length > n ? `, and ${views.length - n} more` : '')

function compareEvents(a: Side, b: Side): ComparisonFinding[] {
    const reasons = [a, b].filter((s) => s.events.length === 0).map((s) => `${s.label} has no event records`)
    if (reasons.length > 0) return [notCompared('compare.events', 'Event set and order', reasons)]
    const va = eventViews(a.capture)
    const vb = eventViews(b.capture)
    const al = alignEvents(va.views, vb.views)
    const eventEv = (s: Side, v: EventView, note: string): Evidence => ev(s, v, note)

    const unmatchable = (v: EventView): boolean => v.id === '' && v.hash === undefined && v.numKey === undefined
    const lostA = al.onlyA.filter((v) => !unmatchable(v))
    const lostB = al.onlyB.filter((v) => !unmatchable(v))
    const cannotA = al.onlyA.length - lostA.length
    const cannotB = al.onlyB.length - lostB.length

    const firstPair = al.pairs[0]
    const lastPair = al.pairs[al.pairs.length - 1]
    // a difference at either end is a difference in where the captures start and stop; one between shared events is a loss
    const inside = (v: EventView, side: 'a' | 'b'): boolean => !!firstPair && !!lastPair && v.index > firstPair[side].index && v.index < lastPair[side].index
    const interiorA = lostA.filter((v) => inside(v, 'a'))
    const interiorB = lostB.filter((v) => inside(v, 'b'))
    const edgeA = lostA.length - interiorA.length
    const edgeB = lostB.length - interiorB.length
    const moved = movedCount(al.pairs)
    const changed = al.pairs.filter((p) => p.by === 'id' && ((p.a.hash !== undefined && p.b.hash !== undefined && p.a.hash !== p.b.hash) || p.a.name !== p.b.name))
    const byCount = (m: string): number => al.pairs.filter((p) => p.by === m).length

    const facts: Fact[] = []
    let severity: Severity | undefined
    const raise = (s: Severity): void => { if (!severity || SEVERITY_RANK[s] > SEVERITY_RANK[severity]) severity = s }
    const deductions: Deduction[] = []

    const nothingShared = al.pairs.length === 0 && lostA.length + lostB.length > 0
    if (nothingShared) {
        facts.push({ text: `None of A's ${plural(va.views.length, 'event')} and B's ${plural(vb.views.length, 'event')} could be matched.`, evidence: [eventEv(a, va.views[0]!, 'first event'), eventEv(b, vb.views[0]!, 'first event')] })
        raise('warning')
    } else if (va.views.length !== vb.views.length || lostA.length + lostB.length > 0 || cannotA + cannotB > 0) {
        facts.push({ text: `A has ${plural(va.views.length, 'event')} and B has ${plural(vb.views.length, 'event')}; ${al.pairs.length} matched (by id ${byCount('id')}, by payload ${byCount('payload')}, by sequence number ${byCount('seq')}).`, evidence: [] })
    }
    if (interiorA.length > 0) { facts.push({ text: `${plural(interiorA.length, 'event')} between shared events appear in A only: ${listSome(interiorA)}.`, evidence: interiorA.slice(0, 3).map((v) => eventEv(a, v, 'only in A')) }); raise('warning') }
    if (interiorB.length > 0) { facts.push({ text: `${plural(interiorB.length, 'event')} between shared events appear in B only: ${listSome(interiorB)}.`, evidence: interiorB.slice(0, 3).map((v) => eventEv(b, v, 'only in B')) }); raise('warning') }
    if (edgeA > 0) { facts.push({ text: `${plural(edgeA, 'event')} before the first or after the last shared event appear in A only.`, evidence: lostA.filter((v) => !interiorA.includes(v)).slice(0, 3).map((v) => eventEv(a, v, 'only in A')) }); raise('info') }
    if (edgeB > 0) { facts.push({ text: `${plural(edgeB, 'event')} before the first or after the last shared event appear in B only.`, evidence: lostB.filter((v) => !interiorB.includes(v)).slice(0, 3).map((v) => eventEv(b, v, 'only in B')) }); raise('info') }
    if (moved > 0) { facts.push({ text: `${plural(moved, 'shared event')} arrive in a different order in B than in A.`, evidence: al.pairs.slice(0, 1).flatMap((p) => [eventEv(a, p.a, 'first shared event'), eventEv(b, p.b, 'matching event')]) }); raise('warning') }
    if (changed.length > 0) {
        const p = changed[0]!
        facts.push({ text: `${plural(changed.length, 'event')} with the same id have a different name or payload text in A and B, for example id ${p.a.id}.`, evidence: [eventEv(a, p.a, 'event'), eventEv(b, p.b, 'event')] })
        raise('warning')
    }
    if (cannotA + cannotB > 0) {
        facts.push({ text: `${plural(cannotA + cannotB, 'event')} (A ${cannotA}, B ${cannotB}) have no id, no payload text and no sequence number, so they cannot be matched.`, evidence: [] })
        raise('info')
    }
    if (!severity) return []

    if (interiorA.length + interiorB.length > 0 || nothingShared) {
        deductions.push({ statement: 'Likely: events are dropped, merged or filtered between A and B, or the two servers sent different events.', confidence: 'low', basis: [], alternatives: ['The captures cover different time spans on a live stream.', 'The client missed events while reconnecting.'] })
    }
    if (moved > 0) deductions.push({ statement: 'Likely: the events were produced by different sources or sent over different connections, since a single connection keeps order.', confidence: 'low', basis: [], alternatives: ['Event ids were reused across a reconnect.', 'Payload hashes matched equal-looking events in a different position.'] })

    const limits = [
        'Events are matched by id, then by event name and payload text, then by sequence number; the salted per-capture payload hash on event records is not used.',
        'A live stream can differ at the start and end simply because the captures began and ended at different moments.',
    ]
    if (!va.hasText || !vb.hasText) limits.push(`Payload text could not be rebuilt for ${[a, b].filter((_, i) => !(i === 0 ? va : vb).hasText).map((s) => s.label).join(' and ')}, so events there were matched by id or sequence number only.`)
    return [make({
        key: 'compare.events', severity, title: 'Event set or order differs',
        summary: 'The two captures did not deliver the same events in the same order.',
        facts, deductions, nextCheck: { description: 'Compare the event ids of both captures around the first difference.' }, limits,
    })]
}

// ---------------------------------------------------------------- latency of matching events

function compareLatency(a: Side, b: Side): ComparisonFinding[] {
    if (a.events.length === 0 || b.events.length === 0) return [] // reported under compare.events
    const al = alignEvents(eventViews(a.capture).views, eventViews(b.capture).views)
    if (al.pairs.length < 3) return [notCompared('compare.latency', 'Event arrival delay', [`only ${plural(al.pairs.length, 'event')} could be matched between A and B (at least 3 are needed)`])]
    const deltas = al.pairs.map((p) => (p.b.t - b.originT) - (p.a.t - a.originT))
    const med = median(deltas)!
    const range = Math.max(...deltas) - Math.min(...deltas)
    const abs = Math.abs(med)
    const severity: Severity | undefined = abs >= 1000 || range >= 2000 ? 'warning' : abs >= 250 || range >= 750 ? 'info' : undefined
    if (!severity) return []
    const first = al.pairs[0]!
    const slower = med >= 0 ? 'B' : 'A'
    return [make({
        key: 'compare.latency', severity, title: 'Matching events arrive at different times',
        summary: `Across ${plural(al.pairs.length, 'matched event')}, ${slower} receives them later than the other capture.`,
        facts: [{ text: `Median arrival difference (B minus A): ${Math.round(med)} ms; it ranges over ${fmtMs(range)} across the matched events.`, evidence: [ev(a, first.a, 'first matched event'), ev(b, first.b, 'first matched event')] }],
        deductions: [{ statement: 'Likely: a layer between A and B delays events or releases them in batches.', confidence: 'low', basis: [first.a.seq, first.b.seq], alternatives: ['The server emitted the events at different moments in the two runs.', 'The captures started at different points in a live stream.'] }],
        nextCheck: { description: 'Record both captures at the same moment against a stream with a known event schedule.' },
        limits: ['Arrival times are measured from each capture\'s first connect and assume both runs saw the same event schedule.', ...clientLimits(a, b)],
    })]
}

// ---------------------------------------------------------------- entry point

/** Compares two captures. Two identical captures yield nothing above info. */
export function compareCaptures(a: Capture, b: Capture): ComparisonFinding[] {
    const sa = sideOf('A', a)
    const sb = sideOf('B', b)
    return [
        ...compareStatus(sa, sb),
        ...compareHeaders(sa, sb),
        ...compareFirstByte(sa, sb),
        ...compareHeartbeat(sa, sb),
        ...compareChunks(sa, sb),
        ...compareEvents(sa, sb),
        ...compareLatency(sa, sb),
    ].sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
}
