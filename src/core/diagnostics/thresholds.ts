/** Numbers the rules compare against. Defaults come from the diagnostics plan; every one can be overridden. */
export interface Thresholds {
    /** R04: request sent to response headers. */
    connectToHeadersMs: number
    /** R04: response headers to the first body byte. */
    headersToFirstByteMs: number
    /** R04: first body byte to the first event. The finding becomes an error beyond `firstEventErrorFactor` times this. */
    firstByteToEventMs: number
    firstEventErrorFactor: number

    /** R05: gaps needed before the stream's own cadence is trusted. */
    stallMinSamples: number
    /** R05: warn when silence exceeds this many times the p95 gap... */
    stallP95Factor: number
    /** ...or this many times the heartbeat interval, whichever is larger. */
    stallHeartbeatFactor: number
    /** R05: error when silence exceeds this many times the p95 gap (or heartbeat interval). */
    stallErrorFactor: number
    /** R05: with no known cadence, silence is only reported after this long. */
    stallNoCadenceMs: number
    /** R05: silence shorter than this is never called a stall, however tight the stream's own rhythm. */
    stallMinSilenceMs: number

    /** R10: a heartbeat is late when its interval exceeds this many times the median interval. */
    heartbeatLateFactor: number
    /** R10/R05: heartbeat intervals needed before the cadence is trusted. */
    heartbeatMinIntervals: number

    /** R02: examples kept per violation code. */
    framingExamples: number

    /** R06: events needed before delivery is judged bursty. */
    burstMinEvents: number
    /** R06: events that must arrive within one chunk window to count as a burst. */
    burstEventsPerWindow: number
    /** R06: quiet time between bursts. */
    burstMinGapMs: number
    /** R06: the stream's nominal gap between events must be at least this, or fast streams would look bursty. */
    burstMinNominalGapMs: number

    /** R07: this many connections inside the window is a reconnect loop. */
    loopMinConnections: number
    loopWindowMs: number
    /** R07: this many reconnects without a single event in between. */
    loopNoEventReconnects: number
    /** R07: connection lifetimes needed before regularity is reported. */
    durationMinLifetimes: number
    /** R07: coefficient of variation under which lifetimes count as the same length. */
    durationMaxCv: number

    /** R09: events (or milliseconds) a gap may stay open while late events can still fill it. */
    reorderWindowEvents: number
    reorderWindowMs: number
    /** R09: how many recent sequence numbers are remembered to tell a duplicate from a new number. */
    sequenceWindow: number

    /** R11: page-side lag (p95) above which the page is called slow. */
    consumerLagP95Ms: number
    /** R11: queue growth over `consumerWindowMs` that means the page is falling behind. */
    consumerQueueGrowth: number
    consumerWindowMs: number
    /** R11: the ingest queue limit; reaching it drops events. */
    consumerQueueCap: number
    /** R12: query parameter names that look like credentials (compared case-insensitively, `-` and `_` alike). */
    credentialParamNames: readonly string[]
}

export const DEFAULT_THRESHOLDS: Thresholds = {
    connectToHeadersMs: 3000,
    headersToFirstByteMs: 3000,
    firstByteToEventMs: 5000,
    firstEventErrorFactor: 3,
    stallMinSamples: 10,
    stallP95Factor: 3,
    stallHeartbeatFactor: 2,
    stallErrorFactor: 5,
    stallNoCadenceMs: 30_000,
    stallMinSilenceMs: 1000,
    heartbeatLateFactor: 2.5,
    heartbeatMinIntervals: 3,
    framingExamples: 5,
    burstMinEvents: 30,
    burstEventsPerWindow: 8,
    burstMinGapMs: 1000,
    burstMinNominalGapMs: 100,
    loopMinConnections: 3,
    loopWindowMs: 60_000,
    loopNoEventReconnects: 5,
    durationMinLifetimes: 3,
    durationMaxCv: 0.03,
    reorderWindowEvents: 50,
    reorderWindowMs: 2000,
    sequenceWindow: 4096,
    consumerLagP95Ms: 250,
    consumerQueueGrowth: 1000,
    consumerWindowMs: 5000,
    consumerQueueCap: 20_000,
    credentialParamNames: ['token', 'access_token', 'auth', 'key', 'api_key', 'jwt', 'password', 'secret', 'sig'],
}

export const resolveThresholds = (overrides?: Partial<Thresholds>): Thresholds => ({ ...DEFAULT_THRESHOLDS, ...overrides })

/** What the author of a stream says to expect. Only the parts the rules in this batch use. */
/**
 * A sequence contract: how this stream numbers its events. Only a declared contract lets the rules call a gap or a
 * duplicate a problem; opaque ids prove nothing (a server may legitimately send 104 then 111).
 */
export interface SequenceContract {
    /** JSON path in the payload (`$.seq`), or the SSE `id:` field. */
    field?: string | undefined
    useSseId?: boolean | undefined
    /** `consecutive`: every step is +1, a gap is loss. `monotonic`: gaps are allowed, only repeats and regressions are findings. */
    policy: 'consecutive' | 'monotonic'
    /** JSON path (or '$event') whose value gives each partition its own sequence. */
    partitionBy?: string | undefined
}

export type DeliverySemantics = 'at_least_once' | 'exactly_once' | 'at_most_once'

export interface StreamProfile {
    sequence?: SequenceContract | undefined
    /** Decides whether a duplicate after a reconnect is expected replay (at least once) or an error (exactly once). */
    delivery?: DeliverySemantics | undefined
    /** JSON path of a producer timestamp, for judging delivery spacing. */
    timestampField?: string | undefined
    expected?: {
        /** Time to the first event, replaces `firstByteToEventMs`. */
        firstEventMs?: number | undefined
        /** The longest silence the stream should ever have; replaces the 30 s default when there is no measured cadence. */
        maxSilenceMs?: number | undefined
        /** How often the producer sends a heartbeat. */
        heartbeatMs?: number | undefined
    } | undefined
}
