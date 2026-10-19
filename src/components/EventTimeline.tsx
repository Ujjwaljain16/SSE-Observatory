// Bottom timeline: one bar per buffered event. Drawing happens on an OffscreenCanvas in a worker when the
// browser supports it, otherwise on the main thread. Hover/click only need x-coordinates, so they stay here.

import { useRef, useEffect, useState, useCallback } from 'react'
import type { EventMessage, Theme } from '../types'
import { typeCode, colorFor, barHeightFraction } from '../utils/timelinePalette'

interface EventTimelineProps {
    theme: Theme
    events: EventMessage[]
    currentEventIndex: number
    onSeek: (index: number) => void
    maxEvents?: number
    onDrawMs?: (ms: number) => void  // for PerfOverlay
}

/** One byte per event: low nibble = type code, bit 4 = selected. */
function encodeSlots(events: EventMessage[], currentIndex: number): Uint8Array {
    const slots = new Uint8Array(events.length)
    for (let i = 0; i < events.length; i++) {
        slots[i] = typeCode(events[i]) | (i === currentIndex ? 0x10 : 0)
    }
    return slots
}

function drawSync(
    ctx: CanvasRenderingContext2D,
    events: EventMessage[],
    currentIndex: number,
    width: number,
    height: number,
    isDark: boolean
) {
    ctx.clearRect(0, 0, width, height)
    const n = events.length
    if (n === 0) return
    const gap = 1
    const slotW = width / n

    for (let i = 0; i < n; i++) {
        const code = typeCode(events[i])
        const selected = i === currentIndex
        const barH = height * barHeightFraction(code, selected)
        const x = (n - 1 - i) * slotW // oldest on the left, newest on the right
        ctx.fillStyle = colorFor(code, isDark, selected)
        ctx.beginPath()
        if (ctx.roundRect) ctx.roundRect(x, (height - barH) / 2, Math.max(1, slotW - gap), barH, 2)
        else ctx.rect(x, (height - barH) / 2, Math.max(1, slotW - gap), barH)
        ctx.fill()
    }
}

export const EventTimeline = ({ theme, events, currentEventIndex, onSeek, onDrawMs }: EventTimelineProps) => {
    const hostRef = useRef<HTMLDivElement>(null)
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const workerRef = useRef<Worker | null>(null)
    const onDrawMsRef = useRef(onDrawMs)
    onDrawMsRef.current = onDrawMs
    // bumped whenever the canvas (re)appears or the host is resized, so the draw effect runs again
    const [surfaceVersion, setSurfaceVersion] = useState(0)

    const [isHovering, setIsHovering] = useState(false)
    const [hoverIndex, setHoverIndex] = useState<number | null>(null)
    const isDark = theme === 'dark'

    // The canvas is created (and owned) by this effect. A canvas whose control has been transferred to a worker
    // can never be transferred or drawn on again, so every mount — including React StrictMode's second one in
    // development — needs a fresh element rather than reusing one from JSX.
    useEffect(() => {
        const host = hostRef.current
        if (!host) return
        const canvas = document.createElement('canvas')
        canvas.className = 'block w-full h-full'
        host.appendChild(canvas)
        canvasRef.current = canvas

        let worker: Worker | null = null
        if (typeof Worker !== 'undefined' && 'transferControlToOffscreen' in canvas) {
            try {
                worker = new Worker(new URL('../workers/timelineWorker.ts', import.meta.url), { type: 'module' })
                worker.onmessage = (e: MessageEvent) => {
                    if (e.data?.type === 'draw_complete') onDrawMsRef.current?.(e.data.drawMs)
                }
                const offscreen = canvas.transferControlToOffscreen()
                worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen])
            } catch {
                worker?.terminate()
                worker = null
            }
        }
        workerRef.current = worker

        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => setSurfaceVersion((v) => v + 1)) : null
        observer?.observe(host)
        setSurfaceVersion((v) => v + 1)

        return () => {
            observer?.disconnect()
            worker?.terminate()
            workerRef.current = null
            canvasRef.current = null
            canvas.remove()
        }
    }, [])

    useEffect(() => {
        const host = hostRef.current
        const canvas = canvasRef.current
        if (!host || !canvas) return
        const { width, height } = host.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1

        const worker = workerRef.current
        if (worker) {
            const slots = encodeSlots(events, currentEventIndex)
            worker.postMessage({ type: 'draw', slots, currentIndex: currentEventIndex, isDark, width, height, dpr }, [slots.buffer])
            return
        }

        let ctx: CanvasRenderingContext2D | null = null
        try { ctx = canvas.getContext('2d') } catch { return }
        if (!ctx) return
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
        canvas.style.width = `${width}px`
        canvas.style.height = `${height}px`
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const t0 = performance.now()
        drawSync(ctx, events, currentEventIndex, width, height, isDark)
        onDrawMsRef.current?.(+(performance.now() - t0).toFixed(2))
        ctx.setTransform(1, 0, 0, 1, 0, 0)
    }, [events, isDark, currentEventIndex, surfaceVersion])

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        const host = hostRef.current
        if (!host || events.length === 0) return
        const rect = host.getBoundingClientRect()
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
            {isHovering && hoverIndex !== null && events[hoverIndex] && (
                <div
                    className="absolute bottom-full mb-2 -translate-x-1/2 px-3 py-1.5 rounded-lg text-xs font-mono bg-black/80 text-white pointer-events-none"
                    style={{ left: `${((events.length - 1 - hoverIndex) / events.length) * 100}%` }}
                >
                    {events[hoverIndex].parsedType ?? events[hoverIndex].type}
                    <span className="opacity-50 ml-2">{events[hoverIndex].timestamp}</span>
                </div>
            )}

            <div
                ref={hostRef}
                role="slider"
                aria-label="Event timeline"
                aria-valuemin={0}
                aria-valuemax={Math.max(0, events.length - 1)}
                aria-valuenow={currentEventIndex}
                className="w-full h-full cursor-crosshair relative"
                onMouseMove={handleMouseMove}
                onMouseLeave={() => setIsHovering(false)}
                onClick={handleClick}
            />
        </div>
    )
}
