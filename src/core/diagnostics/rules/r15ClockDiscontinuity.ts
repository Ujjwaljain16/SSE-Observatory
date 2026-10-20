import type { Rule } from '../rule'
import { ev, fmtMs } from './util'

/**
 * R15 clock.discontinuity: an internal suppression marker. When the host reports that the clock jumped (a laptop
 * slept, a tab was frozen), the model restarts every silence measurement at the jump, so the time asleep is never
 * mistaken for a stall. This rule only records that it happened, so a missing stall finding can be explained.
 */
export const clockDiscontinuity: Rule = {
    id: 'clock.discontinuity',
    version: 1,
    title: 'Clock discontinuity',
    requires: [],
    create() {
        let count = 0
        let firstSeenT = 0
        return {
            onObservation(o) {
                if (o.kind !== 'clock.discontinuity') return
                if (count === 0) firstSeenT = o.t
                count++
                const size = o.gapMs !== undefined ? ` of about ${fmtMs(o.gapMs)}` : ''
                return [{
                    key: 'clock.discontinuity',
                    severity: 'info',
                    title: 'Clock jump: silence checks restarted',
                    summary: `The clock jumped${size}; silence measurements restarted at the jump so the gap is not read as a stall.`,
                    facts: [{ text: `A clock discontinuity${size} was reported${o.reason ? ` (${o.reason})` : ''}.`, evidence: [ev(o.seq, o.t, 'clock jump')] }],
                    deductions: [{ statement: 'Likely: the device slept or the tab was suspended.', confidence: 'low', basis: [o.seq], alternatives: ['The system clock was changed.'] }],
                    limits: ['Stall findings are not raised for the time before the jump.'],
                    status: 'open', firstSeenT, lastSeenT: o.t, occurrences: count,
                }]
            },
        }
    },
}
