import type { Deduction, FindingDraft, Severity } from '../finding'
import type { Rule, RuleContext } from '../rule'
import type { ConnectionState, Mark } from '../streamModel'
import { ev, fmtMs } from './util'

/**
 * R04 timing.first-event: where the time went before the first event of a connection.
 *   headers     request sent -> response headers      (late: cold start, auth or a proxy hop)
 *   first-byte  headers -> first body byte            (late despite on-time headers: the server is not flushing)
 *   first-event first body byte -> first event
 * Each stage is measured once it completes. A stage still waiting is shown provisionally (onTick) and kept at the
 * end of the capture (onEnd). A connection that ended while a stage was waiting measures the wait up to its end.
 */

type StageName = 'headers' | 'first-byte' | 'first-event'

interface Stage {
    name: StageName
    start: Mark
    end?: Mark | undefined
    /** The connection ended before the stage completed. */
    endedAt?: Mark | undefined
    thresholdMs: number
    errorFactor?: number | undefined
}

interface Seen { count: number; firstSeenT: number; severity: Severity }

const KEY = (n: StageName) => `timing.first-event:${n}`

function stagesOf(c: ConnectionState, ctx: RuleContext): Stage[] {
    const { thresholds: th, profile } = ctx
    const out: Stage[] = []
    const endedAt: Mark | undefined = c.endedT !== undefined && c.endedSeq !== undefined ? { t: c.endedT, seq: c.endedSeq } : undefined
    if (c.connect) out.push({ name: 'headers', start: c.connect, end: c.response, endedAt, thresholdMs: th.connectToHeadersMs })
    if (c.response?.status === 200) {
        out.push({ name: 'first-byte', start: c.response, end: c.firstChunk, endedAt, thresholdMs: th.headersToFirstByteMs })
        if (c.firstChunk) out.push({ name: 'first-event', start: c.firstChunk, end: c.firstEvent, endedAt, thresholdMs: profile.expected?.firstEventMs ?? th.firstByteToEventMs, errorFactor: th.firstEventErrorFactor })
    }
    return out
}

export const firstEvent: Rule = {
    id: 'timing.first-event',
    version: 1,
    title: 'Time to first event',
    requires: ['connect', 'response', 'chunks'],
    create(ctx) {
        const seen = new Map<string, Seen>()

        const build = (stage: Stage, nowT: number): { draft: FindingDraft; next: Seen } | undefined => {
            const finish = stage.end ?? stage.endedAt
            const endT = finish?.t ?? nowT
            const dur = endT - stage.start.t
            if (dur <= stage.thresholdMs) return undefined
            const key = KEY(stage.name)
            const prior = seen.get(key)
            const severity: Severity = stage.errorFactor !== undefined && dur > stage.thresholdMs * stage.errorFactor ? 'error' : 'warning'
            const completed = stage.end !== undefined
            const waited = completed ? `${fmtMs(dur)}` : stage.endedAt ? `${fmtMs(dur)} before the connection ended` : `${fmtMs(dur)} so far`
            const evidence = [ev(stage.start.seq, stage.start.t, stage.name === 'headers' ? 'request sent' : stage.name === 'first-byte' ? 'response headers' : 'first body byte'), ...(finish ? [ev(finish.seq, finish.t, completed ? 'stage complete' : 'connection ended')] : [])]
            const basis = evidence.map((e) => e.seq)
            let title: string, fact: string, deduction: Deduction
            if (stage.name === 'headers') {
                title = 'Slow response headers'
                fact = completed ? `Response headers arrived ${waited} after the request was sent.` : `No response headers ${waited} after the request was sent.`
                deduction = { statement: 'Likely: a slow server start, authentication, or a proxy hop before the headers were sent.', confidence: 'low', basis, alternatives: ['Network latency, DNS or TLS setup.', 'A cold start of a serverless function.'] }
            } else if (stage.name === 'first-byte') {
                title = 'Slow first byte after the headers'
                fact = completed ? `The first body byte arrived ${waited} after the response headers (the headers themselves were prompt).` : `No body byte ${waited} after the response headers.`
                deduction = { statement: 'Likely: the server sent the headers but is not flushing the body; it may be waiting on upstream data or a proxy is holding the first bytes.', confidence: 'low', basis, alternatives: ['The producer has nothing to say until its first event is ready.', 'Response buffering by an intermediary.'] }
            } else {
                title = 'Slow first event'
                fact = completed ? `The first event arrived ${waited} after the first body byte.` : `No event ${waited} after the first body byte.`
                deduction = { statement: 'Likely: the stream is open but the first event is slow to be produced, or events are held back after bytes (such as heartbeats) were delivered.', confidence: 'low', basis, alternatives: ['The producer only emits events when the underlying data changes.', 'Events are buffered until a size or time limit is reached.'] }
            }
            const next: Seen = { count: (prior?.count ?? 0) + 1, firstSeenT: prior?.firstSeenT ?? stage.start.t + stage.thresholdMs, severity: prior && prior.severity === 'error' ? 'error' : severity }
            return {
                next,
                draft: {
                    key, title, severity: next.severity,
                    summary: fact,
                    facts: [{ text: fact, evidence }, { text: `The threshold is ${fmtMs(stage.thresholdMs)}.`, evidence: [] }],
                    deductions: [deduction],
                    limits: ['Times are measured by the client; clock resolution and queueing in the client are included.'],
                    status: completed ? 'resolved' : 'open',
                    firstSeenT: next.firstSeenT, lastSeenT: endT, occurrences: next.count,
                },
            }
        }

        const commit = (c: ConnectionState, names: StageName[], nowT: number): FindingDraft[] => {
            const out: FindingDraft[] = []
            for (const stage of stagesOf(c, ctx)) {
                if (!names.includes(stage.name)) continue
                const built = build(stage, nowT)
                if (!built) continue
                seen.set(built.draft.key, built.next)
                out.push(built.draft)
            }
            return out
        }

        const pending = (c: ConnectionState, nowT: number, keep: boolean): FindingDraft[] => {
            const out: FindingDraft[] = []
            for (const stage of stagesOf(c, ctx)) {
                if (stage.end !== undefined || stage.endedAt !== undefined) continue
                const built = build(stage, nowT)
                if (!built) continue
                if (keep) seen.set(built.draft.key, built.next)
                out.push(built.draft)
            }
            return out
        }

        return {
            onObservation(o, model): FindingDraft[] {
                const c = model.conn(o.conn)
                if (!c) return []
                if (o.kind === 'response') return commit(c, ['headers'], o.t)
                if (o.kind === 'chunk' && c.chunks === 1) return commit(c, ['first-byte'], o.t)
                if (o.kind === 'event' && c.events === 1) return commit(c, ['first-event'], o.t)
                // The connection ended while a stage was still waiting: measure the wait up to the end.
                if (o.kind === 'phase' && c.endedSeq === o.seq) return commit(c, ['headers', 'first-byte', 'first-event'].filter((n) => {
                    const done = n === 'headers' ? c.response : n === 'first-byte' ? c.firstChunk : c.firstEvent
                    return done === undefined
                }) as StageName[], o.t)
                return []
            },
            onTick(nowT, model) {
                const c = model.current()
                return c ? pending(c, nowT, false) : undefined
            },
            onEnd(endT, model) {
                const c = model.current()
                return c ? pending(c, endT, true) : undefined
            },
        }
    },
}
