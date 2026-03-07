// ui for rendering the causal event chain of a given trace

import { useMemo } from 'react'
import type { Theme } from '../types'
import type { TraceEntry } from '../hooks/useCorrelationTracker'
import { GitBranch, X, Clock, Layers } from 'lucide-react'

interface TracePanelProps {
    theme: Theme
    trace: TraceEntry | null
    onClose: () => void
}

function relativeMs(base: number, t: number): string {
    const delta = t - base
    if (delta < 1000) return `+${delta}ms`
    return `+${(delta / 1000).toFixed(2)}s`
}

export function TracePanel({ theme, trace, onClose }: TracePanelProps) {
    const isDark = theme === 'dark'

    const duration = useMemo(() => {
        if (!trace || trace.events.length < 2) return 0
        return trace.lastSeen - trace.firstSeen
    }, [trace])

    if (!trace) return null

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

            <div
                className={`relative w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl shadow-2xl border overflow-hidden ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
                    }`}
                onClick={e => e.stopPropagation()}
            >

                <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-slate-700' : 'border-slate-200'
                    }`}>
                    <div className="flex items-center gap-3">
                        <GitBranch className="w-5 h-5 text-indigo-400" />
                        <div>
                            <div className={`text-sm font-bold font-mono ${isDark ? 'text-white' : 'text-slate-900'}`}>
                                {trace.id}
                            </div>
                            <div className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                via <span className="font-mono text-indigo-400">{trace.field}</span>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className={`flex items-center gap-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                            <Clock className="w-3.5 h-3.5" />
                            {duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(2)}s`} total
                        </div>
                        <div className={`flex items-center gap-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                            <Layers className="w-3.5 h-3.5" />
                            {trace.events.length} events
                        </div>
                        <button
                            onClick={onClose}
                            className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-slate-700 text-slate-400 hover:text-white' : 'hover:bg-slate-100 text-slate-500 hover:text-slate-900'
                                }`}
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>


                <div className={`px-5 py-3 flex flex-wrap gap-2 border-b ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
                    {trace.services.map(svc => (
                        <span
                            key={svc}
                            className={`px-2.5 py-1 rounded-full text-xs font-medium ${isDark ? 'bg-indigo-900/50 text-indigo-300' : 'bg-indigo-50 text-indigo-700'
                                }`}
                        >
                            {svc}
                        </span>
                    ))}
                </div>


                <div className="overflow-y-auto flex-1 px-5 py-4 space-y-1">
                    {trace.events.map((event, idx) => {
                        const arrival = event.arrivalTime ?? trace.firstSeen
                        const isFirst = idx === 0
                        return (
                            <div key={event.id} className="flex gap-4 items-start group">

                                <div className="flex flex-col items-center w-5 shrink-0 mt-1">
                                    <div className={`w-2.5 h-2.5 rounded-full border-2 shrink-0 ${isFirst
                                        ? 'border-indigo-500 bg-indigo-500'
                                        : isDark ? 'border-slate-600 bg-slate-800' : 'border-slate-300 bg-white'
                                        }`} />
                                    {idx < trace.events.length - 1 && (
                                        <div className={`w-px flex-1 min-h-4 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />
                                    )}
                                </div>


                                <div className={`flex-1 pb-3 rounded-lg px-3 py-2 text-sm ${isDark ? 'bg-slate-800 border border-slate-700' : 'bg-slate-50 border border-slate-200'
                                    }`}>
                                    <div className="flex items-center justify-between gap-2">
                                        <span className={`font-semibold font-mono truncate ${isDark ? 'text-white' : 'text-slate-900'
                                            }`}>
                                            {event.parsedType ?? event.type}
                                        </span>
                                        <span className={`font-mono text-xs shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'
                                            }`}>
                                            {isFirst ? event.timestamp : relativeMs(trace.firstSeen, arrival)}
                                        </span>
                                    </div>

                                    {event.data && (
                                        <pre className={`mt-1.5 text-xs overflow-x-auto rounded p-1.5 ${isDark ? 'bg-slate-900 text-slate-400' : 'bg-white text-slate-500'
                                            }`}>
                                            {typeof event.data === 'string'
                                                ? event.data.slice(0, 200)
                                                : JSON.stringify(event.data, null, 2).slice(0, 200)
                                            }{(JSON.stringify(event.data).length > 200) && '…'}
                                        </pre>
                                    )}
                                </div>
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
