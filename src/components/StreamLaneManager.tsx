import { useState } from 'react'
import type { Theme } from '../types'
import type { StreamInstance } from '../hooks/useMultiStream'
import { Plus, Trash2, Play, Square, Wifi, WifiOff, Circle } from 'lucide-react'

interface StreamLaneManagerProps {
    theme: Theme
    streams: StreamInstance[]
    onAddStream: (name: string, url: string) => string
    onRemoveStream: (id: string) => void
    onConnectStream: (id: string) => void
    onDisconnectStream: (id: string) => void
    onClearStreamEvents: (id: string) => void
}

export const StreamLaneManager = ({
    theme,
    streams,
    onAddStream,
    onRemoveStream,
    onConnectStream,
    onDisconnectStream,
    onClearStreamEvents,
}: StreamLaneManagerProps) => {
    const isDark = theme === 'dark'
    const [newName, setNewName] = useState('')
    const [newUrl, setNewUrl] = useState('')

    const handleAdd = () => {
        if (!newUrl.trim()) return
        const name = newName.trim() || `Stream ${streams.length + 1}`
        onAddStream(name, newUrl.trim())
        setNewName('')
        setNewUrl('')
    }

    return (
        <div className={`p-6 rounded-2xl border mb-6 transition-all ${isDark
            ? 'bg-slate-900/70 border-slate-700/50 shadow-xl shadow-black/20'
            : 'bg-white border-slate-200 shadow-xl shadow-slate-300/20'
            }`}>
            <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/30">
                    <Wifi className="w-5 h-5 text-white" />
                </div>
                <div>
                    <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        Stream Lanes
                    </h2>
                    <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        Connect multiple SSE endpoints and correlate events on one timeline
                    </p>
                </div>
                {streams.length > 0 && (
                    <span className="ml-auto px-2 py-1 rounded-full text-xs font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30">
                        {streams.filter(s => s.connected).length}/{streams.length} live
                    </span>
                )}
            </div>


            <div className={`flex gap-2 mb-5 p-3 rounded-xl border ${isDark ? 'border-slate-700 bg-slate-800/40' : 'border-slate-200 bg-slate-50'}`}>
                <input
                    type="text"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    placeholder="Stream name (e.g. auth-service)"
                    className={`flex-[1] px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${isDark
                        ? 'bg-slate-700 border-slate-600 text-white placeholder-slate-500'
                        : 'bg-white border-slate-300 text-slate-900 placeholder-slate-400'
                        }`}
                />
                <input
                    type="text"
                    value={newUrl}
                    onChange={e => setNewUrl(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAdd()}
                    placeholder="https://api.example.com/stream"
                    className={`flex-[2] px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${isDark
                        ? 'bg-slate-700 border-slate-600 text-white placeholder-slate-500'
                        : 'bg-white border-slate-300 text-slate-900 placeholder-slate-400'
                        }`}
                />
                <button
                    onClick={handleAdd}
                    disabled={!newUrl.trim()}
                    className="px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2 transition-all bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white"
                >
                    <Plus className="w-4 h-4" /> Add
                </button>
            </div>


            {streams.length === 0 ? (
                <div className={`text-center py-8 rounded-xl border border-dashed ${isDark ? 'border-slate-700 text-slate-500' : 'border-slate-300 text-slate-400'}`}>
                    <Wifi className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">No streams configured. Add your first stream above.</p>
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    {streams.map(stream => (
                        <div
                            key={stream.id}
                            className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${isDark ? 'border-slate-700 bg-slate-800/40' : 'border-slate-200 bg-slate-50'
                                }`}
                            style={{ borderLeftWidth: 3, borderLeftColor: stream.color }}
                        >

                            <div className="flex items-center gap-2">
                                <Circle
                                    className="w-3 h-3"
                                    style={{ fill: stream.color, color: stream.color }}
                                />
                                <div className={`w-2 h-2 rounded-full transition-all ${stream.connected
                                    ? 'bg-emerald-400 animate-pulse shadow-emerald-400/50 shadow-md'
                                    : stream.isLoading
                                        ? 'bg-amber-400 animate-pulse'
                                        : 'bg-slate-500'
                                    }`} />
                            </div>


                            <div className="flex-1 min-w-0">
                                <div className={`text-sm font-semibold truncate ${isDark ? 'text-white' : 'text-slate-900'}`}>
                                    {stream.name}
                                </div>
                                <div className={`text-xs truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                    {stream.url}
                                </div>
                                {stream.error && (
                                    <div className="text-xs text-red-400 truncate mt-0.5">{stream.error}</div>
                                )}
                            </div>


                            <span className={`px-2 py-0.5 rounded-full text-xs font-mono font-bold ${isDark ? 'bg-slate-700 text-slate-300' : 'bg-slate-200 text-slate-600'}`}>
                                {stream.events.length.toLocaleString()}
                            </span>


                            <div className="flex items-center gap-1">
                                {stream.connected ? (
                                    <button
                                        onClick={() => onDisconnectStream(stream.id)}
                                        className="p-1.5 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-all"
                                        title="Disconnect"
                                    >
                                        <span key="disc-icon"><Square className="w-3.5 h-3.5" /></span>
                                    </button>
                                ) : (
                                    <button
                                        onClick={() => onConnectStream(stream.id)}
                                        disabled={stream.isLoading}
                                        className="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-50 transition-all"
                                        title="Connect"
                                    >
                                        <span key="conn-icon">
                                            {stream.isLoading
                                                ? <WifiOff className="w-3.5 h-3.5 animate-pulse" />
                                                : <Play className="w-3.5 h-3.5" />
                                            }
                                        </span>
                                    </button>
                                )}
                                <button
                                    onClick={() => onClearStreamEvents(stream.id)}
                                    className={`p-1.5 rounded-lg transition-all ${isDark ? 'text-slate-400 hover:bg-slate-700' : 'text-slate-500 hover:bg-slate-200'}`}
                                    title="Clear events"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onClick={() => onRemoveStream(stream.id)}
                                    className="p-1.5 rounded-lg text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition-all"
                                    title="Remove stream"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
