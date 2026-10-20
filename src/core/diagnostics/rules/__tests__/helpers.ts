import { analyze, createEngine, type AnalyzeOptions } from '../../engine'
import type { Finding } from '../../finding'
import type { Rule } from '../../rule'
import type { EngineInput } from '../../streamModel'
import { defaultRules } from '..'
import type { CaptureBuilder } from '../../../testing/captureBuilder'
import type { Observation } from '../../../observe/observation'

/** The shipped rules plus the one under test, which is not registered yet. */
export const withRule = (rule: Rule, options: AnalyzeOptions = {}): AnalyzeOptions => ({ ...options, rules: [...defaultRules, rule] })

export const run = (b: CaptureBuilder, rule: Rule, options: AnalyzeOptions = {}) => analyze(b.build(), withRule(rule, { endT: b.now, ...options }))
export const runRecords = (records: EngineInput[], rule: Rule, endT: number, options: AnalyzeOptions = {}) => analyze(records, withRule(rule, { endT, ...options }))

export const find = (findings: Finding[], key: string) => findings.find((f) => f.key === key)
export const keys = (findings: Finding[]) => findings.map((f) => f.key)

/**
 * Feeds records the way a live host does, with ticks at several moments in between, and returns what the engine
 * reports at the end. Offline analysis must give exactly this.
 */
export function feedLive(records: EngineInput[], rule: Rule, endT: number, options: AnalyzeOptions = {}) {
    const engine = createEngine({ ...options, rules: [...defaultRules, rule] })
    let prevT = 0
    records.forEach((o, i) => {
        if (i % 3 === 0) engine.tick(prevT + (o.t - prevT) / 2)
        engine.feed(o)
        if (i % 2 === 0) engine.tick(o.t)
        prevT = o.t
    })
    engine.tick(endT)
    engine.end(endT)
    return { findings: engine.findings(), coverage: engine.coverage() }
}

/** The same capture analysed offline and fed live gives identical findings and coverage. */
export function sameLiveAndBatch(b: CaptureBuilder, rule: Rule, options: AnalyzeOptions = {}): { live: Finding[]; batch: Finding[] } {
    const records = b.build()
    const live = feedLive(records, rule, b.now, options)
    const batch = analyze(records, withRule(rule, { endT: b.now, ...options }))
    return { live: live.findings, batch: batch.findings }
}

/** Gives every event record a producer timestamp, in the order the events appear. */
export function withProducerTs(records: EngineInput[], tsOf: (index: number) => number): EngineInput[] {
    let i = 0
    return records.map((r) => (r.kind === 'event' ? { ...r, extracted: { ts: tsOf(i++) } } : r))
}

export interface ConsumerSample { t: number; n?: number; queueDepth: number; lagMs: number }

/** Adds page-domain consumer records and renumbers everything into one ordered capture. */
export function withConsumer(records: EngineInput[], samples: ConsumerSample[]): EngineInput[] {
    const consumer = samples.map((s): Observation => ({
        seq: 0, t: s.t, conn: 0, domain: 'page', kind: 'consumer', n: s.n ?? 1, queueDepth: s.queueDepth, receivedT: s.t - s.lagMs, processedT: s.t, lagMs: s.lagMs,
    }))
    const merged = [...records, ...consumer.map((c) => c as EngineInput)].map((r, index) => ({ r, index }))
    merged.sort((a, b) => a.r.t - b.r.t || a.index - b.index)
    return merged.map(({ r }, seq) => ({ ...r, seq }) as EngineInput)
}
