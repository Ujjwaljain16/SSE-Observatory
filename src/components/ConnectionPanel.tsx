import { useState, useEffect } from 'react'
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
    reconnecting?: boolean
    isLoading: boolean
    error: string
    /** Epoch ms when the current connection opened (null while not connected). */
    connectedAt: number | null
    eventsLength: number
    onUrlChange: (url: string) => void
    onTokenChange: (token: string) => void
    onProfileNameChange: (name: string) => void
    onSaveProfile: (rememberToken: boolean) => void
    onConnect: () => void
    onDisconnect: () => void
    onClearEvents: () => void
    useProxy: boolean
    onProxyToggle: (v: boolean) => void
}

export const ConnectionPanel = ({
    theme,
    url,
    bearerToken,
    profileName,
    connected,
    reconnecting = false,
    isLoading,
    error,
    connectedAt,
    eventsLength,
    onUrlChange,
    onTokenChange,
    onProfileNameChange,
    onSaveProfile,
    onConnect,
    onDisconnect,
    onClearEvents,
    useProxy,
    onProxyToggle
}: ConnectionPanelProps) => {
    const isDark = theme === 'dark'
    // The stream is "in use" while connected, connecting, or waiting to retry: the form is locked and the button cancels.
    const busy = connected || reconnecting || isLoading
    const [saveOpen, setSaveOpen] = useState(false)
    const [rememberToken, setRememberToken] = useState(false)

    // Elapsed time ticks locally so the rest of the app does not re-render every second.
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (connectedAt === null) return
        setNow(Date.now())
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
    }, [connectedAt])
    const connectionTime = connectedAt === null ? 0 : Math.max(0, Math.floor((now - connectedAt) / 1000))

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
                        data-testid="url-input"
                        disabled={busy}
                        className={`
                            w-full pl-12 pr-4 py-3 rounded-xl border-2 font-medium text-sm
                            focus:outline-none transition-all duration-300
                            ${isDark
                                ? 'bg-slate-800/80 border-slate-600/50 text-white placeholder-slate-500 focus:border-sky-500 focus:bg-slate-800'
                                : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:border-sky-500 focus:bg-white'
                            }
                            ${busy ? 'opacity-60 cursor-not-allowed' : ''}
                        `}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !busy) {
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
                        data-testid="token-input"
                        disabled={busy}
                        className={`
                            w-full pl-12 pr-4 py-3 rounded-xl border-2 font-medium text-sm
                            focus:outline-none transition-all duration-300
                            ${isDark
                                ? 'bg-slate-800/80 border-slate-600/50 text-white placeholder-slate-500 focus:border-sky-500 focus:bg-slate-800'
                                : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:border-sky-500 focus:bg-white'
                            }
                            ${busy ? 'opacity-60 cursor-not-allowed' : ''}
                        `}
                    />
                </div>

                <div className="flex gap-2 w-full lg:w-auto">
                    <button
                        onClick={busy ? onDisconnect : onConnect}
                        data-testid="connect-button"
                        disabled={!busy && !url.trim()}
                        className={`
                            flex-1 lg:flex-none lg:w-32 px-4 py-3 rounded-xl font-bold text-sm transition-all duration-300
                            flex items-center justify-center gap-2 hover:scale-[1.02]
                            ${(!busy && !url.trim())
                                ? isDark ? 'bg-slate-700 text-slate-400 opacity-50 cursor-not-allowed' : 'bg-slate-200 text-slate-500 opacity-50 cursor-not-allowed'
                                : busy
                                    ? 'bg-gradient-to-r from-red-500 to-rose-500 text-white shadow-lg shadow-red-500/30'
                                    : 'bg-gradient-to-r from-sky-600 via-blue-600 to-cyan-600 text-white shadow-lg shadow-blue-500/30'
                            }
                        `}
                    >
                        <span className="flex items-center justify-center gap-2">
                            {isLoading || reconnecting ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : connected ? (
                                <Square className="w-4 h-4" />
                            ) : (
                                <Play className="w-4 h-4" />
                            )}
                            <span className="whitespace-nowrap">
                                {isLoading ? 'Cancel' : busy ? 'Stop' : 'Connect'}
                            </span>
                        </span>
                    </button>
                    {!busy && (
                        <div className="relative">
                            <button
                                onClick={() => setSaveOpen((o) => !o)}
                                disabled={!url.trim()}
                                aria-label="Save profile"
                                aria-expanded={saveOpen}
                                aria-haspopup="dialog"
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
                            {saveOpen && (
                                <form
                                    role="dialog"
                                    aria-label="Save profile"
                                    onSubmit={(e) => {
                                        e.preventDefault()
                                        if (!profileName.trim()) return
                                        onSaveProfile(rememberToken)
                                        setSaveOpen(false)
                                    }}
                                    onKeyDown={(e) => { if (e.key === 'Escape') setSaveOpen(false) }}
                                    className="absolute right-0 top-14 flex flex-col gap-2 p-3 rounded-lg border shadow-xl bg-white dark:bg-slate-800 dark:border-slate-700 z-10 w-72"
                                >
                                    <input
                                        autoFocus
                                        type="text"
                                        value={profileName}
                                        onChange={(e) => onProfileNameChange(e.target.value)}
                                        placeholder="Profile name"
                                        aria-label="Profile name"
                                        className="px-3 py-1.5 text-sm rounded bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-white border-0 focus:ring-2 focus:ring-sky-500"
                                    />
                                    {bearerToken && (
                                        <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-400">
                                            <input type="checkbox" checked={rememberToken} onChange={(e) => setRememberToken(e.target.checked)} className="mt-0.5" />
                                            <span>Also store the token in this browser (plain text in localStorage). Leave off to keep it out of storage.</span>
                                        </label>
                                    )}
                                    <button
                                        type="submit"
                                        disabled={!profileName.trim()}
                                        className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-semibold rounded bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
                                    >
                                        <Check className="w-4 h-4" /> Save
                                    </button>
                                </form>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Proxy Toggle */}
            <div className="mt-4 mb-2 flex items-center gap-3">
                <button
                    role="switch"
                    aria-checked={useProxy}
                    aria-label="Use server proxy"
                    onClick={() => onProxyToggle(!useProxy)}
                    className={`
                        relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none
                        ${useProxy ? 'bg-sky-600' : (isDark ? 'bg-slate-700' : 'bg-slate-300')}
                    `}
                >
                    <span
                        className={`
                            inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200
                            ${useProxy ? 'translate-x-6' : 'translate-x-1'}
                        `}
                    />
                </button>
                <div className="flex flex-col">
                    <span className={`text-sm font-bold flex items-center gap-1.5 ${isDark ? 'text-slate-200' : 'text-slate-900'}`}>
                        Use Server Proxy
                        {useProxy && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-400 font-mono">ENCRYPTED</span>}
                    </span>
                    <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        {useProxy ? 'Routes through production proxy (bypasses CORS)' : 'Direct connection (requires CORS or localhost)'}
                    </span>
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
                            <div className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)] animate-pulse' : (isLoading || reconnecting) ? 'bg-amber-400 animate-pulse' : 'bg-slate-400'}`} />
                            <span
                                data-testid="connection-status"
                                className={`text-sm font-semibold ${connected ? 'text-emerald-600 dark:text-emerald-400' : isDark ? 'text-slate-400' : 'text-slate-500'}`}
                            >
                                {connected ? (
                                    <span>Connected to <span className="text-slate-700 dark:text-slate-300 font-mono ml-1">{(() => { try { return new URL(url).hostname } catch { return 'Endpoint' } })()}</span></span>
                                ) : isLoading ? 'Connecting...' : reconnecting ? 'Reconnecting...' : 'Disconnected'}
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
