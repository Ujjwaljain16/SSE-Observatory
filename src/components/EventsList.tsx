import { memo, useState, useRef, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Theme, EventMessage, CustomFilter } from '../types'
import type { TraceEntry } from '../hooks/useCorrelationTracker'
import type { EventJump, JumpResult } from '../context/UIContext'
import { Inbox, Radio, Clock, Hash, Copy, Check, MessageSquare, SplitSquareHorizontal, GitBranch, Layers } from 'lucide-react'
import { JsonDiffView } from './JsonDiffView'
import { HighlightedJson, JsonTree } from './JsonViewer'
import { prettyPayload, diffPayload } from '../utils/displayData'
import { getParsedData } from '../utils/eventUtils'
import { formatRate, toRows, type EventRow } from '../utils/eventStats'
import { shapeOf } from '../utils/jsonView'
import { shownFor } from '../doctor/displayMapping'
import { getProfile, subscribeProfile } from '../doctor/profileStore'

type PayloadView = 'json' | 'tree' | 'raw'
const COLLAPSE_KEY = 'sse.collapseRepeats'
const readCollapse = (): boolean => { try { return localStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false } }
/** The key of a row that does not change when newer identical events join its run (the oldest member). */
const rowKey = (row: EventRow): string => row.members[row.members.length - 1]!.id

interface EventsListProps {
    theme: Theme
    connected: boolean
    filteredEvents: EventMessage[]
    customFilters: CustomFilter[]
    copiedId: string | null
    isLive: boolean
    /** Events per second over the last few seconds, when the caller measures it. */
    ratePerSecond?: number | undefined
    onCopyToClipboard: (text: string, eventId: string) => void
    getTraceForEvent?: (event: EventMessage) => TraceEntry | null
    onViewTrace?: (traceId: string) => void
    /** Show one event (asked for by the Doctor): scroll to it and mark it for a moment. */
    jumpTarget?: EventJump | null
    onJumpResult?: (result: JumpResult) => void
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
    jumpTarget,
    onJumpResult,
    ratePerSecond,
}: EventsListProps) {
    const isDark = theme === 'dark'
    const [diffEventId, setDiffEventId] = useState<string | null>(null)
    const scrollContainerRef = useRef<HTMLDivElement>(null)
    const wrapperRef = useRef<HTMLDivElement>(null)
    const [highlightId, setHighlightId] = useState<string | null>(null)
    const display = useSyncExternalStore(subscribeProfile, getProfile, () => undefined)?.display
    const [collapse, setCollapse] = useState(readCollapse)
    const [views, setViews] = useState<Record<string, PayloadView>>({})
    const rows = useMemo(() => toRows(filteredEvents, collapse), [filteredEvents, collapse])
    const hidden = filteredEvents.length - rows.length
    const toggleCollapse = (on: boolean) => {
        setCollapse(on)
        try { localStorage.setItem(COLLAPSE_KEY, on ? '1' : '0') } catch { /* not kept: the choice still applies to this page */ }
    }

    useEffect(() => {
        if (isLive && scrollContainerRef.current) {
            scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' })
        }
    }, [isLive])

    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollContainerRef.current,
        estimateSize: () => 180,
        overscan: 5,
        // New events are prepended, so an index points at a different event every frame. Key the measured heights by
        // event id, otherwise each row gets some other row's height (overlapping rows and gaps).
        getItemKey: (index) => (rows[index] ? rowKey(rows[index]!) : index),
    })

    // The Doctor asked to see an event. It may be gone (the list keeps the latest 1000) or hidden by a filter.
    // A collapsed run counts: the event is one of the identical events the row stands for.
    useEffect(() => {
        if (!jumpTarget) return
        const wanted = (e: EventMessage) => e.obsSeq === jumpTarget.obsSeq && (jumpTarget.streamId === 'main' ? e.streamId === undefined : e.streamId === jumpTarget.streamId)
        const index = rows.findIndex((r) => r.members.some(wanted))
        if (index < 0) { onJumpResult?.('missing'); return }
        onJumpResult?.('found')
        wrapperRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' })
        rowVirtualizer.scrollToIndex(index, { align: 'center' })
        const id = rowKey(rows[index]!)
        setHighlightId(id)
        const timer = setTimeout(() => setHighlightId((current) => (current === id ? null : current)), 4000)
        return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per request, not whenever events arrive
    }, [jumpTarget?.nonce])

    return (
        <div ref={wrapperRef} className={`
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
                        <p data-testid="event-count" className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                            {filteredEvents.length} events captured
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-4 flex-wrap justify-end">
                    {connected && ratePerSecond !== undefined && (
                        <span data-testid="event-rate" className={`text-xs font-medium tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                            {formatRate(ratePerSecond)}
                        </span>
                    )}
                    <label className={`flex items-center gap-2 text-xs font-medium cursor-pointer ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        <input
                            type="checkbox"
                            data-testid="collapse-repeats"
                            checked={collapse}
                            onChange={(e) => toggleCollapse(e.target.checked)}
                            className="rounded"
                        />
                        <Layers className="w-3.5 h-3.5" aria-hidden="true" />
                        Collapse repeats
                        {collapse && hidden > 0 && <span data-testid="collapsed-count" className="opacity-80">({hidden} folded)</span>}
                    </label>
                    {connected && (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/20 border border-emerald-500/30">
                            <div className="live-dot" />
                            <span className="text-xs font-semibold text-emerald-400">LIVE</span>
                        </div>
                    )}
                </div>
            </div>

            {filteredEvents.length === 0 ? (
                <div className="px-6 py-16 text-center">
                    <div className={`
                        w-20 h-20 mx-auto mb-4 rounded-2xl flex items-center justify-center
                        ${isDark ? 'bg-slate-800/50' : 'bg-slate-100'}
                    `}>
                        {connected ? (
                            <Radio className={`w-10 h-10 ${isDark ? 'text-slate-600' : 'text-slate-600'}`} />
                        ) : (
                            <Inbox className={`w-10 h-10 ${isDark ? 'text-slate-600' : 'text-slate-600'}`} />
                        )}
                    </div>
                    <p className={`text-base font-medium mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        {connected
                            ? customFilters.some(f => f.activeValues.size > 0)
                                ? 'No matching events'
                                : 'Waiting for events...'
                            : 'No events yet'}
                    </p>
                    <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
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
                            const row = rows[index]
                            if (!row) return null
                            const event = row.event
                            const key = rowKey(row)
                            const typeTheme = getTypeTheme(event.parsedType || event.type)
                            const isNewest = isLive && index === 0
                            const prevEvent = index + 1 < rows.length ? rows[index + 1]!.event : null
                            const isDiffActive = diffEventId === key
                            const trace = getTraceForEvent ? getTraceForEvent(event) : null
                            const parsed = getParsedData(event)
                            const shown = shownFor(event, display)
                            const canTree = shapeOf(parsed) === 'object' || shapeOf(parsed) === 'array'
                            const view: PayloadView = (views[key] === 'tree' && !canTree) ? 'json' : (views[key] ?? 'json')

                            return (
                                <div
                                    key={key}
                                    data-index={virtualRow.index}
                                    ref={rowVirtualizer.measureElement}
                                    className="absolute top-0 left-0 w-full"
                                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                                >
                                    <div className="mb-3">
                                        <div
                                            data-testid="event-row"
                                            data-obs-seq={event.obsSeq}
                                            data-highlighted={highlightId === key ? 'true' : undefined}
                                            className={`
                                                group relative rounded-xl p-4 border transition-all duration-300
                                                hover:scale-[1.01] cursor-default
                                                ${isDark
                                                    ? `bg-gradient-to-br ${typeTheme.bg} ${typeTheme.border} hover:shadow-lg ${typeTheme.glow}`
                                                    : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-md'
                                                }
                                                ${isNewest ? 'animate-row-in ring-2 ring-sky-500/30' : ''}
                                                ${highlightId === key ? 'ring-4 ring-teal-400' : ''}
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
                                                        ${isDark ? 'text-slate-400' : 'text-slate-600'}
                                                    `}>
                                                        <Clock className="w-3 h-3" />
                                                        {event.timestamp}
                                                    </span>

                                                    {shown.id && (
                                                        <span data-testid="mapped-id" title="The id from this stream's display mapping" className={`inline-flex items-center gap-1 text-xs font-mono px-2.5 py-1 rounded-lg font-semibold ${isDark ? 'bg-slate-800/80 text-slate-200 border border-slate-700/50' : 'bg-slate-100 text-slate-800'}`}>
                                                            {shown.id}
                                                        </span>
                                                    )}

                                                    {shown.type ? (
                                                        <span data-testid="mapped-type" title="The type from this stream's display mapping" className="text-xs px-2.5 py-1 rounded-lg font-bold uppercase tracking-wide bg-gradient-to-r from-teal-600 to-emerald-600 text-white shadow-sm">
                                                            {shown.type}
                                                        </span>
                                                    ) : event.parsedType && (
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

                                                    {row.count > 1 && (
                                                        <span
                                                            data-testid="repeat-count"
                                                            title={`${row.count} identical events in a row (same name, same data)`}
                                                            className={`text-xs px-2 py-1 rounded-lg font-bold tabular-nums ${isDark ? 'bg-amber-500/20 text-amber-200 border border-amber-500/40' : 'bg-amber-100 text-amber-900 border border-amber-300'}`}
                                                        >
                                                            ×{row.count} identical
                                                        </span>
                                                    )}

                                                    {isNewest && (
                                                        <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 font-semibold border border-emerald-500/30 motion-safe:animate-pulse">
                                                            NEW
                                                        </span>
                                                    )}
                                                </div>

                                                <div className="flex gap-2">
                                                    {prevEvent && (
                                                        <button
                                                            onClick={() => setDiffEventId(isDiffActive ? null : key)}
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

                                            {shown.summary && (
                                                <p data-testid="mapped-summary" className={`mb-2 text-sm font-semibold break-words ${isDark ? 'text-white' : 'text-slate-900'}`}>
                                                    {shown.summary}
                                                </p>
                                            )}

                                            <div className={`
                                                rounded-xl p-4 font-mono text-sm overflow-x-auto
                                                ${isDark
                                                    ? 'bg-slate-900/60 border border-slate-700/30'
                                                    : 'bg-slate-50 border border-slate-200'
                                                }
                                            `}>
                                                <div role="group" aria-label="Payload view" className="flex gap-1 mb-2 font-sans">
                                                    {([['json', 'JSON'], ...(canTree ? [['tree', 'Tree']] : []), ['raw', 'Raw lines']] as Array<[PayloadView, string]>).map(([id, label]) => (
                                                        <button
                                                            key={id}
                                                            type="button"
                                                            data-testid={`view-${id}`}
                                                            aria-pressed={view === id}
                                                            onClick={() => setViews((v) => ({ ...v, [key]: id }))}
                                                            className={`px-2 py-0.5 text-xs rounded-md font-semibold ${view === id
                                                                ? (isDark ? 'bg-sky-600 text-white' : 'bg-sky-700 text-white')
                                                                : (isDark ? 'bg-slate-700/70 text-slate-300 hover:bg-slate-600' : 'bg-slate-200 text-slate-800 hover:bg-slate-300')}`}
                                                        >
                                                            {label}
                                                        </button>
                                                    ))}
                                                </div>
                                                {view === 'tree' && canTree ? (
                                                    <JsonTree value={parsed} theme={theme} />
                                                ) : view === 'raw' ? (
                                                    <div>
                                                        <pre data-testid="raw-lines" className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                                            {event.raw !== '' ? event.raw : '(no raw lines were kept for this event)'}
                                                        </pre>
                                                        <p className={`mt-2 text-xs font-sans ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                                                            The event's own lines as the parser read them, with line endings normalised. This is not the wire bytes.
                                                        </p>
                                                    </div>
                                                ) : parsed !== undefined ? (
                                                    <HighlightedJson text={prettyPayload(event)} theme={theme} />
                                                ) : (
                                                    <pre className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                                        {prettyPayload(event)}
                                                    </pre>
                                                )}
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
