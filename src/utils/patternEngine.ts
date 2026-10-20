import type { EventMessage } from '../types'

export interface SequenceRule {
    id: string
    kind: 'sequence'
    name: string
    pattern: string[]   // ordered event types; "*" matches anything, "prefix*" matches a prefix
    enabled: boolean
}

export interface BurstRule {
    id: string
    kind: 'burst'
    name: string
    eventType: string   // "*" matches any type
    count: number       // threshold
    windowMs: number    // time window
    enabled: boolean
}

export type PatternRule = SequenceRule | BurstRule

export interface PatternAlert {
    id: string
    ruleId: string
    ruleName: string
    kind: PatternRule['kind']
    detectedAt: number
    /** The newest matching events (capped); see eventCount for the true total. */
    events: EventMessage[]
    eventCount: number
    dismissed: boolean
}

const MAX_ALERT_EVENTS = 50

/** A type pattern matches either the SSE event name or the `type` field of a JSON payload. */
export function typeMatches(event: Pick<EventMessage, 'type' | 'parsedType'>, pattern: string): boolean {
    const test = (t: string | undefined) => {
        if (t === undefined) return false
        if (pattern === '*') return true
        if (pattern.endsWith('*')) return t.startsWith(pattern.slice(0, -1))
        return t === pattern
    }
    return test(event.parsedType) || test(event.type)
}

interface BurstState { kind: 'burst'; window: EventMessage[]; armed: boolean }
interface SequenceState { kind: 'sequence'; recent: EventMessage[] }
type RuleState = BurstState | SequenceState

let alertCounter = 0
const newAlertId = () => `alert-${Date.now()}-${alertCounter++}`

/**
 * Incremental pattern detection. Each event is looked at once per rule (O(1) amortised), no matter how
 * large the buffer is, and a burst raises ONE alert per episode: it re-arms only after the rate drops
 * back below the threshold.
 */
export class PatternEngine {
    private states = new Map<string, { signature: string; state: RuleState }>()

    reset() { this.states.clear() }

    /** Forget a rule (removed or disabled). */
    forget(ruleId: string) { this.states.delete(ruleId) }

    /**
     * Feed NEW events in chronological order (oldest first). Rules that are new, edited or just enabled have no
     * state yet, so they are fed the whole buffer (`backlog`, also oldest first) instead. Returns the alerts raised.
     */
    process(events: readonly EventMessage[], rules: readonly PatternRule[], backlog: () => readonly EventMessage[] = () => events): PatternAlert[] {
        const alerts: PatternAlert[] = []
        const active = rules.filter((r) => r.enabled)
        for (const stale of [...this.states.keys()]) {
            if (!active.some((r) => r.id === stale)) this.states.delete(stale)
        }

        for (const rule of active) {
            const signature = JSON.stringify(rule)
            let entry = this.states.get(rule.id)
            let feed = events
            if (!entry || entry.signature !== signature) {
                feed = backlog()
                entry = { signature, state: rule.kind === 'burst' ? { kind: 'burst', window: [], armed: true } : { kind: 'sequence', recent: [] } }
                this.states.set(rule.id, entry)
            }
            for (const event of feed) {
                const alert = rule.kind === 'burst'
                    ? this.stepBurst(entry.state as BurstState, rule, event)
                    : this.stepSequence(entry.state as SequenceState, rule, event)
                if (alert) alerts.push(alert)
            }
        }
        return alerts
    }

    private stepBurst(state: BurstState, rule: BurstRule, event: EventMessage): PatternAlert | null {
        if (!typeMatches(event, rule.eventType)) return null
        const now = event.arrivalTime ?? 0
        state.window.push(event)
        const cutoff = now - rule.windowMs
        let drop = 0
        while (drop < state.window.length && (state.window[drop].arrivalTime ?? 0) < cutoff) drop++
        if (drop > 0) state.window.splice(0, drop)

        if (state.window.length < rule.count) { state.armed = true; return null }
        if (!state.armed) return null
        state.armed = false
        return {
            id: newAlertId(), ruleId: rule.id, ruleName: rule.name, kind: 'burst', detectedAt: Date.now(),
            events: state.window.slice(-MAX_ALERT_EVENTS), eventCount: state.window.length, dismissed: false,
        }
    }

    private stepSequence(state: SequenceState, rule: SequenceRule, event: EventMessage): PatternAlert | null {
        const n = rule.pattern.length
        if (n === 0) return null
        state.recent.push(event)
        if (state.recent.length > n) state.recent.shift()
        if (state.recent.length < n) return null
        if (!state.recent.every((e, i) => typeMatches(e, rule.pattern[i]))) return null
        const matched = state.recent
        state.recent = [] // matches don't overlap
        return {
            id: newAlertId(), ruleId: rule.id, ruleName: rule.name, kind: 'sequence', detectedAt: Date.now(),
            events: matched, eventCount: matched.length, dismissed: false,
        }
    }
}
