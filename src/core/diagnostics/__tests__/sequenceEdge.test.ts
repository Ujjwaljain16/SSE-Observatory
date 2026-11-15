// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { analyze } from '../engine'
import { defaultRules } from '../rules'
import { sequenceIntegrity } from '../rules/r09SequenceIntegrity'
import { resumeLastEventId } from '../rules/r08ResumeLastEventId'
import { PayloadProbe } from '../../observe/payloadProbe'
import { healthyStart } from '../../testing/captureBuilder'
import type { StreamProfile } from '../thresholds'
import type { EngineInput } from '../streamModel'

// Campaign C7: the ids a real server sends that a tidy test does not. The contract (plan, and the rule's own header): only a DECLARED sequence
// lets a gap, a repeat or a regression be called a problem; an id that is not a number the Doctor can read is "unreadable" (a note about the
// declaration), never loss; and nothing is ever concluded from ids when no contract was declared. These run through the real payload probe, so
// what counts as a number is what the recorder decides (1-15 ASCII digits), not what a test helper decides.

const RULES = [...defaultRules, sequenceIntegrity, resumeLastEventId]
const DECLARED: StreamProfile = { sequence: { useSseId: true, policy: 'consecutive' } }
const range = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => String(from + i))
const RECONNECT = '|'

/** Events with these SSE ids (RECONNECT between two drops the connection and opens a new one). The payload is a function of the id. */
function keysFor(ids: string[], profile: StreamProfile = DECLARED): string[] {
    const probe = new PayloadProbe({ sequence: { useSseId: true } }, 1)
    const b = healthyStart()
    for (const id of ids) {
        if (id === RECONNECT) { b.silence(10).phase('reconnecting').reconnect({ lastEventIdSent: 'x' }).connect({ sentLastEventId: 'x' }).response(); continue }
        b.silence(100).frame('tick', id, 10 + (id.length % 7))
    }
    const records = (b.build() as EngineInput[]).map((r) => (r.kind === 'event' ? { ...r, ...probe.probe({ data: `payload-of-${r.sseId}`, id: r.sseId, event: r.event }) } : r))
    return analyze(records as EngineInput[], { rules: RULES, profile, endT: b.now + 5000 }).findings.filter((f) => /^(seq|resume)\./.test(f.key)).map((f) => f.key).sort()
}

const LOSS = ['seq.integrity:gap', 'seq.integrity:duplicate', 'seq.integrity:regression', 'seq.integrity:conflict']

describe('ids that are not numbers: never a conclusion about loss', () => {
    const NOT_NUMBERS: Array<[string, string[]]> = [
        ['opaque ids', ['a1b2', 'c3d4', 'e5f6', 'g7h8', 'i9j0']],
        ['prefixed numbers that skip', ['evt_104', 'evt_111', 'evt_112', 'evt_120']],
        ['fullwidth digits', ['１', '２', '４', '５']],
        ['Arabic-Indic digits', ['١', '٢', '٤']],
        ['numbers beyond 15 digits (a double cannot tell them apart)', ['9007199254740993', '9007199254740994', '9007199254740995']],
        ['decimals', ['1.5', '2.5', '3.5']],
        ['exponent notation', ['1e3', '1e3', '1e3']],
        ['numbers and words mixed', ['1', 'x', '2', 'y', '3', 'z', '4']],
        ['no id at all on the events', ['', '', '']],
    ]
    for (const [name, ids] of NOT_NUMBERS) {
        it(`${name}: reported as unreadable under a declared contract, never as a gap, duplicate, regression or conflict`, () => {
            const keys = keysFor(ids)
            expect(keys.filter((k) => LOSS.includes(k)), keys.join(', ')).toEqual([])
            expect(keys).toContain('seq.integrity:unreadable')
        })
        it(`${name}: nothing at all about sequence when no contract was declared`, () => {
            expect(keysFor(ids, {}).filter((k) => k.startsWith('seq.'))).toEqual([])
        })
    }
})

describe('ids that are numbers the way the recorder reads them', () => {
    it('leading zeros are the same number: 001, 002, 003 is continuous, and 001, 002, 004 has a gap', () => {
        expect(keysFor(['001', '002', '003', '004'])).toEqual([])
        expect(keysFor(['001', '002', '004', ...range(100, 160)])).toContain('seq.integrity:gap')
    })

    it('zero is a number: 0, 1, 2, 3 is continuous, and 0, 2 has a gap', () => {
        expect(keysFor(['0', '1', '2', '3'])).toEqual([])
        expect(keysFor(['0', '2', ...range(100, 160)])).toContain('seq.integrity:gap')
    })

    it('the longest readable number (15 digits) counts like any other; the next one (16 digits) is unreadable, and one is not enough to say so', () => {
        expect(keysFor(['100000000000001', '100000000000002', '100000000000003'])).toEqual([])
        expect(keysFor(['999999999999998', '999999999999999', '1000000000000000', '1000000000000001'])).toEqual([])
    })
})

describe('a server that restarts its numbering', () => {
    it('says so, explicitly, and does not call it loss: the stream started over, which a resume was meant to prevent', () => {
        const keys = keysFor([...range(1, 20), RECONNECT, ...range(1, 20)])
        expect(keys).toContain('resume.last-event-id:ignored')
        expect(keys).toContain('seq.integrity:replay')
        expect(keys.filter((k) => k === 'seq.integrity:gap')).toEqual([])
    })

    it('is still reported when the stream promised exactly-once delivery (the severity of that case is pinned in sequenceRules.test.ts)', () => {
        const probe = keysFor([...range(1, 20), RECONNECT, ...range(1, 20)], { ...DECLARED, delivery: 'exactly_once' })
        expect(probe).toContain('seq.integrity:replay')
    })

    it('an honest resume a little before the cursor is replay, not loss and not a restart', () => {
        const keys = keysFor([...range(1, 20), RECONNECT, ...range(18, 30)])
        expect(keys).not.toContain('seq.integrity:gap')
        expect(keys).not.toContain('resume.last-event-id:ignored')
    })

    it('is not judged at all without a declared contract, except that the server ignored the cursor (a fact about the request)', () => {
        const keys = keysFor([...range(1, 20), RECONNECT, ...range(1, 20)], {})
        expect(keys.filter((k) => k.startsWith('seq.'))).toEqual([])
    })
})
