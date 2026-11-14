// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { analyze } from '../engine'
import type { StreamProfile } from '../thresholds'
import { healthyStart, type CaptureBuilder } from '../../testing/captureBuilder'

// Found by the h05-declared-idle fixture (plan A3): a stream whose profile says "up to 60 s of silence is normal" was told, at the end of a
// healthy run, "No heartbeats seen ... a long quiet period cannot be told apart from a stalled connection" (R10, heartbeat.absent), because that
// note judged the quiet against the 30 s default instead of the limit the stream declared. R05 and R13 both use the declared limit
// (`profile.expected.maxSilenceMs` replaces the 30 s default; thresholds.ts says so). The note is info only, but it is the one finding on a
// stream that is exactly as quiet as it said it would be.

const run = (b: CaptureBuilder, profile?: StreamProfile) => analyze(b.build(), { endT: b.now, ...(profile ? { profile } : {}) })
const keys = (b: CaptureBuilder, profile?: StreamProfile) => run(b, profile).findings.map((f) => f.key)

/** Two events with `quietMs` of nothing between them, and no heartbeat at all. */
const idle = (quietMs: number) => healthyStart().frame().silence(quietMs).frame()

describe('R10 heartbeat.absent and a declared idle', () => {
    it('without a declaration, a 35 s quiet is noted (unchanged: the 30 s default)', () => {
        expect(keys(idle(35_000))).toContain('heartbeat.absent')
    })

    it('a quiet inside the declared longest silence is not noted', () => {
        expect(keys(idle(35_000), { expected: { maxSilenceMs: 60_000 } })).toEqual([])
    })

    it('a quiet beyond the declared longest silence is still noted (and so is the stall), with the declared number as the limit', () => {
        const got = keys(idle(25_000), { expected: { maxSilenceMs: 20_000 } })
        expect(got).toContain('heartbeat.absent')
        expect(got).toContain('stall.silent:bytes')
    })

    it('a declaration lower than the default makes the note appear sooner, the same way it moves the stall limit', () => {
        expect(keys(idle(25_000))).toEqual([]) // the default limit is 30 s
        expect(keys(idle(25_000), { expected: { maxSilenceMs: 20_000 } })).toContain('heartbeat.absent')
    })

    it('other declared times do not move it (only the longest silence does)', () => {
        expect(keys(idle(35_000), { expected: { firstEventMs: 90_000, heartbeatMs: 90_000 } })).toContain('heartbeat.absent')
    })
})
