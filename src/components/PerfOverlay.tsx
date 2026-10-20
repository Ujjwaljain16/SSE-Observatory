/// <reference types="vite/client" />
/**
 * PerfOverlay.tsx  —  Dev-only performance metrics overlay
 *
 * Visible only in development builds (import.meta.env.DEV).
 * Toggle with Shift+P.
 *
 * Displays: filter execution time, timeline draw time, events/sec, worker status.
 */

import { useState, useEffect, useRef } from 'react'

interface PerfOverlayBodyProps {
    filterExecMs: number
    timelineDrawMs: number
    /** Events accepted since the last clear (monotonic). */
    totalReceived: number
    isFilterWorkerReady: boolean
    isSharedWorkerActive: boolean
    totalEvents: number
}

function PerfOverlayBody({
    filterExecMs,
    timelineDrawMs,
    totalReceived,
    isFilterWorkerReady,
    isSharedWorkerActive,
    totalEvents,
}: PerfOverlayBodyProps) {
    const eventsPerSec = useEventsPerSec(totalReceived)
    const [visible, setVisible] = useState(false)

    // Toggle with Shift+P — must be before any early return (Rules of Hooks)
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.shiftKey && e.key === 'P') setVisible(v => !v)
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [])



    if (!visible) {
        return (
            <button
                type="button"
                className="fixed bottom-20 right-4 z-50 text-xs font-mono px-2 py-1 rounded cursor-pointer select-none transition-colors bg-black/70 hover:bg-black/90 text-white"
                onClick={() => setVisible(true)}
                aria-label="Perf: show the performance overlay"
                title="Shift+P to toggle perf overlay"
            >
                ⚡ Perf
            </button>
        )
    }

    const status = (ok: boolean) => ok
        ? <span className="text-green-400">●</span>
        : <span className="text-red-400">○</span>

    const ms = (val: number) => {
        const color = val < 5 ? 'text-green-400' : val < 16 ? 'text-yellow-400' : 'text-red-400'
        return <span className={`font-bold ${color}`}>{val.toFixed(1)}ms</span>
    }

    return (
        <div className="fixed bottom-20 right-4 z-50 bg-black/90 text-white text-xs font-mono rounded-lg shadow-xl border border-white/10 p-3 w-56 select-none">
            <div className="flex items-center justify-between mb-2">
                <span className="text-white/50 uppercase tracking-widest text-[10px]">
                    ⚡ Perf Monitor
                </span>
                <button
                    onClick={() => setVisible(false)}
                    className="text-white/30 hover:text-white text-xs"
                >
                    ✕
                </button>
            </div>

            <table className="w-full border-collapse">
                <tbody>
                    <tr>
                        <td className="text-white/50 py-0.5">Filter Worker</td>
                        <td className="text-right">{status(isFilterWorkerReady)} {ms(filterExecMs)}</td>
                    </tr>
                    <tr>
                        <td className="text-white/50 py-0.5">Timeline draw</td>
                        <td className="text-right">{ms(timelineDrawMs)}</td>
                    </tr>
                    <tr>
                        <td className="text-white/50 py-0.5">Events/sec</td>
                        <td className="text-right font-bold text-sky-400">{eventsPerSec.toFixed(0)}</td>
                    </tr>
                    <tr>
                        <td className="text-white/50 py-0.5">Total events</td>
                        <td className="text-right text-slate-300">{totalEvents.toLocaleString()}</td>
                    </tr>
                    <tr>
                        <td className="text-white/50 py-0.5">SharedWorker</td>
                        <td className="text-right">{status(isSharedWorkerActive)} {isSharedWorkerActive ? 'shared' : 'direct'}</td>
                    </tr>
                </tbody>
            </table>

            <div className="mt-2 pt-2 border-t border-white/10 text-[10px] text-white/30">
                Shift+P to hide
            </div>
        </div>
    )
}

/**
 * useEventsPerSec — rolling events/second over the last 2 seconds, from a monotonically increasing total
 * (NOT the buffer length, which stops changing once the ring buffer is full). Re-evaluated every 500 ms so the
 * rate falls to 0 when the stream goes quiet.
 */
export function useEventsPerSec(totalReceived: number): number {
    const total = useRef(totalReceived)
    total.current = totalReceived
    const history = useRef<{ t: number; n: number }[]>([])
    const [rate, setRate] = useState(0)

    useEffect(() => {
        history.current = [{ t: performance.now(), n: total.current }]
        const tick = () => {
            const now = performance.now()
            history.current.push({ t: now, n: total.current })
            history.current = history.current.filter((e) => e.t >= now - 2000)
            const oldest = history.current[0]
            const elapsed = (now - oldest.t) / 1000
            setRate(elapsed > 0 ? Math.max(0, (total.current - oldest.n) / elapsed) : 0)
        }
        const timer = setInterval(tick, 500)
        return () => clearInterval(timer)
    }, [])

    return rate
}

/** Dev-only. The rate hook runs inside the body component, so its 500 ms ticks never re-render the app. */
export function PerfOverlay(props: PerfOverlayBodyProps) {
    if (!import.meta.env.DEV) return null
    return <PerfOverlayBody {...props} />
}
