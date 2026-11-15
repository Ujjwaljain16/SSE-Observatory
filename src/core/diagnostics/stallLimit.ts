import type { StatSnapshot } from './stats'
import type { StreamProfile, Thresholds } from './thresholds'

/**
 * How long a silence may last before it is a stall. One place, so the rule that reports a stall and the model that decides which gaps
 * teach the stream's rhythm (a gap that was a stall must not) use the same limit, to the millisecond.
 *
 *  - `cadence`  the stream's own rhythm is known (enough gaps): 3 x the 95th-percentile gap, or twice the heartbeat interval, whichever is
 *               longer, and never under the minimum silence; an error above 5 x;
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
    if (cadenceAllowed && p95 !== undefined && stats.count >= th.stallMinSamples) {
        const warnMs = Math.max(th.stallP95Factor * p95, th.stallHeartbeatFactor * (heartbeatMs ?? 0), th.stallMinSilenceMs)
        return { warnMs, errorMs: Math.max(th.stallErrorFactor * p95, th.stallErrorFactor * (heartbeatMs ?? 0), warnMs), basis: 'cadence' }
    }
    if (profile.expected?.maxSilenceMs !== undefined) return { warnMs: Math.max(profile.expected.maxSilenceMs, th.stallMinSilenceMs), basis: 'profile' }
    return { warnMs: th.stallNoCadenceMs, basis: 'none' }
}
