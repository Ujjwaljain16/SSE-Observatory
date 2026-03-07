/**
 * EventTimeline.tsx  —  Sticky timeline bar with OffscreenCanvas worker rendering
 *
 * At 10k+ events the drawing is moved into a timelineWorker via OffscreenCanvas.
 * Falls back to synchronous main-thread drawing when OffscreenCanvas is unsupported.
 *
 * Main thread keeps ALL interaction (hover tooltip, seek-on-click) —
 * these only need x-coordinate math, no image data from the worker.
 */

import { useRef, useEffect, useState, useCallback } from 'react'
import type { EventMessage, Theme } from '../types'
import { workerRegistry } from '../utils/workerRegistry'

const WORKER_KEY = 'timeline-worker'

interface EventTimelineProps {
    theme: Theme
    events: EventMessage[]
    currentEventIndex: number
    onSeek: (index: number) => void
    maxEvents: number
    onDrawMs?: (ms: number) => void  // for PerfOverlay
}

// ─── Slot encoding: 1 byte per event ──────────────────────────────────────────
function encodeSlots(events: EventMessage[], currentIndex: number): Uint8Array {
    const slots = new Uint8Array(events.length)
    for (let i = 0; i < events.length; i++) {
        const e = events[i]
        let typeBits = 0
        if (e.type === 'error') typeBits = 1
        else if (e.type === 'ping') typeBits = 2
        else if (e.parsedType === 'update' || e.type === 'update') typeBits = 3

        let flagBits = 0
        if (i === currentIndex) flagBits |= 0x10  // bit4 = selected

        slots[i] = typeBits | flagBits
    }
    return slots
}

// ─── Main-thread sync fallback draw ───────────────────────────────────────────
function drawSync(
    ctx: CanvasRenderingContext2D,
    events: EventMessage[],
    currentIndex: number,
    width: number,
    height: number,
    isDark: boolean
) {
    ctx.clearRect(0, 0, width, height)
    if (events.length === 0) return

    const n = events.length
    const gap = 1
    const slotW = width / n

    const COLORS_DARK = { default: '#475569', error: '#ef4444', ping: '#f59e0b', update: '#0ea5e9', selected: '#6366f1' }
    const COLORS_LIGHT = { default: '#cbd5e1', error: '#f87171', ping: '#fbbf24', update: '#38bdf8', selected: '#818cf8' }
    const C = isDark ? COLORS_DARK : COLORS_LIGHT

    for (let i = 0; i < n; i++) {
        const e = events[i]
        const visualIndex = (n - 1) - i
        const x = visualIndex * slotW
        const w = Math.max(1, slotW - gap)

        const isSelected = i === currentIndex
        let color = C.default
        if (e.type === 'error') color = C.error
        else if (e.type === 'ping') color = C.ping
        else if (e.parsedType === 'update') color = C.update
        if (isSelected) color = C.selected

        let h = height * 0.6
        if (e.type === 'error') h = height * 0.8
        if (isSelected) h = height * 0.9
        const y = (height - h) / 2

        ctx.fillStyle = color
        ctx.beginPath()
        if (ctx.roundRect) ctx.roundRect(x, y, w, h, 2)
        else ctx.rect(x, y, w, h)
        ctx.fill()
    }
}

export const EventTimeline = ({
    theme,
    events,
    currentEventIndex,
    onSeek,
    maxEvents,
    onDrawMs,
}: EventTimelineProps) => {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const [isHovering, setIsHovering] = useState(false)
    const [hoverIndex, setHoverIndex] = useState<number | null>(null)
    const workerRef = useRef<Worker | null>(null)
    const offscreenActiveRef = useRef(false)

    const isDark = theme === 'dark'

    // ─── Worker setup (OffscreenCanvas path) ───────────────────────────────────
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || typeof Worker === 'undefined') return
        if (!('transferControlToOffscreen' in canvas)) return  // unsupported

        try {
            const worker = workerRegistry.create(WORKER_KEY, () =>
                new Worker(new URL('../workers/timelineWorker.ts', import.meta.url), { type: 'module' })
            )
            workerRef.current = worker

            const offscreen = canvas.transferControlToOffscreen()
            worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen])
            offscreenActiveRef.current = true

            worker.onmessage = (e: MessageEvent) => {
                if (e.data.type === 'draw_complete' && onDrawMs) {
                    onDrawMs(e.data.drawMs)
                }
            }
        } catch {
            offscreenActiveRef.current = false
        }

        return () => {
            offscreenActiveRef.current = false  // reset so remount draw doesn't hit sync path on a transferred canvas
            workerRef.current = null
            workerRegistry.release(WORKER_KEY)
        }
    }, []) // eslint-disable-line

    // ─── Draw (worker or sync) ─────────────────────────────────────────────────
    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const { width, height } = container.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1

        if (offscreenActiveRef.current && workerRef.current) {
            // Worker path: encode to Uint8Array (cheap clone)
            const slots = encodeSlots(events, currentEventIndex)
            workerRef.current.postMessage({
                type: 'draw',
                slots,
                currentIndex: currentEventIndex,
                isDark,
                width,
                height,
                dpr,
            }, [slots.buffer])   // Transfer the buffer — zero-copy
        } else {
            // Sync fallback — guard with try-catch because once a canvas has
            // transferred its control to an OffscreenCanvas, calling getContext('2d')
            // on it throws InvalidStateError even after React unmount/remount.
            const canvas = canvasRef.current
            if (!canvas) return
            let ctx: CanvasRenderingContext2D | null = null
            try {
                ctx = canvas.getContext('2d')
            } catch {
                // Canvas already transferred (StrictMode double-mount in dev) — skip
                return
            }
            if (!ctx) return

            canvas.width = Math.round(width * dpr)
            canvas.height = Math.round(height * dpr)
            canvas.style.width = `${width}px`
            canvas.style.height = `${height}px`
            ctx.scale(dpr, dpr)

            const t0 = performance.now()
            drawSync(ctx, events, currentEventIndex, width, height, isDark)
            onDrawMs?.(+(performance.now() - t0).toFixed(2))

            ctx.setTransform(1, 0, 0, 1, 0, 0)
        }
    }, [events, isDark, maxEvents, currentEventIndex]) // eslint-disable-line

    // ─── Interaction (main thread only — no worker needed) ────────────────────
    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        const container = containerRef.current
        if (!container || events.length === 0) return
        const rect = container.getBoundingClientRect()
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        const visualIndex = Math.floor(pct * events.length)
        const index = (events.length - 1) - visualIndex
        setHoverIndex(Math.max(0, Math.min(index, events.length - 1)))
        setIsHovering(true)
    }, [events])

    const handleClick = useCallback(() => {
        if (hoverIndex !== null) onSeek(hoverIndex)
    }, [hoverIndex, onSeek])

    return (
        <div className={`
            fixed bottom-0 left-0 right-0 h-16
            backdrop-blur-md border-t z-40 transition-all duration-300
            ${isDark ? 'bg-slate-900/80 border-slate-700/50' : 'bg-white/80 border-slate-200/50'}
        `}>
            {/* Hover tooltip */}
            {isHovering && hoverIndex !== null && events[hoverIndex] && (
                <div
                    className="absolute bottom-full mb-2 -translate-x-1/2 px-3 py-1.5 rounded-lg text-xs font-mono bg-black/80 text-white pointer-events-none"
                    style={{ left: `${((events.length - 1 - hoverIndex) / events.length) * 100}%` }}
                >
                    {events[hoverIndex].type}
                    <span className="opacity-50 ml-2">#{events[hoverIndex].id}</span>
                </div>
            )}

            <div
                ref={containerRef}
                className="w-full h-full cursor-crosshair relative"
                onMouseMove={handleMouseMove}
                onMouseLeave={() => setIsHovering(false)}
                onClick={handleClick}
            >
                <canvas ref={canvasRef} className="block w-full h-full" />
            </div>
        </div>
    )
}
