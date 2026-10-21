import { useState } from 'react'
import { Theme } from '../types'
import { Terminal, Lightbulb, X, Zap, AlertTriangle, Check, Save } from 'lucide-react'
import { getSavedQueries, removeQuery, saveQuery, type SavedQuery } from '../utils/savedQueries'

interface QueryInputProps {
    theme: Theme
    query: string
    onQueryChange: (query: string) => void
    error: string | null
}

export const QueryInput = ({ theme, query, onQueryChange, error }: QueryInputProps) => {
    const [showExamples, setShowExamples] = useState(false)
    const [saved, setSaved] = useState<SavedQuery[]>(getSavedQueries)
    const [saveName, setSaveName] = useState('')
    const isDark = theme === 'dark'

    const examples = [
        { query: 'type == "message"', label: 'Filter by type' },
        { query: 'data.value > 50', label: 'Numeric comparison' },
        { query: 'type != "ping" AND data.status == "active"', label: 'AND logic' },
        { query: 'data.userId contains "user-"', label: 'Contains text' },
        { query: '(type == "error" OR data.level >= 3)', label: 'OR with parentheses' }
    ]

    return (
        <div className={`
            mt-6 p-5 rounded-2xl border animate-slide-up
            backdrop-blur-xl transition-all duration-300
            ${isDark
                ? 'bg-slate-900/70 border-slate-700/50 shadow-xl shadow-black/20'
                : 'bg-white/80 border-slate-200/70 shadow-xl shadow-slate-300/20'
            }
        `}>

            <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-3">
                    <div className={`
                        w-9 h-9 rounded-xl flex items-center justify-center
                        bg-gradient-to-br from-sky-500 to-blue-500 shadow-lg shadow-blue-500/30
                    `}>
                        <Terminal className="w-5 h-5 text-white" />
                    </div>
                    <div>
                        <h3 className={`text-base font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                            Query Engine
                        </h3>
                        <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                            Advanced filtering with DSL syntax
                        </p>
                    </div>
                </div>
                <button
                    onClick={() => setShowExamples(!showExamples)}
                    className={`
                        text-xs px-3 py-1.5 rounded-lg font-semibold transition-all duration-300
                        flex items-center gap-1.5 hover:scale-105
                        ${showExamples
                            ? 'bg-gradient-to-r from-sky-500 to-blue-500 text-white shadow-lg shadow-blue-500/30'
                            : isDark
                                ? 'bg-slate-700/70 hover:bg-slate-600 text-slate-300 border border-slate-600/50'
                                : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'
                        }
                    `}
                >
                    <span className="flex items-center gap-1.5">
                        {showExamples ? (
                            <X className="w-3 h-3" />
                        ) : (
                            <Lightbulb className="w-3 h-3" />
                        )}
                        <span>{showExamples ? 'Hide' : 'Examples'}</span>
                    </span>
                </button>
            </div>


            {showExamples && (
                <div className={`
                    mb-4 p-4 rounded-xl border animate-scale-in
                    ${isDark
                        ? 'bg-slate-800/50 border-slate-700/50'
                        : 'bg-slate-50 border-slate-200'
                    }
                `}>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {examples.map((ex, i) => (
                            <button
                                key={i}
                                onClick={() => {
                                    onQueryChange(ex.query)
                                    setShowExamples(false)
                                }}
                                className={`
                                    text-left p-3 rounded-xl border transition-all duration-300
                                    hover:scale-[1.02] group
                                    ${isDark
                                        ? 'bg-slate-700/50 border-slate-600/50 hover:border-sky-500/50 hover:bg-slate-700'
                                        : 'bg-white border-slate-200 hover:border-sky-300 hover:shadow-md'
                                    }
                                `}
                            >
                                <code className={`
                                    text-xs font-mono block mb-1 truncate
                                    ${isDark ? 'text-sky-300' : 'text-blue-600'}
                                `}>
                                    {ex.query}
                                </code>
                                <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                                    {ex.label}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}


            <div className="relative">
                <div className="absolute left-4 top-1/2 -translate-y-1/2 opacity-60">
                    <Zap className="w-5 h-5" />
                </div>
                <input
                    type="text"
                    value={query}
                    onChange={(e) => onQueryChange(e.target.value)}
                    placeholder='type == "message" AND data.value > 50'
                    className={`
                        w-full pl-12 pr-4 py-4 rounded-xl border-2 font-mono text-sm
                        focus:outline-none transition-all duration-300
                        ${error
                            ? 'border-red-500 focus:border-red-500 focus:ring-2 focus:ring-red-500/20 bg-red-500/5'
                            : isDark
                                ? 'bg-slate-800/80 border-slate-600/50 text-white placeholder-slate-500 focus:border-sky-500 focus:bg-slate-800'
                                : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:border-sky-500 focus:bg-white'
                        }
                    `}
                />


                {query && !error && (
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 text-emerald-400 animate-pulse">
                        <Check className="w-5 h-5" />
                    </div>
                )}
            </div>


            <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="saved-queries">
                <label className="sr-only" htmlFor="saved-query-name">Name for this filter</label>
                <input
                    id="saved-query-name"
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    placeholder="name (optional)"
                    className={`px-2 py-1 rounded-lg border text-xs w-40 ${isDark ? 'bg-slate-800 border-slate-600 text-white placeholder-slate-400' : 'bg-white border-slate-300 text-slate-900 placeholder-slate-500'}`}
                />
                <button
                    type="button"
                    disabled={!query.trim() || Boolean(error)}
                    onClick={() => { setSaved(saveQuery(saveName, query)); setSaveName('') }}
                    data-testid="save-query"
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 ${isDark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`}
                >
                    <Save className="w-3 h-3" aria-hidden="true" /> Save this filter
                </button>
                {saved.length > 0 && (
                    <ul className="flex flex-wrap gap-2" aria-label="Saved filters">
                        {saved.map((q) => (
                            <li key={q.name} className={`flex items-center rounded-lg border text-xs ${isDark ? 'border-slate-600 bg-slate-800' : 'border-slate-300 bg-white'}`}>
                                <button type="button" onClick={() => onQueryChange(q.query)} title={q.query} className={`px-2 py-1 font-mono ${isDark ? 'text-sky-300' : 'text-blue-700'}`}>{q.name}</button>
                                <button type="button" aria-label={`Remove saved filter ${q.name}`} onClick={() => setSaved(removeQuery(q.name))} className={`px-1.5 py-1 ${isDark ? 'text-slate-300 hover:text-white' : 'text-slate-700 hover:text-slate-900'}`}><X className="w-3 h-3" aria-hidden="true" /></button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {error && (
                <div className={`
                    mt-3 p-3 rounded-xl border flex items-start gap-2 animate-scale-in
                    ${isDark
                        ? 'bg-red-900/20 border-red-500/30 text-red-300'
                        : 'bg-red-50 border-red-300 text-red-600'
                    }
                `}>
                    <AlertTriangle className="w-5 h-5 shrink-0" />
                    <div>
                        <span className="text-xs font-semibold">Syntax Error</span>
                        <p className="text-xs font-mono mt-0.5">{error}</p>
                    </div>
                </div>
            )}


            <div className={`
                mt-3 flex flex-wrap gap-2 items-center text-xs
                ${isDark ? 'text-slate-400' : 'text-slate-600'}
            `}>
                <span>Operators:</span>
                {['==', '!=', '>', '<', '>=', '<=', 'AND', 'OR', 'contains', 'matches'].map(op => (
                    <code
                        key={op}
                        className={`
                            px-1.5 py-0.5 rounded font-mono
                            ${isDark ? 'bg-slate-800/70 text-slate-300' : 'bg-slate-100 text-slate-700'}
                        `}
                    >
                        {op}
                    </code>
                ))}
            </div>
        </div>
    )
}
