// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLDS, type StreamProfile, type Thresholds } from '../../diagnostics/thresholds'
import { defaultsAt, scaleProfile, scaleThresholds } from '../scaleThresholds'

// The helper that every time-scaled fixture test takes its thresholds from (plan 5.1, C5). If it scaled the wrong keys, or missed a new one, a
// scaled test would be judging a stream against numbers that mean something else, and nothing would say so.

const numberKeys = (Object.keys(DEFAULT_THRESHOLDS) as Array<keyof Thresholds>).filter((k) => typeof DEFAULT_THRESHOLDS[k] === 'number')

/** Every numeric threshold that is NOT a time, with what it is. A new number that is neither here nor named `...Ms` fails the test below, so someone has to say which it is. */
const NOT_A_TIME: Record<string, string> = {
    firstEventErrorFactor: 'factor', stallMinSamples: 'count', stallP95Factor: 'factor', stallHeartbeatFactor: 'factor', stallErrorFactor: 'factor',
    heartbeatLateFactor: 'factor', heartbeatMinIntervals: 'count', framingExamples: 'count', burstMinEvents: 'count', burstEventsPerWindow: 'count',
    loopMinConnections: 'count', loopNoEventReconnects: 'count', durationMinLifetimes: 'count', durationMaxCv: 'ratio',
    reorderWindowEvents: 'events', sequenceWindow: 'events', consumerQueueGrowth: 'events', consumerQueueCap: 'events',
    driftBaselineEvents: 'events', driftWindowEvents: 'events', driftWindowShare: 'ratio', driftCoreShare: 'ratio',
}

describe('scaleThresholds', () => {
    it('multiplies every threshold that is a number of milliseconds, and nothing else', () => {
        const scaled = scaleThresholds(DEFAULT_THRESHOLDS, 0.1)
        for (const key of numberKeys) {
            const was = DEFAULT_THRESHOLDS[key] as number
            if (key.endsWith('Ms')) expect(scaled[key], key).toBeCloseTo(was * 0.1, 9)
            else expect(scaled[key], key).toBe(was)
        }
        expect(scaled.credentialParamNames).toEqual(DEFAULT_THRESHOLDS.credentialParamNames)
    })

    it('has a place for every number a threshold can be: a time (named ...Ms) or one of the listed counts, factors and ratios', () => {
        const unclassified = numberKeys.filter((k) => !k.endsWith('Ms') && !(k in NOT_A_TIME))
        expect(unclassified, 'a new numeric threshold: is it a time? name it ...Ms; otherwise list what it is in NOT_A_TIME').toEqual([])
        expect(Object.keys(NOT_A_TIME).filter((k) => !(k in DEFAULT_THRESHOLDS)), 'a listed threshold that is gone').toEqual([])
    })

    it('is the identity at scale 1, is a new object, and leaves the base alone', () => {
        const before = JSON.stringify(DEFAULT_THRESHOLDS)
        const same = scaleThresholds(DEFAULT_THRESHOLDS, 1)
        expect(same).toEqual(DEFAULT_THRESHOLDS)
        expect(same).not.toBe(DEFAULT_THRESHOLDS)
        scaleThresholds(DEFAULT_THRESHOLDS, 0.05)
        expect(JSON.stringify(DEFAULT_THRESHOLDS)).toBe(before)
    })

    it('composes: scaling by a and then by b is scaling by a x b', () => {
        const twice = scaleThresholds(scaleThresholds(DEFAULT_THRESHOLDS, 0.5), 0.2)
        const once = scaleThresholds(DEFAULT_THRESHOLDS, 0.1)
        for (const key of numberKeys) expect(twice[key], key).toBeCloseTo(once[key] as number, 9)
    })

    it('refuses a scale that is not a number above 0', () => {
        for (const bad of [0, -1, NaN, Infinity, -Infinity]) expect(() => scaleThresholds(DEFAULT_THRESHOLDS, bad), String(bad)).toThrow(/above 0/)
    })

    it('defaultsAt is the shorthand for the defaults at a scale', () => {
        expect(defaultsAt(0.25)).toEqual(scaleThresholds(DEFAULT_THRESHOLDS, 0.25))
    })

    it('gives the 1 s floor and the 30 s no-cadence limit as 50 ms and 1.5 s at scale 0.05 (the older fixture tests hand-picked 400 and 500)', () => {
        const scaled = defaultsAt(0.05)
        expect(scaled.stallMinSilenceMs).toBe(50)
        expect(scaled.stallNoCadenceMs).toBe(1500)
    })
})

describe('scaleProfile', () => {
    it('scales the times a profile declares and leaves everything else as it was', () => {
        const profile: StreamProfile = { sequence: { useSseId: true, policy: 'consecutive' }, delivery: 'at_least_once', timestampField: '$.ts', expected: { firstEventMs: 2000, maxSilenceMs: 60_000, heartbeatMs: 15_000 } }
        const scaled = scaleProfile(profile, 0.1)
        expect(scaled.expected).toEqual({ firstEventMs: 200, maxSilenceMs: 6000, heartbeatMs: 1500 })
        expect({ ...scaled, expected: undefined }).toEqual({ ...profile, expected: undefined })
        expect(profile.expected!.maxSilenceMs).toBe(60_000)
    })

    it('returns a profile with no declared times as it is', () => {
        const profile: StreamProfile = { delivery: 'exactly_once' }
        expect(scaleProfile(profile, 0.1)).toBe(profile)
    })

    it('refuses a scale that is not a number above 0', () => {
        expect(() => scaleProfile({}, 0)).toThrow(/above 0/)
    })
})
