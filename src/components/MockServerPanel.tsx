import type { Theme } from '../types'
import { Upload, Play, Square, Loader2, Server, Repeat } from 'lucide-react'

interface MockServerPanelProps {
    theme: Theme
    fileName: string | null
    isUploading: boolean
    isServerRunning: boolean
    speedMs: number
    isLooping: boolean
    totalEvents: number
    onFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => void
    onToggleServer: () => Promise<string | null>
    onSetSpeed: (speed: number) => void
    onToggleLooping: () => void
}

export const MockServerPanel = ({
    theme,
    fileName,
    isUploading,
    isServerRunning,
    speedMs,
    isLooping,
    totalEvents,
    onFileUpload,
    onToggleServer,
    onSetSpeed,
    onToggleLooping
}: MockServerPanelProps) => {
    const isDark = theme === 'dark'

    const mockUrl = `http://localhost:3001/api/mock/stream?speed=${speedMs}&loop=${isLooping}`
    const curlCommand = `curl -N "${mockUrl}"`

    return (
        <div className={`
            p-6 rounded-2xl border animate-slide-up mb-6
            backdrop-blur-xl transition-all duration-300
            ${isDark
                ? 'bg-slate-900/70 border-slate-700/50 shadow-xl shadow-black/20'
                : 'bg-white border-slate-200 shadow-xl shadow-slate-300/20'
            }
        `}>
            <div className="flex items-center gap-3 mb-6">
                <div className={`
                    w-12 h-12 rounded-xl flex items-center justify-center
                    bg-gradient-to-br from-purple-500 to-indigo-600 shadow-lg shadow-purple-500/30
                `}>
                    <Server className="w-6 h-6 text-white" />
                </div>
                <div>
                    <h2 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        Mock Server Engine
                    </h2>
                    <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        Replay exported records to local applications
                    </p>
                </div>
            </div>

            <div className={`
                p-6 rounded-xl border border-dashed mb-6 transition-colors
                flex flex-col items-center justify-center text-center outline-none
                ${isDark
                    ? 'border-slate-700 bg-slate-800/30 hover:bg-slate-800/50 hover:border-purple-500/50'
                    : 'border-slate-300 bg-slate-50 hover:bg-slate-100 hover:border-purple-400'
                }
            `}>
                <Upload className={`w-8 h-8 mb-3 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                <h3 className={`text-lg font-semibold mb-1 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                    {fileName ? fileName : 'Upload .sse-record File'}
                </h3>
                <p className={`text-sm mb-4 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                    {totalEvents > 0 ? `${totalEvents} events loaded` : "Drag and drop or click to browse"}
                </p>

                <label className={`
                    cursor-pointer px-5 py-2.5 rounded-xl font-medium text-sm transition-all
                    ${isDark
                        ? 'bg-slate-700 hover:bg-slate-600 text-white'
                        : 'bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 shadow-sm'
                    }
                `}>
                    <span key="upload-icon-wrapper">
                        {isUploading ? <Loader2 key="icon-loading-upload" className="w-4 h-4 animate-spin inline-block mr-2" /> : null}
                    </span>
                    {fileName ? 'Replace File' : 'Select File'}
                    <input type="file" accept=".sse-record,.json" className="hidden" onChange={onFileUpload} />
                </label>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                <div className="flex flex-col gap-4 justify-center">
                    <button
                        onClick={onToggleServer}
                        disabled={!fileName && !isServerRunning}
                        className={`
                            w-full py-4 rounded-xl font-bold flex flex-col items-center justify-center transition-all duration-300 gap-2
                            ${!fileName && !isServerRunning
                                ? 'bg-slate-800/50 text-slate-600 cursor-not-allowed'
                                : isServerRunning
                                    ? 'bg-gradient-to-r from-red-600 to-rose-600 text-white shadow-lg shadow-red-500/30 hover:scale-[1.02]'
                                    : 'bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow-lg shadow-emerald-500/30 hover:scale-[1.02]'
                            }
                        `}
                    >
                        {isServerRunning ? (
                            <span key="stop-wrapper" className="flex flex-col items-center gap-2">
                                <Square key="icon-stop" className="w-6 h-6" fill="currentColor" />
                                <span>Stop Mock Server</span>
                            </span>
                        ) : (
                            <span key="start-wrapper" className="flex flex-col items-center gap-2">
                                <Play key="icon-start" className="w-6 h-6" fill="currentColor" />
                                <span>Start Mock Server</span>
                            </span>
                        )}
                    </button>


                    <div className="flex gap-2 w-full">
                        <button
                            onClick={onToggleLooping}
                            className={`flex-[1] py-2 rounded-lg border text-sm font-semibold flex items-center justify-center gap-2 transition-all
                                ${isLooping
                                    ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-400'
                                    : isDark ? 'bg-slate-800 border-slate-700 text-slate-400' : 'bg-white border-slate-300 text-slate-600'
                                }
                            `}
                        >
                            <Repeat className="w-4 h-4" /> Loop
                        </button>
                        <div className={`flex-[2] flex border rounded-lg overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-300'}`}>
                            {[0.5, 1, 2].map((s) => (
                                <button
                                    key={s}
                                    onClick={() => onSetSpeed(s)}
                                    className={`flex-1 py-2 text-xs font-bold transition-all
                                        ${speedMs === s
                                            ? 'bg-sky-500 text-white'
                                            : isDark ? 'bg-slate-800 text-slate-400 hover:bg-slate-700' : 'bg-white text-slate-600 hover:bg-slate-50'
                                        }
                                        ${s !== 2 && (isDark ? 'border-r border-slate-700' : 'border-r border-slate-300')}
                                    `}
                                >
                                    {s}x
                                </button>
                            ))}
                        </div>
                    </div>
                </div>


                <div className={`
                    p-5 rounded-xl border
                    ${isDark ? 'bg-slate-900/90 border-slate-700/50' : 'bg-slate-50 border-slate-200'}
                 `}>
                    <h4 className={`text-sm font-bold mb-3 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Connection Credentials</h4>

                    <div className="mb-4">
                        <label className={`block text-xs font-semibold mb-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>Mock URL</label>
                        <code className={`block w-full text-xs p-2.5 rounded-lg border overflow-x-auto whitespace-nowrap
                            ${isDark ? 'bg-black/50 border-slate-700 text-sky-400' : 'bg-white border-slate-300 text-blue-600'}
                        `}>
                            {mockUrl}
                        </code>
                    </div>

                    <div>
                        <label className={`block text-xs font-semibold mb-1 flex items-center gap-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                            Test via cURL
                        </label>
                        <code className={`block w-full text-xs p-2.5 rounded-lg border overflow-x-auto whitespace-nowrap
                            ${isDark ? 'bg-black/50 border-slate-700 text-emerald-400' : 'bg-white border-slate-300 text-emerald-600'}
                        `}>
                            {curlCommand}
                        </code>
                    </div>

                    {isServerRunning && (
                        <div className="mt-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                            <span className="text-xs font-bold text-emerald-500">Broadcasting locally on port 3001</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
