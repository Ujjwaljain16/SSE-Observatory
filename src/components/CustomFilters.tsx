import { memo, useState } from 'react'
import type { Theme, CustomFilter } from '../types'
import {
    SlidersHorizontal, Plus, Target, Tag,
    RotateCcw, X, Regex, Code
} from 'lucide-react'

interface CustomFiltersProps {
    theme: Theme
    connected: boolean
    customFilters: CustomFilter[]
    newFilterField: string
    eventsLength: number
    filteredEventsLength: number
    onNewFilterFieldChange: (field: string) => void
    onAddCustomFilter: () => string | null
    onRemoveCustomFilter: (field: string) => void
    onToggleFilterValue: (field: string, value: string) => void
    onClearFilterValues: (field: string) => void
    getUniqueValuesForField: (field: string) => string[]
    toggleRegexMode?: (field: string) => void
    setRegexPattern?: (field: string, pattern: string) => void
}

export const CustomFilters = memo(function CustomFilters({
    theme,
    connected,
    customFilters,
    newFilterField,
    eventsLength,
    filteredEventsLength,
    onNewFilterFieldChange,
    onAddCustomFilter,
    onRemoveCustomFilter,
    onToggleFilterValue,
    onClearFilterValues,
    getUniqueValuesForField,
    toggleRegexMode,
    setRegexPattern
}: CustomFiltersProps) {
    const [addError, setAddError] = useState('')
    // Keep the panel visible whenever filters exist or there are events to filter: active filters must never be hidden.
    if (!connected && customFilters.length === 0 && eventsLength === 0) return null

    const isDark = theme === 'dark'

    const handleAddFilter = () => {
        setAddError(onAddCustomFilter() ?? '')
    }

    return (
        <div className={`
            rounded-2xl p-5 mb-6 animate-slide-up
            backdrop-blur-xl border transition-all duration-300
            ${isDark
                ? 'bg-slate-900/70 border-slate-700/50 shadow-xl shadow-black/20'
                : 'bg-white/80 border-slate-200/70 shadow-xl shadow-slate-300/20'
            }
        `}>

            <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                    <div className={`
                        w-10 h-10 rounded-xl flex items-center justify-center
                        bg-gradient-to-br from-cyan-500 to-blue-500 shadow-lg shadow-blue-500/30
                    `}>
                        <SlidersHorizontal className="w-5 h-5 text-white" />
                    </div>
                    <div>
                        <h3 className={`text-base font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                            Field Filters
                        </h3>
                        <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                            Filter by specific field values
                        </p>
                    </div>
                </div>


                <div className={`
                    flex items-center gap-3 px-4 py-2 rounded-xl
                    ${isDark ? 'bg-slate-800/70' : 'bg-slate-100'}
                `}>
                    <div className="text-center">
                        <div className={`text-lg font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                            {eventsLength}
                        </div>
                        <div className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Total</div>
                    </div>
                    {customFilters.some(f => (f.isRegex ? !!f.regexPattern : f.activeValues.size > 0)) && (
                        <>
                            <div className={`w-px h-8 ${isDark ? 'bg-slate-600' : 'bg-slate-300'}`} />
                            <div className="text-center">
                                <div className="text-lg font-bold text-amber-400">
                                    {filteredEventsLength}
                                </div>
                                <div className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Filtered</div>
                            </div>
                        </>
                    )}
                </div>
            </div>


            <div className="flex gap-3 mb-5">
                <div className="relative flex-1">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 opacity-60">
                        <Tag className="w-4 h-4" />
                    </div>
                    <input
                        type="text"
                        value={newFilterField}
                        onChange={(e) => { setAddError(''); onNewFilterFieldChange(e.target.value) }}
                        placeholder="Field path (e.g. type, data.userId, data.status)"
                        onKeyDown={(e) => e.key === 'Enter' && handleAddFilter()}
                        className={`
                            w-full pl-12 pr-4 py-3.5 rounded-xl border-2 text-sm font-medium
                            focus:outline-none transition-all duration-300
                            ${isDark
                                ? 'bg-slate-800/80 border-slate-600/50 text-white placeholder-slate-500 focus:border-cyan-500 focus:bg-slate-800'
                                : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:bg-white'
                            }
                        `}
                    />
                </div>
                <button
                    onClick={handleAddFilter}
                    disabled={!newFilterField.trim()}
                    className={`
                        px-5 py-3.5 rounded-xl font-bold transition-all duration-300
                        flex items-center gap-2 hover:scale-105
                        ${!newFilterField.trim()
                            ? 'bg-slate-700/50 text-slate-500 cursor-not-allowed'
                            : 'bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-lg shadow-blue-500/30 hover:shadow-blue-500/50'
                        }
                    `}
                >
                    <Plus className="w-5 h-5" /> Add Filter
                </button>
            </div>


            {addError && <p role="alert" className="text-xs text-red-400 -mt-3 mb-4">{addError}</p>}

            {customFilters.length === 0 ? (
                <div className={`
                    text-center py-8 rounded-xl border-2 border-dashed
                    ${isDark ? 'border-slate-700 text-slate-500' : 'border-slate-200 text-slate-400'}
                `}>
                    <div className="mb-2 flex justify-center">
                        <Target className="w-10 h-10 opacity-50" />
                    </div>
                    <p className="text-sm font-medium">No filters active</p>
                    <p className="text-xs mt-1">Add a field above to start filtering events</p>
                </div>
            ) : (
                <div className="space-y-4">
                    {customFilters.map(filter => {
                        const availableValues = getUniqueValuesForField(filter.field)
                        return (
                            <div
                                key={filter.field}
                                className={`
                                    p-4 rounded-xl border transition-all duration-300
                                    ${isDark
                                        ? 'bg-slate-800/50 border-slate-700/50 hover:border-slate-600'
                                        : 'bg-slate-50 border-slate-200 hover:border-slate-300'
                                    }
                                `}
                            >

                                <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center gap-2">
                                        <code className={`
                                            font-bold text-sm px-2.5 py-1 rounded-lg font-mono
                                            ${isDark
                                                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                                                : 'bg-cyan-50 text-cyan-700 border border-cyan-200'
                                            }
                                        `}>
                                            {filter.field}
                                        </code>
                                        {!filter.isRegex && (
                                            <span className={`
                                                text-xs px-2 py-0.5 rounded-full
                                                ${isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-200 text-slate-500'}
                                            `}>
                                                {availableValues.length} values
                                            </span>
                                        )}
                                    </div>

                                    <div className="flex gap-2">

                                        <button
                                            onClick={() => toggleRegexMode && toggleRegexMode(filter.field)}
                                            className={`
                                                text-xs px-3 py-1.5 rounded-lg font-semibold transition-all duration-300
                                                flex items-center gap-1.5 hover:scale-105
                                                ${filter.isRegex
                                                    ? 'bg-gradient-to-r from-indigo-500 to-blue-500 text-white shadow-lg shadow-indigo-500/30'
                                                    : isDark
                                                        ? 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                                                        : 'bg-slate-200 hover:bg-slate-300 text-slate-700'
                                                }
                                            `}
                                        >
                                            <Regex className="w-3 h-3" /> Regex
                                        </button>


                                        {!filter.isRegex && filter.activeValues.size > 0 && (
                                            <button
                                                onClick={() => onClearFilterValues(filter.field)}
                                                className={`
                                                    text-xs px-3 py-1.5 rounded-lg font-semibold transition-all duration-300
                                                    hover:scale-105
                                                    flex items-center gap-1
                                                    ${isDark
                                                        ? 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                                                        : 'bg-slate-200 hover:bg-slate-300 text-slate-700'
                                                    }
                                                `}
                                            >
                                                <RotateCcw className="w-3 h-3" /> Clear
                                            </button>
                                        )}


                                        <button
                                            onClick={() => onRemoveCustomFilter(filter.field)}
                                            className={`
                                                text-xs px-3 py-1.5 rounded-lg font-semibold transition-all duration-300
                                                hover:scale-105
                                                ${isDark
                                                    ? 'bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30'
                                                    : 'bg-red-50 hover:bg-red-100 text-red-600 border border-red-200'
                                                }
                                            `}
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>
                                </div>


                                {filter.isRegex ? (
                                    <div>
                                        <div className="relative">
                                            <div className="absolute left-3 top-1/2 -translate-y-1/2 opacity-60">
                                                <Code className="w-4 h-4" />
                                            </div>
                                            <input
                                                type="text"
                                                value={filter.regexPattern || ''}
                                                onChange={(e) => setRegexPattern && setRegexPattern(filter.field, e.target.value)}
                                                placeholder="^user-[0-9]+$"
                                                className={`
                                                    w-full pl-9 pr-8 py-3 rounded-xl border-2 font-mono text-sm
                                                    focus:outline-none transition-all duration-300
                                                    ${isDark
                                                        ? 'bg-slate-900/60 border-indigo-500/30 text-white placeholder-slate-500 focus:border-indigo-500 focus:bg-slate-900'
                                                        : 'bg-white border-indigo-200 text-slate-900 placeholder-slate-400 focus:border-indigo-500'
                                                    }
                                                `}
                                            />
                                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm opacity-60 font-mono">/i</span>
                                        </div>
                                        <p className={`text-xs mt-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                            Case-insensitive matching. Example: <code className="font-mono">error|warn</code> matches both.
                                        </p>
                                    </div>
                                ) : (
                                    availableValues.length === 0 ? (
                                        <p className={`
                                            text-xs text-center py-3
                                            ${isDark ? 'text-slate-500' : 'text-slate-400'}
                                        `}>
                                            No values found for this field in current events
                                        </p>
                                    ) : (
                                        <div className="flex flex-wrap gap-2">
                                            {availableValues.map(value => (
                                                <button
                                                    key={value}
                                                    onClick={() => onToggleFilterValue(filter.field, value)}
                                                    className={`
                                                        px-3 py-1.5 text-xs font-semibold rounded-lg transition-all duration-300
                                                        hover:scale-105
                                                        ${filter.activeValues.has(value)
                                                            ? 'bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-lg shadow-blue-500/30'
                                                            : isDark
                                                                ? 'bg-slate-700/70 text-slate-300 border border-slate-600/50 hover:border-cyan-500/50'
                                                                : 'bg-white text-slate-700 border border-slate-200 hover:border-cyan-300 hover:shadow-md'
                                                        }
                                                    `}
                                                >
                                                    {value}
                                                </button>
                                            ))}
                                        </div>
                                    )
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
})
