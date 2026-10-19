/**
 * usePatternDetector.ts
 *
 * Sliding-window pattern and burst detection (see utils/patternEngine.ts for the semantics):
 *
 *   sequence — event types that must arrive consecutively, e.g. ['payment_failed', 'retry_payment', 'retry_payment']
 *   burst    — at least N matching events inside a time window; one alert per burst, re-armed once the rate drops
 *
 * Only new events are examined (found by identity, so it keeps working after the ring buffer is full).
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { EventMessage } from '../types'
import { newEventsSince } from '../utils/eventBuffer'
import { PatternEngine, type PatternAlert, type PatternRule, type SequenceRule, type BurstRule } from '../utils/patternEngine'

export type { PatternAlert, PatternRule, SequenceRule, BurstRule }

const MAX_ALERTS = 200

const DEFAULT_RULES: PatternRule[] = [
    { id: 'builtin-error-burst', kind: 'burst', name: 'Error burst (5 in 10s)', eventType: 'error', count: 5, windowMs: 10_000, enabled: true },
    { id: 'builtin-retry-storm', kind: 'burst', name: 'Retry storm (3 in 5s)', eventType: 'retry', count: 3, windowMs: 5_000, enabled: true },
    { id: 'builtin-alert-burst', kind: 'burst', name: 'Alert burst (10 in 2s)', eventType: 'alert', count: 10, windowMs: 2_000, enabled: true },
]

let ruleCounter = 0

export function usePatternDetector(events: EventMessage[]) {
    const [rules, setRules] = useState<PatternRule[]>(DEFAULT_RULES)
    const [alerts, setAlerts] = useState<PatternAlert[]>([])
    const engine = useRef(new PatternEngine())
    const lastIdRef = useRef<string | null>(null)

    useEffect(() => {
        if (events.length === 0) {
            engine.current.reset()
            lastIdRef.current = null
            return
        }
        // Buffer replaced (reconnect, history load): previous rule state no longer describes it.
        if (lastIdRef.current !== null && !events.some((e) => e.id === lastIdRef.current)) engine.current.reset()

        const fresh = newEventsSince(events, lastIdRef.current)
        lastIdRef.current = events[0].id
        const raised = engine.current.process(fresh, rules, () => newEventsSince(events, null))
        if (raised.length > 0) setAlerts((prev) => [...raised.reverse(), ...prev].slice(0, MAX_ALERTS))
    }, [events, rules])

    const addRule = useCallback((rule: Omit<PatternRule, 'id'>) => {
        const id = `rule-${Date.now()}-${ruleCounter++}`
        setRules((prev) => [...prev, { ...rule, id } as PatternRule])
    }, [])

    const updateRule = useCallback((id: string, updates: Partial<PatternRule>) => {
        setRules((prev) => prev.map((r) => (r.id === id ? ({ ...r, ...updates } as PatternRule) : r)))
    }, [])

    const removeRule = useCallback((id: string) => {
        setRules((prev) => prev.filter((r) => r.id !== id))
    }, [])

    const toggleRule = useCallback((id: string) => {
        setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)))
    }, [])

    const dismissAlert = useCallback((alertId: string) => {
        setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, dismissed: true } : a)))
    }, [])

    const clearAlerts = useCallback(() => setAlerts([]), [])

    const activeAlerts = useMemo(() => alerts.filter((a) => !a.dismissed), [alerts])

    return { rules, alerts, activeAlerts, addRule, updateRule, removeRule, toggleRule, dismissAlert, clearAlerts }
}
