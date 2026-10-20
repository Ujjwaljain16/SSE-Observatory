import { useState } from 'react'
import type { Theme } from '../types'
import type { Interceptor } from '../hooks/useInterceptors'
import { Plus, Trash2, ToggleLeft, ToggleRight, Zap, AlertCircle, CheckCircle2, GripVertical } from 'lucide-react'

interface InterceptorEditorProps {
    theme: Theme
    interceptors: Interceptor[]
    onAdd: () => void
    onRemove: (id: string) => void
    onRename: (id: string, newName: string) => void
    onUpdateCode: (id: string, code: string) => void
    onToggle: (id: string) => void
    onReorder: (from: number, to: number) => void
    lastEventRaw?: string // For the live preview
    lastEventTransformed?: string
}

export const InterceptorEditor = ({
    theme,
    interceptors,
    onAdd,
    onRemove,
    onRename,
    onUpdateCode,
    onToggle,
    onReorder,
    lastEventRaw,
    lastEventTransformed,
}: InterceptorEditorProps) => {
    const isDark = theme === 'dark'
    const [expandedId, setExpandedId] = useState<string | null>(null)
    const [draggedId, setDraggedId] = useState<string | null>(null)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [editName, setEditName] = useState('')

    return (
        <div className={`p-6 rounded-2xl border mb-6 transition-all animate-slide-up ${isDark
            ? 'bg-slate-900/70 border-slate-700/50 shadow-xl shadow-black/20'
            : 'bg-white border-slate-200 shadow-xl shadow-slate-300/20'
            }`}>

            <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-gradient-to-br from-amber-500 to-orange-600 shadow-lg shadow-amber-500/30">
                    <Zap className="w-5 h-5 text-white" />
                </div>
                <div>
                    <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        Stream Interceptors
                    </h2>
                    <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        Transform or drop events before they reach the buffer. Runs on every incoming event.
                    </p>
                </div>
                <button
                    onClick={onAdd}
                    className="ml-auto px-3 py-2 rounded-lg font-semibold text-sm flex items-center gap-1 bg-amber-600 hover:bg-amber-500 text-white transition-all"
                >
                    <Plus className="w-4 h-4" /> Add
                </button>
            </div>

            {interceptors.length === 0 ? (
                <div className={`text-center py-8 rounded-xl border border-dashed ${isDark ? 'border-slate-700 text-slate-500' : 'border-slate-300 text-slate-400'}`}>
                    <Zap className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">No interceptors. Add one to transform incoming events.</p>
                    <p className="text-xs mt-1 opacity-70">Example: Base64 decode, field rename, event filtering.</p>
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    {interceptors.map((interceptor, index) => (
                        <div
                            key={interceptor.id}
                            draggable={editingId !== interceptor.id}
                            onDragStart={(e) => {
                                setDraggedId(interceptor.id)
                                e.dataTransfer.effectAllowed = 'move'
                            }}
                            onDragOver={(e) => {
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'move'
                            }}
                            onDragEnter={(e) => e.preventDefault()}
                            onDrop={(e) => {
                                e.preventDefault()
                                if (!draggedId || draggedId === interceptor.id) return
                                const fromIndex = interceptors.findIndex(i => i.id === draggedId)
                                if (fromIndex !== -1 && fromIndex !== index) {
                                    // defer reordering to next tick to avoid dom sync conflicts during html5 drag release
                                    setTimeout(() => onReorder(fromIndex, index), 0)
                                }
                                setDraggedId(null)
                            }}
                            onDragEnd={(e) => {
                                e.preventDefault()
                                setDraggedId(null)
                            }}
                            className={`rounded-xl border transition-all ${isDark ? 'border-slate-700 bg-slate-800/40' : 'border-slate-200 bg-slate-50'
                                } ${!interceptor.enabled ? 'opacity-50' : ''} ${draggedId === interceptor.id ? 'opacity-40 scale-[0.98]' : ''}`}
                        >

                            <div
                                className="flex items-center gap-2 p-3 cursor-pointer select-none"
                                onClick={() => setExpandedId(expandedId === interceptor.id ? null : interceptor.id)}
                            >

                                <div className={`cursor-grab active:cursor-grabbing p-1 -ml-1 ${isDark ? 'text-slate-600 hover:text-slate-400' : 'text-slate-400 hover:text-slate-600'}`}>
                                    <GripVertical className="w-4 h-4" />
                                </div>



                                <span className={`text-xs font-mono font-bold px-1.5 py-0.5 rounded ${isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-200 text-slate-500'}`}>
                                    #{index + 1}
                                </span>




                                {editingId === interceptor.id ? (
                                    <input
                                        autoFocus
                                        value={editName}
                                        onChange={e => setEditName(e.target.value)}
                                        onBlur={() => {
                                            if (editName.trim()) onRename(interceptor.id, editName.trim())
                                            setEditingId(null)
                                        }}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') {
                                                e.stopPropagation()
                                                if (editName.trim()) onRename(interceptor.id, editName.trim())
                                                setEditingId(null)
                                            } else if (e.key === 'Escape') {
                                                e.stopPropagation()
                                                setEditingId(null)
                                            }
                                        }}
                                        onClick={e => e.stopPropagation()}
                                        className={`flex-1 text-sm font-semibold px-2 py-0.5 rounded outline-none border ${isDark
                                            ? 'bg-slate-700 border-sky-500 text-white'
                                            : 'bg-white border-sky-400 text-slate-900 shadow-sm'
                                            }`}
                                    />
                                ) : (
                                    <span
                                        className={`flex-1 text-sm font-semibold truncate ${isDark ? 'text-white' : 'text-slate-900'} hover:text-sky-500 transition-colors cursor-text`}
                                        onClick={e => {
                                            e.stopPropagation()
                                            setEditingId(interceptor.id)
                                            setEditName(interceptor.name || `Interceptor ${index + 1}`)
                                        }}
                                        title="Click to rename"
                                    >
                                        {interceptor.name || `Interceptor ${index + 1}`}
                                    </span>
                                )}


                                {interceptor.compileError ? (
                                    <span key={`compile-${interceptor.id}`} className="flex items-center gap-1 text-xs text-red-400">
                                        <AlertCircle className="w-3.5 h-3.5" /> Compile Error
                                    </span>
                                ) : interceptor.lastError ? (
                                    <span key={`runtime-${interceptor.id}`} className="flex items-center gap-1 text-xs text-amber-400">
                                        <AlertCircle className="w-3.5 h-3.5" /> Runtime Error
                                    </span>
                                ) : (
                                    <span key={`ready-${interceptor.id}`} className="flex items-center gap-1 text-xs text-emerald-400">
                                        <CheckCircle2 className="w-3.5 h-3.5" /> Ready
                                    </span>
                                )}


                                <button
                                    role="switch"
                                    aria-checked={interceptor.enabled}
                                    aria-label={`${interceptor.name} enabled`}
                                    onClick={e => { e.stopPropagation(); onToggle(interceptor.id) }}
                                    className="flex items-center justify-center"
                                >
                                    <span className="flex">
                                        {interceptor.enabled
                                            ? <ToggleRight className="w-5 h-5 text-amber-400" />
                                            : <ToggleLeft className={`w-5 h-5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
                                        }
                                    </span>
                                </button>


                                <button
                                    onClick={e => { e.stopPropagation(); onRemove(interceptor.id) }}
                                    className="p-1 rounded text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition-all"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </div>


                            {expandedId === interceptor.id && (
                                <div className="px-3 pb-3">
                                    {interceptor.compileError && (
                                        <div className="mb-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400 font-mono">
                                            {interceptor.compileError}
                                        </div>
                                    )}
                                    {interceptor.lastError && !interceptor.compileError && (
                                        <div className="mb-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-400 font-mono">
                                            Last error: {interceptor.lastError}
                                        </div>
                                    )}
                                    <textarea
                                        value={interceptor.code}
                                        onChange={e => onUpdateCode(interceptor.id, e.target.value)}
                                        spellCheck={false}
                                        rows={8}
                                        className={`w-full font-mono text-xs p-3 rounded-lg border focus:outline-none focus:ring-2 focus:ring-amber-500/30 resize-y ${isDark
                                            ? 'bg-black/50 border-slate-700 text-emerald-400'
                                            : 'bg-white border-slate-300 text-slate-800'
                                            }`}
                                    />


                                    {lastEventRaw && (
                                        <div className="mt-3 grid grid-cols-2 gap-2">
                                            <div>
                                                <div className={`text-xs font-semibold mb-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                                    Raw Input (last event)
                                                </div>
                                                <pre className={`text-xs p-2 rounded-lg border overflow-auto max-h-24 ${isDark ? 'bg-black/40 border-slate-700 text-slate-400' : 'bg-slate-100 border-slate-200 text-slate-600'}`}>
                                                    {lastEventRaw}
                                                </pre>
                                            </div>
                                            <div>
                                                <div className={`text-xs font-semibold mb-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                                    Transformed Output
                                                </div>
                                                <pre className={`text-xs p-2 rounded-lg border overflow-auto max-h-24 ${lastEventTransformed
                                                    ? isDark ? 'bg-emerald-900/20 border-emerald-700/30 text-emerald-400' : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                                    : isDark ? 'bg-red-900/20 border-red-700/30 text-red-400' : 'bg-red-50 border-red-200 text-red-700'
                                                    }`}>
                                                    {lastEventTransformed ?? '— dropped —'}
                                                </pre>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )
            }
        </div >
    )
}
