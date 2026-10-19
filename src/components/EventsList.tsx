import { memo, useState, useRef, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Theme, EventMessage, CustomFilter } from '../types'
import type { TraceEntry } from '../hooks/useCorrelationTracker'
import { Inbox, Radio, Clock, Hash, Copy, Check, MessageSquare, SplitSquareHorizontal, GitBranch } from 'lucide-react'
import { JsonDiffView } from './JsonDiffView'
import { prettyPayload, diffPayload } from '../utils/displayData'

interface EventsListProps {
    theme: Theme
    connected: boolean
    filteredEvents: EventMessage[]
    customFilters: CustomFilter[]
    copiedId: string | null
    isLive: boolean
    onCopyToClipboard: (text: string, eventId: string) => void
    getTraceForEvent?: (event: EventMessage) => TraceEntry | null
    onViewTrace?: (traceId: string) => void
}

const getTypeTheme = (type: string) => {
    const themes: Record<string, { bg: string; text: string; border: string; glow: string }> = {
        message: {
            bg: 'from-sky-500/20 to-blue-500/20',
            text: 'text-sky-300',
            border: 'border-sky-500/30',
            glow: 'shadow-sky-500/20'
        },
        update: {
            bg: 'from-cyan-500/20 to-blue-500/20',
            text: 'text-cyan-300',
            border: 'border-cyan-500/30',
            glow: 'shadow-cyan-500/20'
        },
        ping: {
            bg: 'from-amber-500/20 to-yellow-500/20',
            text: 'text-amber-300',
            border: 'border-amber-500/30',
            glow: 'shadow-amber-500/20'
        },
        error: {
            bg: 'from-red-500/20 to-rose-500/20',
            text: 'text-red-300',
            border: 'border-red-500/30',
            glow: 'shadow-red-500/20'
        },
        default: {
            bg: 'from-slate-500/20 to-gray-500/20',
            text: 'text-slate-300',
            border: 'border-slate-500/30',
            glow: 'shadow-slate-500/20'
        }
    }
    return themes[type.toLowerCase()] || themes.default
}

export const EventsList = memo(function EventsList({
    theme,
    connected,
    filteredEvents,
    customFilters,
    copiedId,
    isLive,
    onCopyToClipboard,
    getTraceForEvent,
    onViewTrace,
}: EventsListProps) {
    const isDark = theme === 'dark'
    const [diffEventId, setDiffEventId] = useState<string | null>(null)
    const scrollContainerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (isLive && scrollContainerRef.current) {
            scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' })
        }
    }, [isLive])

    const rowVirtualizer = useVirtualizer({
        count: filteredEvents.length,
        getScrollElement: () => scrollContainerRef.current,
        estimateSize: () => 180,
        overscan: 5,
    })

    return (
        <div className={`
            rounded-2xl overflow-hidden animate-slide-up
            backdrop-blur-xl border transition-all duration-300
            ${isDark
                ? 'bg-slate-900/70 border-slate-700/50 shadow-xl shadow-black/20'
                : 'bg-white/80 border-slate-200/70 shadow-xl shadow-slate-300/20'
            }
        `}>
            <div className={`
                px-6 py-4 border-b flex items-center justify-between
                ${isDark
                    ? 'bg-gradient-to-r from-slate-800/80 to-slate-900/80 border-slate-700/50'
                    : 'bg-gradient-to-r from-slate-50 to-slate-100 border-slate-200/70'
                }
            `}>
                <div className="flex items-center gap-3">
                    <div className={`
                        w-10 h-10 rounded-xl flex items-center justify-center
                        ${isDark ? 'bg-slate-700/70' : 'bg-slate-200'}
                    `}>
                        <MessageSquare className={`w-5 h-5 ${isDark ? 'text-sky-400' : 'text-sky-600'}`} />
                    </div>
                    <div>
                        <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                            Event Stream
                        </h2>
                        <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                            {filteredEvents.length} events captured
                        </p>
                    </div>
                </div>

                {connected && (
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/20 border border-emerald-500/30">
                        <div className="live-dot" />
                        <span className="text-xs font-semibold text-emerald-400">LIVE</span>
                    </div>
                )}
            </div>

            {filteredEvents.length === 0 ? (
                <div className="px-6 py-16 text-center">
                    <div className={`
                        w-20 h-20 mx-auto mb-4 rounded-2xl flex items-center justify-center
                        ${isDark ? 'bg-slate-800/50' : 'bg-slate-100'}
                    `}>
                        {connected ? (
                            <Radio className={`w-10 h-10 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
                        ) : (
                            <Inbox className={`w-10 h-10 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
                        )}
                    </div>
                    <p className={`text-base font-medium mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        {connected
                            ? customFilters.some(f => f.activeValues.size > 0)
                                ? 'No matching events'
                                : 'Waiting for events...'
                            : 'No events yet'}
                    </p>
                    <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        {connected
                            ? 'Events will appear here as they arrive'
                            : 'Connect to an SSE endpoint to start monitoring'}
                    </p>
                </div>
            ) : (
                <div
                    ref={scrollContainerRef}
                    className="h-[600px] overflow-y-auto p-4 relative"
                >
                    <div
                        style={{
                            height: `${rowVirtualizer.getTotalSize()}px`,
                            width: '100%',
                            position: 'relative',
                        }}
                    >
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                            const index = virtualRow.index
                            const event = filteredEvents[index]
                            const typeTheme = getTypeTheme(event.parsedType || event.type)
                            const isNewest = isLive && index === 0
                            const prevEvent = index + 1 < filteredEvents.length ? filteredEvents[index + 1] : null
                            const isDiffActive = diffEventId === event.id
                            const trace = getTraceForEvent ? getTraceForEvent(event) : null

                            return (
                                <div
                                    key={event.id}
                                    data-index={virtualRow.index}
                                    ref={rowVirtualizer.measureElement}
                                    className="absolute top-0 left-0 w-full"
                                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                                >
                                    <div className="mb-3">
                                        <div
                                            data-testid="event-row"
                                            className={`
                                                group relative rounded-xl p-4 border transition-all duration-300
                                                hover:scale-[1.01] cursor-default
                                                ${isDark
                                                    ? `bg-gradient-to-br ${typeTheme.bg} ${typeTheme.border} hover:shadow-lg ${typeTheme.glow}`
                                                    : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-md'
                                                }
                                                ${isNewest ? 'animate-scale-in ring-2 ring-sky-500/30' : ''}
                                            `}
                                        >
                                            <div className="flex items-center justify-between gap-4 mb-3 flex-wrap">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className={`
                                                        inline-flex items-center gap-1 text-xs font-mono px-2.5 py-1 rounded-lg font-semibold
                                                        ${isDark
                                                            ? 'bg-slate-800/80 text-slate-300 border border-slate-700/50'
                                                            : 'bg-slate-100 text-slate-700'
                                                        }
                                                    `}>
                                                        <Hash className="w-3 h-3 opacity-50" />
                                                        {event.id}
                                                    </span>

                                                    {event.streamId && event.streamColor && (
                                                        <span
                                                            className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-md"
                                                            style={{
                                                                backgroundColor: `${event.streamColor}22`,
                                                                color: event.streamColor,
                                                                border: `1px solid ${event.streamColor}44`,
                                                            }}
                                                        >
                                                            <span
                                                                className="w-1.5 h-1.5 rounded-full inline-block"
                                                                style={{ backgroundColor: event.streamColor }}
                                                            />
                                                            {event.streamId.split('-').slice(0, 2).join('-')}
                                                        </span>
                                                    )}

                                                    {trace && onViewTrace && (
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); onViewTrace(trace.id) }}
                                                            title={`View trace: ${trace.id} (${trace.events.length} events)`}
                                                            className="inline-flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded-md cursor-pointer transition-all hover:scale-105"
                                                            style={{
                                                                backgroundColor: 'rgba(99,102,241,0.15)',
                                                                color: '#a5b4fc',
                                                                border: '1px solid rgba(99,102,241,0.3)',
                                                            }}
                                                        >
                                                            <GitBranch className="w-3 h-3" />
                                                            {trace.id.slice(0, 8)}…
                                                        </button>
                                                    )}

                                                    <span className={`
                                                        inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-lg
                                                        ${isDark ? 'text-slate-400' : 'text-slate-500'}
                                                    `}>
                                                        <Clock className="w-3 h-3" />
                                                        {event.timestamp}
                                                    </span>

                                                    {event.parsedType && (
                                                        <span className={`
                                                            text-xs px-2.5 py-1 rounded-lg font-bold uppercase tracking-wide
                                                            bg-gradient-to-r from-sky-500 to-blue-500 text-white
                                                            shadow-sm shadow-blue-500/30
                                                        `}>
                                                            {event.parsedType}
                                                        </span>
                                                    )}

                                                    <span className={`
                                                        text-xs px-2 py-1 rounded-lg font-medium
                                                        ${isDark
                                                            ? 'bg-slate-800/60 text-slate-400 border border-slate-700/50'
                                                            : 'bg-slate-200 text-slate-600'
                                                        }
                                                    `}>
                                                        {event.type}
                                                    </span>

                                                    {isNewest && (
                                                        <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-semibold border border-emerald-500/30 animate-pulse">
                                                            NEW
                                                        </span>
                                                    )}
                                                </div>

                                                <div className="flex gap-2">
                                                    {prevEvent && (
                                                        <button
                                                            onClick={() => setDiffEventId(isDiffActive ? null : event.id)}
                                                            className={`
                                                                px-3 py-1.5 text-xs rounded-lg font-semibold transition-all duration-300
                                                                flex items-center gap-1.5 hover:scale-105
                                                                ${isDiffActive
                                                                    ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/30'
                                                                    : isDark
                                                                        ? 'bg-slate-700/70 hover:bg-slate-600 text-slate-300 border border-slate-600/50'
                                                                        : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                                                                }
                                                            `}
                                                            aria-label="Compare with previous event in list" title="Compare with previous event in list"
                                                        >
                                                            <SplitSquareHorizontal className="w-3 h-3" />
                                                            {isDiffActive ? 'Hide Diff' : 'Compare'}
                                                        </button>
                                                    )}

                                                    <button
                                                        onClick={() => onCopyToClipboard(event.data, event.id)}
                                                        className={`
                                                            px-3 py-1.5 text-xs rounded-lg font-semibold transition-all duration-300
                                                            flex items-center gap-1.5 hover:scale-105
                                                            ${copiedId === event.id
                                                                ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/30'
                                                                : isDark
                                                                    ? 'bg-slate-700/70 hover:bg-slate-600 text-slate-300 border border-slate-600/50'
                                                                    : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                                                            }
                                                        `}
                                                    >
                                                        {copiedId === event.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                                        {copiedId === event.id ? 'Copied!' : 'Copy'}
                                                    </button>
                                                </div>
                                            </div>

                                            <div className={`
                                                rounded-xl p-4 font-mono text-sm overflow-x-auto
                                                ${isDark
                                                    ? 'bg-slate-900/60 border border-slate-700/30'
                                                    : 'bg-slate-50 border border-slate-200'
                                                }
                                            `}>
                                                <pre className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                                    {prettyPayload(event)}
                                                </pre>
                                            </div>

                                            {isDiffActive && prevEvent && (
                                                <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700/50 animate-slide-up">
                                                    <JsonDiffView
                                                        theme={theme}
                                                        oldData={diffPayload(prevEvent)}
                                                        newData={diffPayload(event)}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </div>
            )}
        </div>
    )
})
