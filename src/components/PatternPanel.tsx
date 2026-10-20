// ui for defining sequence and burst rules with real-time alert visualization

import { useState } from 'react'
import type { Theme } from '../types'
import type { PatternRule, PatternAlert, NewPatternRule } from '../hooks/usePatternDetector'
import {
    AlertTriangle, Plus, X, Zap, Layers, ChevronDown, ChevronRight,
    ToggleLeft, ToggleRight, Bell, BellOff
} from 'lucide-react'

interface PatternPanelProps {
    theme: Theme
    rules: PatternRule[]
    activeAlerts: PatternAlert[]
    onAddRule: (rule: NewPatternRule) => void
    onRemoveRule: (id: string) => void
    onToggleRule: (id: string) => void
    onDismissAlert: (id: string) => void
    onClearAlerts: () => void
}



/** The add-rule form. Numbers stay strings while typing and are validated on submit. */
interface Draft {
    name: string
    pattern: string[]
    eventType: string
    count: string
    windowMs: string
}

const blankSequence: Draft = { name: '', pattern: ['error', 'retry'], eventType: 'error', count: '5', windowMs: '10000' }
const blankBurst: Draft = { name: '', pattern: ['error', 'retry'], eventType: 'error', count: '5', windowMs: '10000' }



export function PatternPanel({
    theme,
    rules,
    activeAlerts,
    onAddRule,
    onRemoveRule,
    onToggleRule,
    onDismissAlert,
    onClearAlerts,
}: PatternPanelProps) {
    const isDark = theme === 'dark'
    const [addKind, setAddKind] = useState<'sequence' | 'burst' | null>(null)
    const [draft, setDraft] = useState<Draft>({ ...blankBurst })
    const [expandedAlert, setExpandedAlert] = useState<string | null>(null)

    const bg = isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'
    const text = isDark ? 'text-white' : 'text-slate-900'
    const muted = isDark ? 'text-slate-400' : 'text-slate-500'
    const inputCls = `w-full px-3 py-1.5 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 ${isDark ? 'bg-slate-700 border-slate-600 text-white' : 'bg-slate-50 border-slate-300 text-slate-900'
        }`

    const openAdd = (kind: 'sequence' | 'burst') => {
        setAddKind(kind)
        setDraft(kind === 'sequence' ? { ...blankSequence } : { ...blankBurst })
    }

    const submitDraft = () => {
        if (!draft.name.trim()) return
        if (addKind === 'sequence') {
            const pattern = draft.pattern.map((p) => p.trim()).filter(Boolean)
            if (pattern.length === 0) return
            onAddRule({ kind: 'sequence', name: draft.name.trim(), pattern, enabled: true })
        } else {
            const count = Math.max(1, parseInt(draft.count, 10) || 5)
            const windowMs = Math.max(1, parseInt(draft.windowMs, 10) || 10_000)
            onAddRule({ kind: 'burst', name: draft.name.trim(), count, windowMs, eventType: draft.eventType.trim() || '*', enabled: true })
        }
        setAddKind(null)
    }

    return (
        <div className="space-y-4">

            {activeAlerts.length > 0 && (
                <div className={`rounded-xl border ${bg} p-4`}>
                    <div className="flex items-center justify-between mb-3">
                        <h3 className={`font-bold flex items-center gap-2 ${text}`}>
                            <AlertTriangle className="w-4 h-4 text-amber-400" />
                            Detected Patterns
                            <span className="px-1.5 py-0.5 rounded-full text-xs bg-amber-500 text-white font-bold">
                                {activeAlerts.length}
                            </span>
                        </h3>
                        <button
                            onClick={onClearAlerts}
                            className={`text-xs px-2 py-1 rounded transition-colors ${isDark ? 'hover:bg-slate-700 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
                                }`}
                        >
                            Clear all
                        </button>
                    </div>

                    <div className="space-y-2">
                        {activeAlerts.slice(0, 20).map(alert => (
                            <div
                                key={alert.id}
                                className={`rounded-lg border overflow-hidden ${isDark ? 'border-amber-800/50 bg-amber-950/30' : 'border-amber-200 bg-amber-50'
                                    }`}
                            >
                                <div className="flex items-center justify-between px-3 py-2">
                                    <div className="flex items-center gap-2">
                                        {alert.kind === 'burst'
                                            ? <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                            : <Layers className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                                        }
                                        <span className={`text-sm font-medium ${text}`}>{alert.ruleName}</span>
                                        <span className={`text-xs ${muted}`}>·</span>
                                        <span className={`text-xs font-mono ${muted}`}>
                                            {alert.eventCount} events
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <button
                                            onClick={() => setExpandedAlert(expandedAlert === alert.id ? null : alert.id)}
                                            aria-label={expandedAlert === alert.id ? 'Hide matching events' : 'Show matching events'}
                                            aria-expanded={expandedAlert === alert.id}
                                            className={`p-1 rounded transition-colors ${isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-200'}`}
                                        >
                                            {expandedAlert === alert.id
                                                ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                                                : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                                            }
                                        </button>
                                        <button
                                            onClick={() => onDismissAlert(alert.id)}
                                            aria-label="Dismiss alert"
                                            className={`p-1 rounded transition-colors ${isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-200'}`}
                                        >
                                            <X className="w-3.5 h-3.5 text-slate-400" />
                                        </button>
                                    </div>
                                </div>

                                {expandedAlert === alert.id && (
                                    <div className={`border-t px-3 py-2 space-y-1 ${isDark ? 'border-amber-800/50' : 'border-amber-200'
                                        }`}>
                                        {alert.events.slice(0, 8).map(e => (
                                            <div key={e.id} className={`text-xs font-mono flex gap-2 ${muted}`}>
                                                <span className="opacity-60">{e.timestamp}</span>
                                                <span className={`font-semibold ${text}`}>{e.parsedType ?? e.type}</span>
                                                <span className="truncate opacity-60">{e.id}</span>
                                            </div>
                                        ))}
                                        {alert.eventCount > 8 && (
                                            <div className={`text-xs ${muted}`}>
                                                +{alert.eventCount - 8} more events
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}


            <div className={`rounded-xl border ${bg} p-4`}>
                <div className="flex items-center justify-between mb-3">
                    <h3 className={`font-bold flex items-center gap-2 ${text}`}>
                        <Bell className="w-4 h-4 text-indigo-400" />
                        Pattern Rules
                    </h3>
                    <div className="flex gap-2">
                        <button
                            onClick={() => openAdd('sequence')}
                            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
                        >
                            <Plus className="w-3.5 h-3.5" /> Sequence
                        </button>
                        <button
                            onClick={() => openAdd('burst')}
                            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
                        >
                            <Plus className="w-3.5 h-3.5" /> Burst
                        </button>
                    </div>
                </div>


                {addKind && (
                    <div className={`mb-3 p-3 rounded-lg border space-y-2 ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-slate-50 border-slate-200'
                        }`}>
                        <div className={`text-xs font-bold uppercase tracking-wider mb-2 ${addKind === 'sequence' ? 'text-indigo-400' : 'text-amber-400'
                            }`}>
                            New {addKind} rule
                        </div>
                        <input
                            className={inputCls}
                            placeholder="Rule name (e.g. Payment retry storm)"
                            value={draft.name}
                            onChange={e => setDraft({ ...draft, name: e.target.value })}
                        />

                        {addKind === 'sequence' && (
                            <input
                                className={inputCls}
                                placeholder="Event types, comma-separated (e.g. payment_failed,retry_payment,retry_payment)"
                                value={draft.pattern.join(',')}
                                onChange={e => setDraft({ ...draft, pattern: e.target.value.split(',').map((s: string) => s.trim()) })}
                            />
                        )}

                        {addKind === 'burst' && (
                            <div className="grid grid-cols-3 gap-2">
                                <input
                                    className={inputCls}
                                    placeholder="Event type (* = any)"
                                    value={draft.eventType}
                                    onChange={e => setDraft({ ...draft, eventType: e.target.value })}
                                />
                                <input
                                    type="number"
                                    className={inputCls}
                                    placeholder="Count"
                                    value={draft.count}
                                    onChange={e => setDraft({ ...draft, count: e.target.value })}
                                />
                                <input
                                    type="number"
                                    className={inputCls}
                                    placeholder="Window (ms)"
                                    value={draft.windowMs}
                                    onChange={e => setDraft({ ...draft, windowMs: e.target.value })}
                                />
                            </div>
                        )}

                        <div className="flex gap-2 justify-end">
                            <button
                                onClick={() => setAddKind(null)}
                                className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${isDark ? 'bg-slate-600 text-slate-300 hover:bg-slate-500' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                                    }`}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={submitDraft}
                                disabled={!draft.name.trim() || (addKind === 'sequence' && !draft.pattern.some((p) => p.trim()))}
                                className="px-3 py-1.5 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white transition-colors"
                            >
                                Add Rule
                            </button>
                        </div>
                    </div>
                )}

                {rules.length === 0 && !addKind && (
                    <div className={`text-center py-6 text-sm ${muted}`}>
                        No rules defined. Add a sequence or burst rule above.
                    </div>
                )}

                <div className="space-y-2">
                    {rules.map(rule => (
                        <div
                            key={rule.id}
                            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors ${rule.enabled
                                ? isDark ? 'bg-slate-700/50 border-slate-600' : 'bg-slate-50 border-slate-200'
                                : isDark ? 'opacity-50 bg-slate-800 border-slate-700' : 'opacity-50 bg-white border-slate-200'
                                }`}
                        >

                            <span className={`px-2 py-0.5 rounded-full text-xs font-bold shrink-0 ${rule.kind === 'sequence'
                                ? 'bg-indigo-900/60 text-indigo-300'
                                : 'bg-amber-900/60 text-amber-300'
                                }`}>
                                {rule.kind === 'sequence' ? 'SEQ' : 'BURST'}
                            </span>


                            <div className="flex-1 min-w-0">
                                <div className={`text-sm font-medium truncate ${text}`}>{rule.name}</div>
                                <div className={`text-xs font-mono truncate ${muted}`}>
                                    {rule.kind === 'sequence'
                                        ? rule.pattern.join(' → ')
                                        : `${rule.eventType} ≥ ${rule.count}× / ${rule.windowMs}ms`
                                    }
                                </div>
                            </div>


                            {rule.id.startsWith('builtin-') && (
                                <span className={`text-xs shrink-0 ${muted}`}>built-in</span>
                            )}


                            <button
                                role="switch"
                                aria-checked={rule.enabled}
                                aria-label={`${rule.name} enabled`}
                                onClick={() => onToggleRule(rule.id)}
                                className="shrink-0 transition-colors"
                            >
                                {rule.enabled
                                    ? <ToggleRight className="w-5 h-5 text-indigo-400" />
                                    : <ToggleLeft className={`w-5 h-5 ${muted}`} />
                                }
                            </button>


                            {!rule.id.startsWith('builtin-') && (
                                <button
                                    onClick={() => onRemoveRule(rule.id)}
                                    aria-label={`Remove rule ${rule.name}`}
                                    className={`shrink-0 p-1 rounded transition-colors ${isDark ? 'hover:bg-slate-600 text-slate-400' : 'hover:bg-slate-200 text-slate-500'
                                        }`}
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {activeAlerts.length === 0 && rules.some(r => r.enabled) && (
                <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${muted}`}>
                    <BellOff className="w-4 h-4" /> No patterns detected yet. Events will be scanned in real time.
                </div>
            )}
        </div>
    )
}
