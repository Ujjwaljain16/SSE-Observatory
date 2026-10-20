import { memo } from 'react'
import { Database, Loader2, Brackets, Hash, Type, AlignLeft } from 'lucide-react'
import type { Theme } from '../types'
import { SchemaMap } from '../hooks/useSchemaInference'

interface SchemaAnalyzerProps {
    theme: Theme
    schema: SchemaMap
    isAnalyzing: boolean
}

// Icon mapper for types
const getTypeIcon = (type: string) => {
    switch (type) {
        case 'string': return <Type className="w-3 h-3" />
        case 'number': return <Hash className="w-3 h-3" />
        case 'boolean': return <div className="w-3 h-3 text-[10px] font-bold leading-none flex items-center justify-center">T/F</div>
        case 'array': return <Brackets className="w-3 h-3" />
        case 'object': return <div className="w-3 h-3 text-[10px] font-bold leading-none flex items-center justify-center">{"{ }"}</div>
        default: return <AlignLeft className="w-3 h-3" />
    }
}

export const SchemaAnalyzer = memo(function SchemaAnalyzer({ theme, schema, isAnalyzing }: SchemaAnalyzerProps) {
    const isDark = theme === 'dark'
    const fields = Object.entries(schema).sort((a, b) => a[0].localeCompare(b[0]))

    return (
        <div className={`mt-6 rounded-xl shadow-xl border overflow-hidden transition-all duration-300 ${isDark ? 'bg-slate-800/80 border-slate-700/50' : 'bg-white border-slate-200'}`}>
            <div className={`px-5 py-4 border-b flex items-center justify-between ${isDark ? 'bg-slate-900/50 border-slate-700/50' : 'bg-slate-50/80 border-slate-200'}`}>
                <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${isDark ? 'bg-indigo-500/20 text-indigo-400' : 'bg-indigo-100 text-indigo-600'}`}>
                        <Database className="w-5 h-5" />
                    </div>
                    <div>
                        <h3 className={`font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>Inferred Schema</h3>
                        <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Detected JSON structure from {Object.keys(schema).length > 0 ? 'the event stream' : '0 events'}</p>
                    </div>
                </div>
                {isAnalyzing && (
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-500">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span className="text-xs font-semibold">Analyzing...</span>
                    </div>
                )}
            </div>

            <div className="p-0 overflow-x-auto max-h-[400px] overflow-y-auto">
                {fields.length === 0 ? (
                    <div className="px-6 py-12 text-center">
                        <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                            Waiting for valid JSON payloads to analyze the schema...
                        </p>
                    </div>
                ) : (
                    <table className="w-full text-left border-collapse text-sm">
                        <thead className={`sticky top-0 z-10 text-xs uppercase tracking-wider ${isDark ? 'bg-slate-900 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                            <tr>
                                <th className="px-5 py-3 font-semibold w-1/2 rounded-tl-xl border-b border-inherit">Field Path</th>
                                <th className="px-5 py-3 font-semibold border-b border-inherit">Detected Types</th>
                                <th className="px-5 py-3 font-semibold text-right rounded-tr-xl border-b border-inherit">Frequency</th>
                            </tr>
                        </thead>
                        <tbody className={`divide-y ${isDark ? 'divide-slate-700/50' : 'divide-slate-200'}`}>
                            {fields.map(([path, data]) => {
                                const types = Array.from(data.type)
                                const isAlwaysPresent = data.frequency >= 0.99 // essentially always

                                return (
                                    <tr key={path} className={`hover:bg-opacity-50 transition-colors ${isDark ? 'hover:bg-slate-700/30' : 'hover:bg-slate-50'}`}>
                                        <td className="px-5 py-3 font-mono text-xs">
                                            <span className={`${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                                                {path}
                                            </span>
                                            {!isAlwaysPresent && (
                                                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded text-amber-500 bg-amber-500/10 border border-amber-500/20" title="This field is not present in all payloads">
                                                    Optional
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-5 py-3">
                                            <div className="flex flex-wrap gap-1.5">
                                                {types.map(t => (
                                                    <span key={t} className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border ${t === 'string' ? (isDark ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' : 'bg-blue-50 text-blue-700 border-blue-200') :
                                                            t === 'number' ? (isDark ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' : 'bg-purple-50 text-purple-700 border-purple-200') :
                                                                t === 'boolean' ? (isDark ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' : 'bg-rose-50 text-rose-700 border-rose-200') :
                                                                    (isDark ? 'bg-slate-700 text-slate-300 border-slate-600' : 'bg-slate-100 text-slate-600 border-slate-300')
                                                        }`}>
                                                        {getTypeIcon(t)}
                                                        {t}
                                                    </span>
                                                ))}
                                                {types.length > 1 && (
                                                    <span className={`px-2 py-1 rounded-md text-[10px] border font-bold uppercase ${isDark ? 'bg-red-500/10 text-red-500 border-red-500/30' : 'bg-red-50 text-red-600 border-red-200'}`} title="Multiple types detected (potentially unstable schema)">
                                                        Mixed
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-5 py-3 text-right">
                                            <div className="flex items-center justify-end gap-3">
                                                <div className="w-16 h-1.5 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700">
                                                    <div
                                                        className={`h-full rounded-full ${isAlwaysPresent ? 'bg-emerald-500' : 'bg-sky-500'}`}
                                                        style={{ width: `${Math.round(data.frequency * 100)}%` }}
                                                    />
                                                </div>
                                                <span className={`text-xs font-medium min-w-[40px] ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                                                    {Math.round(data.frequency * 100)}%
                                                </span>
                                            </div>
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    )
})
