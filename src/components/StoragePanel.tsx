import { useState } from 'react'
import type { Theme } from '../types'
import { MAX_STORED_EVENTS } from '../hooks/useEventStorage'
import { Database, Download, Trash2, History, AlertTriangle } from 'lucide-react'

interface StoragePanelProps {
    theme: Theme
    idbAvailable: boolean
    totalStoredCount: number
    ramBufferCount: number
    maxRamBuffer: number
    /** Replace the viewer with the stored history; resolves to how many events were loaded. */
    onLoadHistory: () => Promise<number>
    onClearStorage: () => Promise<void>
    onExportAll: () => Promise<void>
}

export const StoragePanel = ({
    theme,
    idbAvailable,
    totalStoredCount,
    ramBufferCount,
    maxRamBuffer,
    onLoadHistory,
    onClearStorage,
    onExportAll,
}: StoragePanelProps) => {
    const isDark = theme === 'dark'
    const [busy, setBusy] = useState<'load' | 'export' | 'clear' | null>(null)
    const [lastLoaded, setLastLoaded] = useState<number | null>(null)

    const run = async (kind: 'load' | 'export' | 'clear', fn: () => Promise<void>) => {
        setBusy(kind)
        try { await fn() } finally { setBusy(null) }
    }

    const storageFillPct = totalStoredCount > 0 ? Math.min((totalStoredCount / MAX_STORED_EVENTS) * 100, 100) : 0

    const btn = (tone: 'indigo' | 'neutral' | 'danger') => `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
        tone === 'danger'
            ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20'
            : tone === 'indigo'
                ? isDark ? 'bg-indigo-600/30 text-indigo-300 hover:bg-indigo-600/50 border border-indigo-600/30' : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200'
                : isDark ? 'bg-slate-700 text-slate-300 hover:bg-slate-600 border border-slate-600' : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-300'
    }`

    return (
        <div className={`rounded-xl border p-4 transition-all ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-50 border-slate-200'} ${!idbAvailable ? 'opacity-80' : ''}`}>
            <div className="flex items-center gap-3 mb-3">
                <Database className={`w-4 h-4 ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`} />
                <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>Cold Storage</span>
                {!idbAvailable && (
                    <span className="flex items-center gap-1 text-xs text-amber-400 ml-auto">
                        <AlertTriangle className="w-3 h-3" />
                        RAM-only mode (IndexedDB unavailable)
                    </span>
                )}
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
                <div className={`p-2 rounded-lg text-center ${isDark ? 'bg-slate-700/60' : 'bg-white border border-slate-200'}`}>
                    <div className={`text-xs mb-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>RAM Buffer</div>
                    <div className={`text-lg font-bold font-mono ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        {ramBufferCount.toLocaleString()}
                        <span className={`text-xs font-normal ml-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>/ {maxRamBuffer.toLocaleString()}</span>
                    </div>
                </div>
                <div className={`p-2 rounded-lg text-center ${isDark ? 'bg-slate-700/60' : 'bg-white border border-slate-200'}`}>
                    <div className={`text-xs mb-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Stored (IndexedDB)</div>
                    <div className={`text-lg font-bold font-mono ${isDark ? 'text-indigo-300' : 'text-indigo-700'}`}>
                        {idbAvailable ? totalStoredCount.toLocaleString() : '—'}
                    </div>
                </div>
            </div>

            {idbAvailable && totalStoredCount > 0 && (
                <div className="mb-3">
                    <div className={`h-1.5 w-full rounded-full ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
                        <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-500" style={{ width: `${storageFillPct}%` }} />
                    </div>
                    <div className={`text-xs mt-0.5 text-right ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        {storageFillPct.toFixed(1)}% of the {MAX_STORED_EVENTS.toLocaleString()}-event limit (oldest are removed first)
                    </div>
                </div>
            )}

            {idbAvailable && (
                <div className="flex flex-wrap gap-2">
                    <button
                        onClick={() => run('load', async () => setLastLoaded(await onLoadHistory()))}
                        disabled={busy !== null || totalStoredCount === 0}
                        className={btn('indigo')}
                        aria-label="Show the stored events in the viewer (newest first). Works offline." title="Show the stored events in the viewer (newest first). Works offline."
                    >
                        <History className="w-3 h-3" />
                        {busy === 'load' ? 'Loading…' : lastLoaded !== null ? `Loaded ${lastLoaded.toLocaleString()} — reload` : 'Load history'}
                    </button>

                    <button onClick={() => run('export', onExportAll)} disabled={busy !== null || totalStoredCount === 0} className={btn('neutral')}
                        aria-label="Download everything stored as a replayable .sse-record file" title="Download everything stored as a replayable .sse-record file">
                        <Download className="w-3 h-3" />
                        {busy === 'export' ? 'Exporting…' : 'Export all'}
                    </button>

                    <button
                        onClick={() => {
                            if (window.confirm(`Delete all ${totalStoredCount.toLocaleString()} stored events? This cannot be undone.`)) void run('clear', onClearStorage)
                        }}
                        disabled={busy !== null || totalStoredCount === 0}
                        className={btn('danger')}
                    >
                        <Trash2 className="w-3 h-3" />
                        Clear history
                    </button>
                </div>
            )}
        </div>
    )
}
