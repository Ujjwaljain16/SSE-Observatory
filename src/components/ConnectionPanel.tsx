import type { Theme } from '../types'
import { formatTime } from '../utils/eventUtils'
import {
    Link, Globe, Lock, Save, AlertTriangle,
    Clock, Play, Square, Trash2, Loader2,
    Plug, PowerOff
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
            rounded-2xl p-6 mb-8 animate-slide-up
            backdrop-blur-xl border transition-all duration-300
            ${isDark
                ? 'bg-slate-900/70 border-slate-700/50 shadow-xl shadow-black/20'
                : 'bg-white/80 border-slate-200/70 shadow-xl shadow-slate-300/20'
            }
        `}>
            {/* Header */}
            <div className="flex items-center gap-3 mb-6">
                <div className={`
                    w-10 h-10 rounded-xl flex items-center justify-center
                    ${isDark ? 'bg-slate-800' : 'bg-slate-100'}
                `}>
                    <Link className={`w-5 h-5 ${isDark ? 'text-sky-400' : 'text-sky-600'}`} />
                </div>
                <div>
                    <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        Connection Settings
                    </h2>
                    <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                        Configure your SSE endpoint
                    </p>
                </div>
            </div>

            <div className="flex flex-col gap-5">
                {/* URL Input */}
                <div className="group">
                    <label className={`block text-sm font-semibold mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        SSE Endpoint URL
                    </label>
                    <div className="relative">
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
                                w-full pl-12 pr-4 py-3.5 rounded-xl border-2 font-medium
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
                </div>

                {/* Token Input */}
                <div>
                    <label className={`block text-sm font-semibold mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        Bearer Token <span className={`font-normal ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>(optional)</span>
                    </label>
                    <div className="relative">
                        <div className="absolute left-4 top-1/2 -translate-y-1/2 opacity-60">
                            <Lock className="w-5 h-5" />
                        </div>
                        <input
                            type="password"
                            value={bearerToken}
                            onChange={(e) => onTokenChange(e.target.value)}
                            placeholder="Your authentication token"
                            disabled={connected || isLoading}
                            className={`
                                w-full pl-12 pr-4 py-3.5 rounded-xl border-2 font-medium
                                focus:outline-none transition-all duration-300
                                ${isDark
                                    ? 'bg-slate-800/80 border-slate-600/50 text-white placeholder-slate-500 focus:border-sky-500 focus:bg-slate-800'
                                    : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:border-sky-500 focus:bg-white'
                                }
                                ${(connected || isLoading) ? 'opacity-60 cursor-not-allowed' : ''}
                            `}
                        />
                    </div>
                    <p className={`text-xs mt-2 flex items-center gap-1.5 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                        <Lock className="w-3 h-3" />
                        Sent as: <code className="px-1.5 py-0.5 rounded bg-slate-700/30 text-sky-400 font-mono text-xs">Authorization: Bearer &lt;token&gt;</code>
                    </p>
                </div>

                {/* Save Profile */}
                <div>
                    <label className={`block text-sm font-semibold mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        Save as Profile <span className={`font-normal ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>(optional)</span>
                    </label>
                    <div className="flex gap-3">
                        <div className="relative flex-1">
                            <div className="absolute left-4 top-1/2 -translate-y-1/2 opacity-60">
                                <Save className="w-5 h-5" />
                            </div>
                            <input
                                type="text"
                                value={profileName}
                                onChange={(e) => onProfileNameChange(e.target.value)}
                                placeholder="My Production API"
                                disabled={connected || isLoading}
                                className={`
                                    w-full pl-12 pr-4 py-3.5 rounded-xl border-2 font-medium
                                    focus:outline-none transition-all duration-300
                                    ${isDark
                                        ? 'bg-slate-800/80 border-slate-600/50 text-white placeholder-slate-500 focus:border-violet-500 focus:bg-slate-800'
                                        : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:border-violet-500 focus:bg-white'
                                    }
                                    ${(connected || isLoading) ? 'opacity-60 cursor-not-allowed' : ''}
                                `}
                            />
                        </div>
                        <button
                            onClick={onSaveProfile}
                            disabled={connected || isLoading || !profileName.trim()}
                            className={`
                                px-5 py-3.5 rounded-xl font-semibold transition-all duration-300
                                flex items-center gap-2 hover:scale-105
                                ${(connected || isLoading || !profileName.trim())
                                    ? 'bg-slate-700/50 text-slate-500 cursor-not-allowed'
                                    : 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/30 hover:shadow-emerald-500/50'
                                }
                            `}
                        >
                            <Save className="w-4 h-4" /> Save
                        </button>
                    </div>
                </div>

                {/* Error Message */}
                {error && (
                    <div className={`
                        rounded-xl p-4 border-2 flex items-start gap-3 animate-scale-in
                        ${isDark
                            ? 'bg-red-900/20 border-red-500/30 text-red-300'
                            : 'bg-red-50 border-red-300 text-red-700'
                        }
                    `}>
                        <AlertTriangle className="w-6 h-6 shrink-0" />
                        <span className="text-sm font-medium">{error}</span>
                    </div>
                )}

                {/* Status Bar */}
                <div className={`
                    flex items-center justify-between p-4 rounded-xl
                    ${isDark ? 'bg-slate-800/50' : 'bg-slate-100/80'}
                `}>
                    <div className="flex items-center gap-3">
                        <div className={`
                            w-3 h-3 rounded-full transition-all duration-300
                            ${connected
                                ? 'bg-emerald-400 shadow-lg shadow-emerald-400/50 animate-pulse'
                                : isLoading
                                    ? 'bg-amber-400 shadow-lg shadow-amber-400/50 animate-pulse'
                                    : 'bg-slate-500'
                            }
                        `} />
                        <span className={`text-sm font-medium ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                            {connected && <span className="text-emerald-400">Connected</span>}
                            {!connected && isLoading && <span className="text-amber-400">Connecting...</span>}
                            {!connected && !isLoading && <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Disconnected</span>}
                        </span>
                    </div>

                    {connected && (
                        <div className={`
                            flex items-center gap-2 px-4 py-2 rounded-lg font-mono text-sm font-bold
                            ${isDark ? 'bg-slate-700/70 text-emerald-400' : 'bg-slate-200 text-emerald-600'}
                        `}>
                            <Clock className="w-4 h-4" />
                            <span>{formatTime(connectionTime)}</span>
                            <span className={`mx-2 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>|</span>
                            <span>{eventsLength} events</span>
                        </div>
                    )}
                </div>

                {/* Action Buttons */}
                <div className="flex gap-3">
                    <button
                        onClick={onConnect}
                        disabled={connected || isLoading}
                        className={`
                            flex-1 px-6 py-4 rounded-xl font-bold text-base transition-all duration-300
                            flex items-center justify-center gap-2 hover:scale-[1.02]
                            ${(connected || isLoading)
                                ? 'bg-slate-700/50 text-slate-500 cursor-not-allowed'
                                : 'bg-gradient-to-r from-sky-600 via-blue-600 to-cyan-600 text-white shadow-lg shadow-blue-500/30 hover:shadow-blue-500/50'
                            }
                        `}
                    >
                        {isLoading ? (
                            <>
                                <Loader2 className="w-5 h-5 animate-spin" />
                                Connecting...
                            </>
                        ) : (
                            <>
                                <Play className="w-5 h-5" /> Connect
                            </>
                        )}
                    </button>

                    <button
                        onClick={onDisconnect}
                        disabled={!connected && !isLoading}
                        className={`
                            flex-1 px-6 py-4 rounded-xl font-bold text-base transition-all duration-300
                            flex items-center justify-center gap-2 hover:scale-[1.02]
                            ${(!connected && !isLoading)
                                ? 'bg-slate-700/50 text-slate-500 cursor-not-allowed'
                                : isLoading
                                    ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-lg shadow-amber-500/30 hover:shadow-amber-500/50'
                                    : 'bg-gradient-to-r from-red-500 to-rose-500 text-white shadow-lg shadow-red-500/30 hover:shadow-red-500/50'
                            }
                        `}
                    >
                        {isLoading ? (
                            <>
                                <Square className="w-5 h-5" /> Abort
                            </>
                        ) : (
                            <>
                                <Plug className="w-5 h-5" /> Disconnect
                            </>
                        )}
                    </button>

                    <button
                        onClick={onClearEvents}
                        disabled={eventsLength === 0}
                        className={`
                            px-6 py-4 rounded-xl font-bold text-base transition-all duration-300
                            flex items-center justify-center gap-2 hover:scale-[1.02]
                            ${eventsLength === 0
                                ? 'bg-slate-700/50 text-slate-500 cursor-not-allowed'
                                : isDark
                                    ? 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                                    : 'bg-slate-200 hover:bg-slate-300 text-slate-700'
                            }
                        `}
                    >
                        <Trash2 className="w-5 h-5" /> Clear
                    </button>
                </div>
            </div>
        </div>
    )
}
