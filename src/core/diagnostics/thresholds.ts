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
    credentialParamNames: ['token', 'access_token', 'auth', 'key', 'api_key', 'jwt', 'password', 'secret', 'sig'],
}

export const resolveThresholds = (overrides?: Partial<Thresholds>): Thresholds => ({ ...DEFAULT_THRESHOLDS, ...overrides })

/** What the author of a stream says to expect. Only the parts the rules in this batch use. */
export interface StreamProfile {
    expected?: {
        /** Time to the first event, replaces `firstByteToEventMs`. */
        firstEventMs?: number | undefined
        /** The longest silence the stream should ever have; replaces the 30 s default when there is no measured cadence. */
        maxSilenceMs?: number | undefined
        /** How often the producer sends a heartbeat. */
        heartbeatMs?: number | undefined
    } | undefined
}
