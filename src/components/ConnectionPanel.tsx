import type { Theme } from '../types'
import { formatTime } from '../utils/eventUtils'
import {
    Link, Globe, Lock, Save, AlertTriangle, Check,
    Clock, Play, Square, Trash2, Loader2,
    Plug
} from 'lucide-react'
interface ConnectionPanelProps {
    theme: Theme
    url: string
    bearerToken: string
    profileName: string
    connected: boolean
    isLoading: boolean
    error: string
    connectionTime: number
    eventsLength: number
    onUrlChange: (url: string) => void
    onTokenChange: (token: string) => void
    onProfileNameChange: (name: string) => void
    onSaveProfile: () => void
    onConnect: () => void
    onDisconnect: () => void
    onClearEvents: () => void
}

export const ConnectionPanel = ({
    theme,
    url,
    bearerToken,
    profileName,
    connected,
    isLoading,
    error,
    connectionTime,
    eventsLength,
    onUrlChange,
    onTokenChange,
    onProfileNameChange,
    onSaveProfile,
    onConnect,
    onDisconnect,
    onClearEvents
}: ConnectionPanelProps) => {
    const isDark = theme === 'dark'

    return (
        <div className={`
            rounded-2xl p-4 lg:p-6 mb-8 animate-slide-up
            backdrop-blur-xl border transition-all duration-300
            ${isDark
                ? 'bg-slate-900/70 border-slate-700/50 shadow-xl shadow-black/20'
                : 'bg-white/80 border-slate-200/70 shadow-xl shadow-slate-300/20'
            }
        `}>
            <div className="flex items-center gap-3 mb-4">
                <div className={`
                    w-8 h-8 rounded-xl flex items-center justify-center
                    ${isDark ? 'bg-slate-800' : 'bg-slate-100'}
                `}>
                    <Link className={`w-4 h-4 ${isDark ? 'text-sky-400' : 'text-sky-600'}`} />
                </div>
                <div>
                    <h2 className={`text-base font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        Connection Settings
                    </h2>
                </div>
            </div>

            <div className="flex flex-col lg:flex-row gap-4 items-start">
                <div className="flex-1 w-full relative">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 opacity-60">
                        <Globe className="w-5 h-5" />
                    </div>
                    <input
                        type="text"
                        value={url}
                        onChange={(e) => onUrlChange(e.target.value)}
                        placeholder="https://api.example.com/sse"
                        disabled={connected || isLoading}
                        className={`
                            w-full pl-12 pr-4 py-3 rounded-xl border-2 font-medium text-sm
                            focus:outline-none transition-all duration-300
                            ${isDark
                                ? 'bg-slate-800/80 border-slate-600/50 text-white placeholder-slate-500 focus:border-sky-500 focus:bg-slate-800'
                                : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:border-sky-500 focus:bg-white'
                            }
                            ${(connected || isLoading) ? 'opacity-60 cursor-not-allowed' : ''}
                        `}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !connected && !isLoading) {
                                onConnect()
                            }
                        }}
                    />
                </div>

                <div className="flex-1 w-full relative">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 opacity-60">
                        <Lock className="w-5 h-5" />
                    </div>
                    <input
                        type="password"
                        value={bearerToken}
                        onChange={(e) => onTokenChange(e.target.value)}
                        placeholder="Bearer token (optional)"
                        disabled={connected || isLoading}
                        className={`
                            w-full pl-12 pr-4 py-3 rounded-xl border-2 font-medium text-sm
                            focus:outline-none transition-all duration-300
                            ${isDark
                                ? 'bg-slate-800/80 border-slate-600/50 text-white placeholder-slate-500 focus:border-sky-500 focus:bg-slate-800'
                                : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:border-sky-500 focus:bg-white'
                            }
                            ${(connected || isLoading) ? 'opacity-60 cursor-not-allowed' : ''}
                        `}
                    />
                </div>

                <div className="flex gap-2 w-full lg:w-auto">
                    <button
                        onClick={connected ? onDisconnect : onConnect}
                        disabled={isLoading || (!connected && !url.trim())}
                        className={`
                            flex-1 lg:flex-none lg:w-32 px-4 py-3 rounded-xl font-bold text-sm transition-all duration-300
                            flex items-center justify-center gap-2 hover:scale-[1.02]
                            ${(isLoading || (!connected && !url.trim()))
                                ? isDark ? 'bg-slate-700 text-slate-400 opacity-50 cursor-not-allowed' : 'bg-slate-200 text-slate-500 opacity-50 cursor-not-allowed'
                                : connected
                                    ? 'bg-gradient-to-r from-red-500 to-rose-500 text-white shadow-lg shadow-red-500/30'
                                    : 'bg-gradient-to-r from-sky-600 via-blue-600 to-cyan-600 text-white shadow-lg shadow-blue-500/30'
                            }
                        `}
                    >
                        <span className="flex items-center justify-center gap-2">
                            {isLoading ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : connected ? (
                                <Square className="w-4 h-4" />
                            ) : (
                                <Play className="w-4 h-4" />
                            )}
                            <span className="whitespace-nowrap">
                                {isLoading ? '...' : connected ? 'Stop' : 'Connect'}
                            </span>
                        </span>
                    </button>
                    {(!connected && !isLoading) && (
                        <div className="relative group">
                            <button
                                onClick={onSaveProfile}
                                disabled={!url.trim()}
                                className={`
                                    w-12 h-12 flex items-center justify-center rounded-xl transition-all duration-300
                                    ${!url.trim()
                                        ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
                                        : 'bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'
                                    }
                                `}
                                title="Save Profile"
                            >
                                <Save className="w-5 h-5" />
                            </button>
                            <div className="absolute right-0 top-14 hidden group-hover:flex items-center gap-2 p-2 rounded-lg border shadow-xl bg-white dark:bg-slate-800 dark:border-slate-700 z-10 w-64">
                                <input
                                    type="text"
                                    value={profileName}
                                    onChange={(e) => onProfileNameChange(e.target.value)}
                                    placeholder="Profile Name"
                                    className="flex-1 px-3 py-1.5 text-sm rounded bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-white border-0 focus:ring-2 focus:ring-sky-500"
                                />
                                <button onClick={onSaveProfile} className="p-1.5 text-sky-600 dark:text-sky-400 hover:bg-sky-50 hover:dark:bg-sky-900/30 rounded">
                                    <Check className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Status & Actions Row */}
            <div className={`mt-4 flex flex-col md:flex-row md:items-center justify-between gap-4 pt-4 border-t ${isDark ? 'border-slate-700/50' : 'border-slate-200/70'}`}>
                <div className="flex items-center gap-4 flex-wrap">
                    {error && (
                        <div className="text-red-500 text-sm flex items-center gap-1.5 font-medium">
                            <AlertTriangle className="w-4 h-4" /> {error}
                        </div>
                    )}

                    {!error && (
                        <div className="flex items-center gap-2">
                            <div className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)] animate-pulse' : isLoading ? 'bg-amber-400 animate-pulse' : 'bg-slate-400'}`} />
                            <span className={`text-sm font-semibold ${connected ? 'text-emerald-600 dark:text-emerald-400' : isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                {connected ? (
                                    <span>Connected to <span className="text-slate-700 dark:text-slate-300 font-mono ml-1">{(() => { try { return new URL(url).hostname } catch { return 'Endpoint' } })()}</span></span>
                                ) : isLoading ? 'Connecting...' : 'Disconnected'}
                            </span>
                        </div>
                    )}

                    {connected && !error && (
                        <>
                            <div className={`hidden sm:block w-px h-4 ${isDark ? 'bg-slate-700' : 'bg-slate-300'}`} />
                            <span className={`text-sm flex items-center gap-1.5 font-mono ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                <Clock className="w-4 h-4" /> {formatTime(connectionTime)}
                            </span>
                            <div className={`hidden sm:block w-px h-4 ${isDark ? 'bg-slate-700' : 'bg-slate-300'}`} />
                            <span className={`text-sm flex items-center gap-1.5 font-mono ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                <Plug className="w-4 h-4" /> {eventsLength} events
                            </span>
                        </>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    <button
                        onClick={onClearEvents}
                        disabled={eventsLength === 0}
                        className={`
                            px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-300
                            flex items-center justify-center gap-2
                            ${eventsLength === 0
                                ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
                                : 'bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 hover:scale-[1.02]'
                            }
                        `}
                    >
                        <Trash2 className="w-4 h-4" /> Clear Events
                    </button>
                </div>
            </div>
        </div>
    )
}
