import { frameLog, type LoggedConnection } from '../groundTruth'
import type { Observation } from '../../core/observe/observation'
import type { Finding } from '../../core/diagnostics/finding'

/**
 * The four-way comparison: the same stream seen at four places, and every place checked against the one before.
 *
 *   L0  the server's own log         (groundTruth.ts: what was written, when, how the connection ended)
 *   L1  transport records            (connect, response, chunk, comment, reconnect: what the client read)
 *   L2  parsed events                (the event records, and the messages the application was given)
 *   L3  findings                     (what the Doctor concluded)
 *
 * Each mismatch names the boundary it was found at, so a failure says where to look first: the fixture, the pipeline, or a rule.
 * Chunk COUNTS are never compared (a loopback socket merges writes made in the same tick); bytes and event identity are.
 */

export type Boundary = 'server->transport' | 'transport->parser' | 'parser->delivered' | 'transport->findings' | 'clock'

export interface Mismatch {
    boundary: Boundary
    invariant: string
    connection: number | undefined
    detail: string
}

export interface FourWayInput {
    /** The server's connections for THIS run, in order; the n-th is record connection n. */
    log: LoggedConnection[]
    records: Observation[]
    messages: Array<{ id: string; event: string; dataBytes: number }>
    findings: Finding[]
    /** Milliseconds a record's time may be ahead of the server's clock (timer resolution on Windows is ~16 ms). Default 25. */
    clockSlackMs?: number
    /** The longest a record may lag the write that carried it. Default 250 (loopback). */
    maxLagMs?: number
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

export function compareFourWay(input: FourWayInput): Mismatch[] {
    const { log, records, messages, findings } = input
    const out: Mismatch[] = []
    const miss = (boundary: Boundary, invariant: string, connection: number | undefined, detail: string): void => { out.push({ boundary, invariant, connection, detail }) }
    const forConn = (conn: number) => records.filter((r) => r.conn === conn)

    // I1 bytes: what the server wrote, the client read (exactly, if the server ended it; at most, if the client left first)
    log.forEach((c, i) => {
        const wrote = sum(c.writes.map((w) => w.bytes))
        const read = sum(forConn(i).filter((r): r is Extract<Observation, { kind: 'chunk' }> => r.kind === 'chunk').map((r) => r.bytes))
        if (c.endedBy === 'server-end' && wrote !== read) miss('server->transport', 'I1 bytes', i, `the server wrote ${wrote} bytes and ended the connection; the client read ${read}`)
        if (c.endedBy !== 'server-end' && read > wrote) miss('server->transport', 'I1 bytes', i, `the client read ${read} bytes, more than the ${wrote} the server wrote`)
    })

    // I2 events: per connection, the events the parser reported are the complete events the server sent, with their ids, names and sizes
    log.forEach((c, i) => {
        const expected = frameLog(c).filter((f) => f.terminated && f.hasData)
        const got = forConn(i).filter((r): r is Extract<Observation, { kind: 'event' }> => r.kind === 'event')
        if (c.endedBy === 'server-end' || c.endedBy === 'server-destroy') {
            if (expected.length !== got.length) { miss('transport->parser', 'I2 events', i, `the server sent ${expected.length} complete events, the parser reported ${got.length}`); return }
        } else if (got.length > expected.length) { miss('transport->parser', 'I2 events', i, `the parser reported ${got.length} events, the server had sent ${expected.length}`); return }
        got.forEach((g, k) => {
            const e = expected[k]!
            if (g.sseId !== e.effectiveId) miss('transport->parser', 'I2 events', i, `event ${k + 1}: id "${g.sseId}", the server's was "${e.effectiveId}"`)
            else if (g.event !== e.event) miss('transport->parser', 'I2 events', i, `event ${k + 1}: name "${g.event}", the server's was "${e.event}"`)
            else if (g.dataBytes !== e.dataBytes) miss('transport->parser', 'I2 events', i, `event ${k + 1}: ${g.dataBytes} data bytes, the server's were ${e.dataBytes}`)
        })
    })

    // I3 delivered: the application was given exactly the events that were recorded: nothing added, nothing lost
    const eventRecords = records.filter((r): r is Extract<Observation, { kind: 'event' }> => r.kind === 'event')
    if (messages.length !== eventRecords.length) miss('parser->delivered', 'I3 delivered', undefined, `${eventRecords.length} events were recorded, ${messages.length} were delivered`)
    else messages.forEach((m, k) => { const r = eventRecords[k]!; if (m.id !== r.sseId || m.event !== r.event) miss('parser->delivered', 'I3 delivered', undefined, `message ${k + 1} is "${m.event}" #${m.id}, the record is "${r.event}" #${r.sseId}`) })

    // I4 cursor: the id the client says it sent is the id the server received
    log.forEach((c, i) => {
        const connect = forConn(i).find((r): r is Extract<Observation, { kind: 'connect' }> => r.kind === 'connect')
        if (!connect) return
        const header = c.requestHeaders['last-event-id'] ?? ''
        if (connect.sentLastEventId !== header) miss('server->transport', 'I4 cursor', i, `the client recorded sending Last-Event-ID "${connect.sentLastEventId}", the server received "${header}"`)
    })
    records.filter((r): r is Extract<Observation, { kind: 'reconnect' }> => r.kind === 'reconnect').forEach((r) => {
        const next = log[r.conn + 1]
        if (next && r.lastEventIdSent !== (next.requestHeaders['last-event-id'] ?? '')) miss('server->transport', 'I4 cursor', r.conn + 1, `the reconnect record says "${r.lastEventIdSent}", the next request carried "${next.requestHeaders['last-event-id'] ?? ''}"`)
    })

    // I5 time: an event is recorded after the write that carried it, and not long after. The first connect anchors the two clocks.
    const firstConnect = records.find((r) => r.kind === 'connect')
    if (firstConnect && log[0]) {
        const offset = log[0].acceptedEpochMs - firstConnect.t // epoch time of record time 0
        const slack = input.clockSlackMs ?? 25
        const lag = input.maxLagMs ?? 250
        log.forEach((c, i) => {
            const frames = frameLog(c).filter((f) => f.terminated && f.hasData)
            forConn(i).filter((r): r is Extract<Observation, { kind: 'event' }> => r.kind === 'event').forEach((r, k) => {
                const frame = frames[k]
                const write = frame && c.writes[frame.lastWrite]
                if (!write) return
                const recordedAt = offset + r.t
                if (recordedAt < write.epochMs - slack) miss('clock', 'I5 time', i, `event ${k + 1} was recorded ${Math.round(write.epochMs - recordedAt)} ms before the server wrote it`)
                else if (recordedAt - write.epochMs > lag) miss('clock', 'I5 time', i, `event ${k + 1} was recorded ${Math.round(recordedAt - write.epochMs)} ms after the server wrote it`)
            })
        })
    }

    // I6 findings: a finding that quotes a count quotes the true one
    const loop = findings.find((f) => f.key === 'reconnect.loop')
    if (loop) {
        const m = /(\d+) connections were opened within/.exec(loop.facts.map((f) => f.text).join(' '))
        if (m && loop.facts[0]!.text.includes(m[0]) && Number(m[1]) > log.length) miss('transport->findings', 'I6 findings', undefined, `reconnect.loop says ${m[1]} connections were opened, the server accepted ${log.length}`)
    }
    return out
}
