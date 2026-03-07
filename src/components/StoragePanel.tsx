import { useState } from 'react'
import type { Theme, EventMessage } from '../types'
import { Database, Download, Trash2, RotateCcw, AlertTriangle, ChevronDown } from 'lucide-react'

interface StoragePanelProps {
    theme: Theme
    idbAvailable: boolean
    totalStoredCount: number
    ramBufferCount: number
    maxRamBuffer: number
    onLoadMore: () => Promise<EventMessage[]>
    onClearStorage: () => Promise<void>
    onExportAll: () => Promise<void>
    onReplayFromStorage: () => Promise<void>
}

export const StoragePanel = ({
    theme,
    idbAvailable,
    totalStoredCount,
    ramBufferCount,
    maxRamBuffer,
    onLoadMore,
    onClearStorage,
    onExportAll,
    onReplayFromStorage,
}: StoragePanelProps) => {
    const isDark = theme === 'dark'
    const [isLoading, setIsLoading] = useState(false)
    const [lastLoaded, setLastLoaded] = useState(0)

    const handleLoadMore = async () => {
        setIsLoading(true)
        try {
            const events = await onLoadMore()
            setLastLoaded(events.length)
        } finally {
            setIsLoading(false)
        }
    }

    const handleReplay = async () => {
        setIsLoading(true)
        try {
            await onReplayFromStorage()
        } finally {
            setIsLoading(false)
        }
    }

    const storageFillPct = totalStoredCount > 0
        ? Math.min((totalStoredCount / 100_000) * 100, 100)
        : 0

    return (
        <div className={`rounded-xl border p-4 transition-all ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-50 border-slate-200'
            } ${!idbAvailable ? 'opacity-80' : ''}`}>
            <div className="flex items-center gap-3 mb-3">
                <Database className={`w-4 h-4 ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`} />
                <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    Cold Storage
                </span>
                {!idbAvailable && (
                    <span className="flex items-center gap-1 text-xs text-amber-400 ml-auto">
                        <AlertTriangle className="w-3 h-3" />
                        RAM-only mode (IDB unavailable)
                    </span>
                )}
            </div>


            <div className="grid grid-cols-2 gap-3 mb-3">
                <div className={`p-2 rounded-lg text-center ${isDark ? 'bg-slate-700/60' : 'bg-white border border-slate-200'}`}>
                    <div className={`text-xs mb-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>RAM Buffer</div>
                    <div className={`text-lg font-bold font-mono ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        {ramBufferCount.toLocaleString()}
                        <span className={`text-xs font-normal ml-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                            / {maxRamBuffer.toLocaleString()}
                        </span>
                    </div>
                </div>
                <div className={`p-2 rounded-lg text-center ${isDark ? 'bg-slate-700/60' : 'bg-white border border-slate-200'}`}>
                    <div className={`text-xs mb-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Stored (IDB)</div>
                    <div className={`text-lg font-bold font-mono ${isDark ? 'text-indigo-300' : 'text-indigo-700'}`}>
                        {idbAvailable ? totalStoredCount.toLocaleString() : '—'}
                    </div>
                </div>
            </div>


            {idbAvailable && totalStoredCount > 0 && (
                <div className="mb-3">
                    <div className={`h-1.5 w-full rounded-full ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
                        <div
                            className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-500"
                            style={{ width: `${storageFillPct}%` }}
                        />
                    </div>
                    <div className={`text-xs mt-0.5 text-right ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        {storageFillPct.toFixed(1)}% of 100k limit
                    </div>
                </div>
            )}


            <div className="flex flex-wrap gap-2">
                {idbAvailable && (
                    <>
                        <button
                            onClick={handleLoadMore}
                            disabled={isLoading || !idbAvailable}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all
                                ${isDark
                                    ? 'bg-indigo-600/30 text-indigo-300 hover:bg-indigo-600/50 border border-indigo-600/30'
                                    : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200'
                                } disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                            <ChevronDown className="w-3 h-3" />
                            {isLoading ? 'Loading…' : lastLoaded > 0 ? `Loaded ${lastLoaded}` : 'Load More'}
                        </button>

                        <button
                            onClick={handleReplay}
                            disabled={isLoading || totalStoredCount === 0}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all
                                ${isDark
                                    ? 'bg-emerald-600/30 text-emerald-300 hover:bg-emerald-600/50 border border-emerald-600/30'
                                    : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200'
                                } disabled:opacity-50 disabled:cursor-not-allowed`}
                            title="Replay all stored events through the mock stream"
                        >
                            <RotateCcw className="w-3 h-3" />
                            Replay Session
                        </button>

                        <button
                            onClick={onExportAll}
                            disabled={totalStoredCount === 0}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all
                                ${isDark
                                    ? 'bg-slate-700 text-slate-300 hover:bg-slate-600 border border-slate-600'
                                    : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-300'
                                } disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                            <Download className="w-3 h-3" />
                            Export All
                        </button>

                        <button
                            onClick={onClearStorage}
                            disabled={totalStoredCount === 0}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all
                                bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20
                                disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                            <Trash2 className="w-3 h-3" />
                            Clear History
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}
