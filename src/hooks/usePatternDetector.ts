/**
 * usePatternDetector.ts
 *
 * Sliding-window pattern and burst detection engine.
 *
 * Supports two rule types:
 *
 *   sequence — ordered list of event types that must appear consecutively
 *     { kind: 'sequence', pattern: ['payment_failed', 'retry_payment', 'retry_payment'] }
 *
 *   burst — event type appearing more than N times within a time window
 *     { kind: 'burst', eventType: 'error', count: 5, windowMs: 10_000 }
 *
 * A future DSL parser could emit these same rule shapes from:
 *   type="error" -> type="retry" within 5s
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { EventMessage } from '../types'

// ─── Rule types ───────────────────────────────────────────────────────────────

export interface SequenceRule {
    id: string
    kind: 'sequence'
    name: string
    pattern: string[]   // ordered event types (or '*' wildcard)
    enabled: boolean
}

export interface BurstRule {
    id: string
    kind: 'burst'
    name: string
    eventType: string   // '*' matches any type
    count: number       // threshold
    windowMs: number    // time window
    enabled: boolean
}

export type PatternRule = SequenceRule | BurstRule

// ─── Alert ────────────────────────────────────────────────────────────────────

export interface PatternAlert {
    id: string
    ruleId: string
    ruleName: string
    kind: PatternRule['kind']
    detectedAt: number   // epoch ms
    events: EventMessage[]  // the matching events
    dismissed: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let alertCounter = 0
function uid() { return `alert-${Date.now()}-${alertCounter++}` }

function typeMatches(eventType: string, pattern: string): boolean {
    if (pattern === '*') return true
    // Support simple prefix wildcard: "payment_*"
    if (pattern.endsWith('*')) {
        return eventType.startsWith(pattern.slice(0, -1))
    }
    return eventType === pattern
}

function checkSequence(
    events: EventMessage[],
    rule: SequenceRule,
    alreadyAlerted: Set<string>  // set of event-id-tuples that already fired
): PatternAlert | null {
    const p = rule.pattern
    if (events.length < p.length) return null

    // Slide a window of p.length over the events array (events is newest-first in our ring buffer)
    // We need oldest-first for sequence matching — reverse a slice
    for (let i = events.length - p.length; i >= 0; i--) {
        const window = events.slice(i, i + p.length)
        const matches = window.every((e, j) => typeMatches(e.parsedType ?? e.type, p[j]))
        if (matches) {
            const key = window.map(e => e.id).join(':')
            if (!alreadyAlerted.has(key)) {
                alreadyAlerted.add(key)
                return {
                    id: uid(),
                    ruleId: rule.id,
                    ruleName: rule.name,
                    kind: 'sequence',
                    detectedAt: Date.now(),
                    events: window,
                    dismissed: false,
                }
            }
        }
    }
    return null
}

function checkBurst(
    events: EventMessage[],
    rule: BurstRule,
    alreadyAlerted: Set<string>
): PatternAlert | null {
    if (events.length === 0) return null
    // Use the arrivalTime of the newest event as the reference point.
    // This ensures burst detection works correctly during replay of historical events
    // rather than comparing against the current wall-clock time.
    const newestArrival = Math.max(...events.map(e => e.arrivalTime ?? 0))
    const windowStart = newestArrival - rule.windowMs
    const matching = events.filter(e =>
        (e.arrivalTime ?? 0) >= windowStart &&
        typeMatches(e.parsedType ?? e.type, rule.eventType)
    )
    if (matching.length >= rule.count) {
        const key = `${rule.id}:${matching[0].id}`
        if (!alreadyAlerted.has(key)) {
            alreadyAlerted.add(key)
            return {
                id: uid(),
                ruleId: rule.id,
                ruleName: rule.name,
                kind: 'burst',
                detectedAt: Date.now(),
                events: matching,
                dismissed: false,
            }
        }
    }
    return null
}

// ─── Built-in default rules ───────────────────────────────────────────────────

const DEFAULT_RULES: PatternRule[] = [
    {
        id: 'builtin-error-burst',
        kind: 'burst',
        name: 'Error burst (5 in 10s)',
        eventType: 'error',
        count: 5,
        windowMs: 10_000,
        enabled: true,
    },
    {
        id: 'builtin-retry-storm',
        kind: 'burst',
        name: 'Retry storm (3 in 5s)',
        eventType: 'retry',
        count: 3,
        windowMs: 5_000,
        enabled: true,
    },
    {
        id: 'builtin-alert-burst',
        kind: 'burst',
        name: 'Alert burst (10 in 2s)',
        eventType: 'alert',
        count: 10,
        windowMs: 2_000,
        enabled: true,
    },
]

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePatternDetector(events: EventMessage[]) {
    const [rules, setRules] = useState<PatternRule[]>(DEFAULT_RULES)
    const [alerts, setAlerts] = useState<PatternAlert[]>([])
    const alertedKeysRef = useRef<Map<string, Set<string>>>(new Map())

    // Run detection whenever events or rules change
    useEffect(() => {
        if (events.length === 0) return

        // Events from ring buffer are newest-first; for sequence matching we want oldest-first
        const chronological = [...events].reverse()

        const newAlerts: PatternAlert[] = []

        for (const rule of rules) {
            if (!rule.enabled) continue

            if (!alertedKeysRef.current.has(rule.id)) {
                alertedKeysRef.current.set(rule.id, new Set())
            }
            const seenKeys = alertedKeysRef.current.get(rule.id)!

            let alert: PatternAlert | null = null

            if (rule.kind === 'sequence') {
                alert = checkSequence(chronological, rule, seenKeys)
            } else if (rule.kind === 'burst') {
                alert = checkBurst(events, rule, seenKeys)  // burst uses arrival times, any order
            }

            if (alert) newAlerts.push(alert)
        }

        if (newAlerts.length > 0) {
            setAlerts(prev => [...newAlerts, ...prev].slice(0, 200))  // cap at 200 alerts
        }
    }, [events, rules])

    // ── API ───────────────────────────────────────────────────────────────────

    const addRule = useCallback((rule: Omit<PatternRule, 'id'>) => {
        const id = `rule-${Date.now()}`
        setRules(prev => [...prev, { ...rule, id } as PatternRule])
    }, [])

    const updateRule = useCallback((id: string, updates: Partial<PatternRule>) => {
        setRules(prev => prev.map(r => r.id === id ? { ...r, ...updates } as PatternRule : r))
    }, [])

    const removeRule = useCallback((id: string) => {
        setRules(prev => prev.filter(r => r.id !== id))
        alertedKeysRef.current.delete(id)
    }, [])

    const toggleRule = useCallback((id: string) => {
        setRules(prev => prev.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r))
    }, [])

    const dismissAlert = useCallback((alertId: string) => {
        setAlerts(prev => prev.map(a => a.id === alertId ? { ...a, dismissed: true } : a))
    }, [])

    const clearAlerts = useCallback(() => {
        // Only clears displayed alerts — does NOT reset alertedKeysRef,
        // so already-seen patterns do not immediately re-fire on the next event.
        setAlerts([])
    }, [])

    const activeAlerts = alerts.filter(a => !a.dismissed)

    return {
        rules,
        alerts,
        activeAlerts,
        addRule,
        updateRule,
        removeRule,
        toggleRule,
        dismissAlert,
        clearAlerts,
    }
}
