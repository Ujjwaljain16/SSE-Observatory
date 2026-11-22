import { Play, Pause, SkipBack, SkipForward, Radio } from 'lucide-react'
import type { Theme } from '../types'

interface PlaybackControlsProps {
    theme: Theme
    isPaused: boolean
    onTogglePause: () => void
    onStepForward: () => void
    onStepBackward: () => void
    onGoLive: () => void
    currentEventIndex: number
    totalEvents: number
}

export const PlaybackControls = ({
    theme,
    isPaused,
    onTogglePause,
    onStepForward,
    onStepBackward,
    onGoLive,
    currentEventIndex,
    totalEvents,
}: PlaybackControlsProps) => {
    const isDark = theme === 'dark'
    const isLive = !isPaused && currentEventIndex === 0

    return (
        // Sits inside the timeline strip (fixed, 4rem tall, at the very bottom) instead of standing above it: a bar taller than
        // the strip stuck out over the page content, on top of the toolbar row, wherever that row happened to be.
        <div className={`
            fixed bottom-1.5 left-1/2 -translate-x-1/2
            flex items-center gap-2 p-1.5 rounded-2xl shadow-2xl border backdrop-blur-xl z-50
            transition-all duration-300 animate-slide-up
            ${isDark
                ? 'bg-slate-900/90 border-slate-700/50 shadow-black/40'
                : 'bg-white/90 border-slate-200/50 shadow-slate-300/40'
            }
        `}>

            <button
                onClick={onStepBackward}
                disabled={currentEventIndex >= totalEvents - 1}
                className={`p-2 rounded-xl transition-colors ${isDark
                    ? 'hover:bg-slate-800 text-slate-400 disabled:opacity-30'
                    : 'hover:bg-slate-100 text-slate-600 disabled:opacity-30'
                    }`}
                aria-label="Previous Event" title="Previous Event"
            >
                <SkipBack className="w-5 h-5" />
            </button>


            <button
                onClick={onTogglePause}
                className={`
                    w-10 h-10 flex items-center justify-center rounded-xl transition-all
                    ${isPaused
                        ? 'bg-amber-500 hover:bg-amber-700 text-white shadow-lg shadow-amber-500/20'
                        : 'bg-slate-200 hover:bg-slate-300 text-slate-700 shadow-inner'
                    }
                `}
                aria-label={isPaused ? "Resume Stream" : "Pause Stream"} title={isPaused ? "Resume Stream" : "Pause Stream"}
            >
                {isPaused ? <Play className="w-5 h-5 fill-current" /> : <Pause className="w-5 h-5 fill-current" />}
            </button>


            <button
                onClick={onStepForward}
                disabled={currentEventIndex === 0}
                className={`p-2 rounded-xl transition-colors ${isDark
                    ? 'hover:bg-slate-800 text-slate-400 disabled:opacity-30'
                    : 'hover:bg-slate-100 text-slate-600 disabled:opacity-30'
                    }`}
                aria-label="Next Event" title="Next Event"
            >
                <SkipForward className="w-5 h-5" />
            </button>

            <div className={`w-px h-8 mx-1 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />


            <button
                onClick={onGoLive}
                disabled={isLive}
                className={`
                    flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all
                    ${isLive
                        ? (isDark ? 'bg-red-500/20 text-red-300 cursor-default' : 'bg-red-100 text-red-800 cursor-default')
                        : isDark
                            ? 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900'
                    }
                `}
            >
                <Radio className={`w-3 h-3 ${isLive ? 'animate-pulse' : ''}`} />
                {isLive ? 'LIVE' : 'Go Live'}
            </button>


            <div className={`ml-2 text-xs font-mono tabular-nums ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                {currentEventIndex > 0 && `-${currentEventIndex} events ago`}
            </div>
        </div>
    )
}
