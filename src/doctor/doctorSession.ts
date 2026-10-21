/**
 * One stream's diagnosis in the page: an engine fed from the observation registry, plus the figures the health strip
 * shows. This module holds the rules, so the app loads it lazily (see doctorStore.ts).
 *
 * Time. Records carry the monotonic time of the recorder that made them. For a stream run by the SharedWorker that is
 * the worker's clock, which the page cannot read, so the page estimates "now" in the recorder's clock as the newest
 * record's time plus the page time that passed since that record was synced. The estimate is never ahead of the truth, so
 * it can only make a silence look shorter than it is, never invent one.
 *
 * Consumer samples are measured in the page, with the page recorder's clock and their own sequence numbers. They are
 * moved into the transport clock by one constant offset (fixed when the first one arrives) and into a separate number
 * range, so they cannot collide with transport records.
 */

import { SEVERITY_RANK, createEngine, type Engine, type Finding, type RuleCoverage, type Severity, type StreamProfile } from '../core/diagnostics'
import type { Observation } from '../core/observe/observation'
import { RollingStats } from '../core/diagnostics/stats'
import type { RegistryEntry } from './observationRegistry'
import { CONSUMER_SEQ_BASE } from './recordLookup'


export interface HealthView {
    phase: string
    attempt: number
    /** How long the stream has been in this phase. */
    phaseAgeMs: number | null
    lastByteAgeMs: number | null
    lastOriginAgeMs: number | null
    lastEventAgeMs: number | null
    /** Age of the newest proxy comment on the current connection; null when the proxy sent none. */
    proxyBeatAgeMs: number | null
    originBeats: number
    proxyBeats: number
    originBeatMedianMs: number | null
    events: number
    reconnects: number
    consumer: { samples: number; p95LagMs: number | null; queueDepth: number } | null
    capture: { records: number; retainedBytes: number; capBytes: number; dropped: number }
}

export interface DoctorView {
    streamId: string
    captureId: string | null
    /** The profile the rules ran with, if one is declared. */
    profile: StreamProfile | undefined
    /** The time this view was made at, in the recording's clock. */
    nowT: number
    findings: Finding[]
    coverage: RuleCoverage[]
    health: HealthView
    /** Open findings by severity. */
    open: Record<Severity, number>
    /** Highest severity among open findings, or null. */
    worst: Severity | null
    evaluated: number
    notEvaluated: number
}

const emptyOpen = (): Record<Severity, number> => ({ info: 0, warning: 0, error: 0, critical: 0 })
const age = (now: number, at: number | undefined): number | null => (at === undefined ? null : Math.max(0, now - at))

export class DoctorSession {
    private engine: Engine
    private store: RegistryEntry['store'] | undefined
    private captureId: string | null = null
    private lastSeq = -1
    private lastConsumerSeq = -1
    private offset: number | undefined
    private lastRecordT = 0
    private lastRecordLocal = 0
    /** The page time of the newest record has been noted at least once. */
    private anchored = false
    private syncedVersion = -1
    private lag = new RollingStats(256)
    private queueDepth = 0
    private consumerSamples = 0

    constructor(readonly streamId: string, private profile?: StreamProfile) {
        this.engine = this.newEngine()
    }

    private newEngine(): Engine {
        return createEngine(this.profile ? { profile: this.profile } : {})
    }

    private reset(): void {
        this.engine = this.newEngine()
        this.lastSeq = -1
        this.lastConsumerSeq = -1
        this.offset = undefined
        this.lastRecordT = 0
        this.lastRecordLocal = 0
        this.anchored = false
        this.syncedVersion = -1
        this.queueDepth = 0
        this.consumerSamples = 0
        this.lag = new RollingStats(256)
    }

    /**
     * Judge the records again under a different profile. What was seen stays the same and so does the time that has passed
     * since the last record, so a silence that was going on keeps counting; only the rules' reading changes.
     */
    setProfile(profile: StreamProfile | undefined): void {
        const { lastRecordT, lastRecordLocal, offset, anchored } = this
        this.profile = profile
        this.reset()
        this.lastRecordT = lastRecordT
        this.lastRecordLocal = lastRecordLocal
        this.anchored = anchored
        this.offset = offset
    }

    /** The recorder-clock time that corresponds to page time `localNow`. */
    nowT(localNow: number): number {
        return this.lastRecordT + Math.max(0, localNow - this.lastRecordLocal)
    }

    /**
     * Feed the records the registry holds that the engine has not seen. Returns true when anything changed.
     * `pageNow` is the page recorder's elapsed time, used once to place consumer samples in the transport clock.
     */
    sync(entry: RegistryEntry, localNow: number, pageNow: number | undefined): boolean {
        if (entry.captureId !== this.captureId || entry.store !== this.store) {
            this.reset()
            this.captureId = entry.captureId
            this.store = entry.store
        }
        if (entry.version === this.syncedVersion) return false

        let changed = false
        const records = entry.store.snapshot()
        const newest = records[records.length - 1]
        // The store was emptied and refilled under the same id: start over from what it holds now.
        if (newest && newest.seq < this.lastSeq) {
            const { captureId, store } = this
            this.reset()
            this.captureId = captureId
            this.store = store
        }
        let advanced = false
        let from = records.length
        while (from > 0 && records[from - 1]!.seq > this.lastSeq) from--
        for (let i = from; i < records.length; i++) {
            const o = records[i]!
            this.engine.feed(o)
            this.lastSeq = o.seq
            if (o.t > this.lastRecordT) { this.lastRecordT = o.t; advanced = true }
            changed = true
        }
        // Only a record that is newer than the last moves the anchor; records fed again after a profile change do not.
        if (advanced || (changed && !this.anchored)) { this.lastRecordLocal = localNow; this.anchored = true }

        const fresh = entry.consumer.filter((c) => c.seq > this.lastConsumerSeq)
        if (fresh.length > 0 && pageNow !== undefined) {
            this.offset ??= this.nowT(localNow) - pageNow
            for (const c of fresh) {
                if (c.kind !== 'consumer') continue
                // Counted on the connection that is current, so a sample never creates a connection of its own.
                const shifted: Observation = { ...c, conn: this.engine.model.current()?.conn ?? 0, seq: c.seq + CONSUMER_SEQ_BASE, t: c.t + this.offset, receivedT: c.receivedT + this.offset, processedT: c.processedT + this.offset }
                this.engine.feed(shifted)
                this.lag.push(c.lagMs)
                this.queueDepth = c.queueDepth
                this.consumerSamples++
                this.lastConsumerSeq = c.seq
            }
            changed = true
        }
        this.syncedVersion = entry.version
        return changed
    }

    /** Let time pass: shows silences that are still going on. */
    tick(localNow: number): void {
        this.engine.tick(this.nowT(localNow))
    }

    /** The page was frozen or hidden, so the time that passed says nothing about the stream. */
    discontinuity(localNow: number, gapMs: number, reason: string): void {
        const conn = this.engine.model.current()?.conn ?? 0
        // Placed between the last record and the next one, so silence measuring restarts exactly here.
        this.engine.feed({ kind: 'clock.discontinuity', seq: this.lastSeq + 0.5, t: this.nowT(localNow), conn, gapMs, reason })
    }

    view(localNow: number, entry: RegistryEntry): DoctorView {
        const now = this.nowT(localNow)
        const model = this.engine.model
        const findings = this.engine.findings()
        const coverage = this.engine.coverage()
        const open = emptyOpen()
        let worst: Severity | null = null
        for (const f of findings) {
            if (f.status !== 'open') continue
            open[f.severity]++
            if (worst === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity
        }
        const c = model.current()
        const stats = entry.store.stats
        let events = 0
        for (const conn of model.conns.values()) events += conn.events
        return {
            streamId: this.streamId,
            captureId: this.captureId,
            profile: this.profile,
            nowT: now,
            findings,
            coverage,
            open,
            worst,
            evaluated: coverage.filter((r) => r.status === 'evaluated').length,
            notEvaluated: coverage.filter((r) => r.status === 'not-evaluated').length,
            health: {
                phase: model.phase,
                attempt: c?.attempt ?? 0,
                phaseAgeMs: model.phase === 'idle' ? null : Math.max(0, now - model.phaseSinceT),
                lastByteAgeMs: age(now, c?.lastByte?.t),
                lastOriginAgeMs: age(now, c?.lastOrigin?.t),
                lastEventAgeMs: age(now, c?.lastEvent?.t),
                proxyBeatAgeMs: age(now, c?.lastHb.proxy?.t),
                originBeats: model.heartbeats.upstream.count,
                proxyBeats: model.heartbeats.proxy.count,
                originBeatMedianMs: model.originHeartbeatMedian() ?? null,
                events,
                reconnects: model.reconnects.length,
                consumer: this.consumerSamples > 0 ? { samples: this.consumerSamples, p95LagMs: this.lag.p95() ?? null, queueDepth: this.queueDepth } : null,
                capture: { records: stats.total, retainedBytes: stats.retainedBytes, capBytes: stats.capBytes, dropped: stats.dropped.chunk + stats.dropped.event + stats.dropped.heartbeat + stats.dropped.violation },
            },
        }
    }
}
