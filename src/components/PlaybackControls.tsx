import { Play, Pause, SkipBack, SkipForward, Radio } from 'lucide-react'
import type { Theme } from '../types'

interface PlaybackControlsProps {
    theme: Theme
    isPaused: boolean
    playbackSpeed: number
    currentEventIndex: number
    totalEvents: number
    onTogglePause: () => void
    onStepForward: () => void
    onStepBackward: () => void
    onGoLive: () => void
    onSetSpeed: (speed: number) => void
    // onSeek: (index: number) => void // Removed as it is handled by Timeline
}

export const PlaybackControls = ({
    theme,
    isPaused,
    playbackSpeed,
    currentEventIndex,
    totalEvents,
    onTogglePause,
    onStepForward,
    onStepBackward,
    onGoLive,
    onSetSpeed,
    // onSeek
}: PlaybackControlsProps) => {
    const isDark = theme === 'dark'
    const isLive = !isPaused && currentEventIndex === 0

    return (
        <div className={`
            fixed bottom-6 left-1/2 -translate-x-1/2 
            flex items-center gap-2 p-2 rounded-2xl shadow-2xl border backdrop-blur-xl z-50
            transition-all duration-300 animate-slide-up
            ${isDark
                ? 'bg-slate-900/90 border-slate-700/50 shadow-black/40'
                : 'bg-white/90 border-slate-200/50 shadow-slate-300/40'
            }
        `}>
            {/* Step Backward (Older) */}
            <button
                onClick={onStepBackward}
                disabled={currentEventIndex >= totalEvents - 1}
                className={`p-2 rounded-xl transition-colors ${isDark
                    ? 'hover:bg-slate-800 text-slate-400 disabled:opacity-30'
                    : 'hover:bg-slate-100 text-slate-600 disabled:opacity-30'
                    }`}
                title="Previous Event"
            >
                <SkipBack className="w-5 h-5" />
            </button>

            {/* Play/Pause */}
            <button
                onClick={onTogglePause}
                className={`
                    w-12 h-12 flex items-center justify-center rounded-xl transition-all
                    ${isPaused
                        ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-lg shadow-amber-500/20'
                        : 'bg-slate-200 hover:bg-slate-300 text-slate-700 shadow-inner'
                    }
                `}
                title={isPaused ? "Resume Stream" : "Pause Stream"}
            >
                {isPaused ? <Play className="w-6 h-6 fill-current" /> : <Pause className="w-6 h-6 fill-current" />}
            </button>

            {/* Step Forward (Newer) */}
            <button
                onClick={onStepForward}
                disabled={currentEventIndex === 0}
                className={`p-2 rounded-xl transition-colors ${isDark
                    ? 'hover:bg-slate-800 text-slate-400 disabled:opacity-30'
                    : 'hover:bg-slate-100 text-slate-600 disabled:opacity-30'
                    }`}
                title="Next Event"
            >
                <SkipForward className="w-5 h-5" />
            </button>

            <div className={`w-px h-8 mx-1 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`} />

            {/* Speed Control */}
            <button
                onClick={() => onSetSpeed(playbackSpeed === 1 ? 2 : playbackSpeed === 2 ? 4 : 1)}
                className={`
                    flex items-center justify-center w-8 h-8 rounded-lg text-xs font-bold transition-all
                    ${isDark
                        ? 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                        : 'bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-900'
                    }
                `}
                title="Playback Speed"
            >
                {playbackSpeed}x
            </button>


            {/* Live Indicator / Button */}
            <button
                onClick={onGoLive}
                disabled={isLive}
                className={`
                    flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all
                    ${isLive
                        ? 'bg-red-500/20 text-red-500 cursor-default'
                        : isDark
                            ? 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-900'
                    }
                `}
            >
                <Radio className={`w-3 h-3 ${isLive ? 'animate-pulse' : ''}`} />
                {isLive ? 'LIVE' : 'Go Live'}
            </button>

            {/* Event Counter / Scrubber info */}
            <div className={`ml-2 text-xs font-mono tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {currentEventIndex === 0 ? 'Latest' : `-${currentEventIndex} events ago`}
            </div>
        </div>
    )
}
