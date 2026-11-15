import type { StatSnapshot } from './stats'
import type { StreamProfile, Thresholds } from './thresholds'

/**
 * How long a silence may last before it is a stall. One place, so the rule that reports a stall and the model that decides which gaps
 * teach the stream's rhythm (a gap that was a stall must not) use the same limit, to the millisecond.
 *
 *  - `cadence`  the stream's own rhythm is known (enough gaps, or a cadence change that was recognised): 3 x the 95th-percentile gap, or
 *               twice the heartbeat interval, whichever is longer, and never under the minimum silence; an error above 5 x;
 *  - `profile`  the stream declares its longest silence;
 *  - `none`     nothing is known: the default.
 *
 * `stats` is the rhythm so far, that is the BASELINE, which holds no gap that was itself a stall.
 */
export interface StallLimit {
    warnMs: number
    errorMs?: number | undefined
    basis: 'cadence' | 'profile' | 'none'
}

export function stallLimit(stats: StatSnapshot, heartbeatMs: number | undefined, th: Thresholds, profile: StreamProfile, cadenceAllowed = true): StallLimit {
    const p95 = stats.p95
    if (cadenceAllowed && p95 !== undefined && (stats.count >= th.stallMinSamples || stats.trusted === true)) {
        const warnMs = Math.max(th.stallP95Factor * p95, th.stallHeartbeatFactor * (heartbeatMs ?? 0), th.stallMinSilenceMs)
        return { warnMs, errorMs: Math.max(th.stallErrorFactor * p95, th.stallErrorFactor * (heartbeatMs ?? 0), warnMs), basis: 'cadence' }
    }
    if (profile.expected?.maxSilenceMs !== undefined) return { warnMs: Math.max(profile.expected.maxSilenceMs, th.stallMinSilenceMs), basis: 'profile' }
    return { warnMs: th.stallNoCadenceMs, basis: 'none' }
}

/**
 * A changed cadence (results Q13, second stage). It is recognised from this many CONSECUTIVE gaps that were each a stall, on one connection,
 * with no normal gap between them. Three, because two can be a coincidence of two outages and one is just a stall; more would leave the
 * stream reported for longer than a person would wait.
 */
export const CADENCE_RUN = 3

/**
 * "Consistent": every gap within 25% of the median of the run (the edge counts as inside). A producer on a timer varies by a few percent and
 * a loaded one by more, so a quarter accepts a real schedule and still refuses a run like 8, 12 and 20 s, which is three unrelated outages.
 * Compared as `|gap - median| * 4 <= median`, which needs no floating point, so the edge is exact for whole milliseconds.
 */
export const CADENCE_TOLERANCE_PERCENT = 25

/** The median of the run when every gap is within the tolerance of it, otherwise undefined. */
export function consistentCadence(lengths: number[]): number | undefined {
    if (lengths.length !== CADENCE_RUN) return undefined
    const median = [...lengths].sort((a, b) => a - b)[Math.floor(lengths.length / 2)]!
    return lengths.every((g) => Math.abs(g - median) * 100 <= CADENCE_TOLERANCE_PERCENT * median) ? median : undefined
}
