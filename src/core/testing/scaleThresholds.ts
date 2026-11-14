import { DEFAULT_THRESHOLDS, type StreamProfile, type Thresholds } from '../diagnostics/thresholds'

/**
 * Thresholds for a test that runs a fixture at a time scale (`?scale=0.05` makes every delay of the fixture 5% as long).
 *
 * The fixture server scales its sleeps and nothing else, so a limit of 30 s that a stream at scale 0.05 reaches after 1.5 s would never be
 * crossed. A test must not make up numbers to compensate (400 here, 500 there: each one an unchecked claim that "the rule still behaves the
 * same"); it asks for the defaults at the scale it uses: every threshold that is a number of milliseconds is multiplied by `scale`, and
 * nothing else changes (counts, factors, windows counted in events and the list of parameter names stay as they are).
 *
 * Two limits to know. At a scale so small that a limit falls under the timer granularity of the machine (about 16 ms on Windows) the result is
 * noise: do not go below 0.02. And `consumerLagP95Ms` and `consumerWindowMs` measure the page's own work and are scaled like the rest only
 * because a time scale cannot tell them apart; a test of the consumer rule has its own time.
 */
export function scaleThresholds(base: Thresholds, scale: number): Thresholds {
    if (!Number.isFinite(scale) || scale <= 0) throw new Error(`a time scale must be a number above 0, got ${scale}`)
    const out: Record<string, unknown> = { ...base }
    for (const key of Object.keys(base)) {
        const value = base[key as keyof Thresholds]
        if (key.endsWith('Ms') && typeof value === 'number') out[key] = value * scale
    }
    return out as unknown as Thresholds
}

/** The stream profile a user declared, with the times in `expected` scaled the same way as the thresholds. Nothing else in a profile is a time. */
export function scaleProfile(profile: StreamProfile, scale: number): StreamProfile {
    if (!Number.isFinite(scale) || scale <= 0) throw new Error(`a time scale must be a number above 0, got ${scale}`)
    if (!profile.expected) return profile
    const expected: NonNullable<StreamProfile['expected']> = {}
    for (const [key, value] of Object.entries(profile.expected)) {
        if (typeof value === 'number') expected[key as keyof typeof expected] = value * scale
    }
    return { ...profile, expected }
}

/** The thresholds the defaults give at `scale`: shorthand for `scaleThresholds(DEFAULT_THRESHOLDS, scale)`. */
export const defaultsAt = (scale: number): Thresholds => scaleThresholds(DEFAULT_THRESHOLDS, scale)
