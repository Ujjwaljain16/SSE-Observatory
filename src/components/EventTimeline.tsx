import { useRef, useEffect, useState } from 'react'
import type { EventMessage, Theme } from '../types'

interface EventTimelineProps {
    theme: Theme
    events: EventMessage[]
    currentEventIndex: number
    onSeek: (index: number) => void
    maxEvents: number
}

export const EventTimeline = ({
    theme,
    events,
    currentEventIndex,
    onSeek,
    maxEvents
}: EventTimelineProps) => {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const [isHovering, setIsHovering] = useState(false)
    const [hoverIndex, setHoverIndex] = useState<number | null>(null)

    const isDark = theme === 'dark'

    // Draw the timeline
    useEffect(() => {
        const canvas = canvasRef.current
        const container = containerRef.current
        if (!canvas || !container) return

        const ctx = canvas.getContext('2d')
        if (!ctx) return

        // Resize canvas to match container
        const { width, height } = container.getBoundingClientRect()
        canvas.width = width * window.devicePixelRatio
        canvas.height = height * window.devicePixelRatio
        canvas.style.width = `${width}px`
        canvas.style.height = `${height}px`
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio)

        // Clear canvas
        ctx.clearRect(0, 0, width, height)

        if (events.length === 0) return

        // Calculate dimensions
        // Calculate dimensions
        // const barWidth = Math.max(2, width / maxEvents) // Unused
        const gap = 1

        // Draw events
        // Events are newest-first in the array [0] is newest.
        // We want to draw oldest-left, newest-right.
        // So we iterate backwards or map index to x-coordinate flipped.

        events.forEach((event, index) => {
            // Index 0 is newest (Right side)
            // Index length-1 is oldest (Left side)

            // Normalize index to 0..1 (0 = oldest, 1 = newest)
            // But wait, our 'index' is reversed. 
            // 0 is newest. So position should be near 'width'.

            // X position:
            // Let's visualize the LAST 'maxEvents'. 
            // If we have fewer than maxEvents, we fill from the right? Or left?
            // Usually timelines fill from left to right.

            // Let's map array index to X.
            // visualIndex 0 = oldest event in memory.
            // visualIndex N = newest event in memory.
            const visualIndex = (events.length - 1) - index

            // Available width per event slot if we were full
            // Available width per event slot if we were full
            // const slotWidth = width / Math.min(events.length, maxEvents) // Unused
            // Actually, let's just use fixed width or dynamic fitting
            // Dynamic fitting is better.

            const x = visualIndex * (width / events.length)
            const w = (width / events.length) - gap

            // Color based on event type
            let color = isDark ? '#475569' : '#cbd5e1' // default slate
            if (event.type === 'error') color = '#ef4444' // red
            if (event.type === 'ping') color = '#f59e0b' // amber
            if (event.parsedType === 'update') color = '#0ea5e9' // sky

            // Highlight current position
            // currentEventIndex is distance from NEWEST.
            // So if currentEventIndex == 0, we are at the far right.
            // If currentEventIndex == 10, we are 10 slots left of right.
            const isSelected = index === currentEventIndex

            ctx.fillStyle = color

            // Height variation for visual interest? 
            // Maybe error taller, ping shorter.
            let h = height * 0.6
            if (event.type === 'error') h = height * 0.8
            if (isSelected) {
                ctx.fillStyle = '#6366f1' // Indigo for selected
                h = height * 0.9
            }

            const y = (height - h) / 2

            ctx.beginPath()
            ctx.roundRect(x, y, Math.max(1, w), h, 2)
            ctx.fill()
        })

    }, [events, theme, maxEvents, currentEventIndex])

    const handleMouseMove = (e: React.MouseEvent) => {
        const container = containerRef.current
        if (!container || events.length === 0) return

        const rect = container.getBoundingClientRect()
        const x = e.clientX - rect.left
        const width = rect.width

        // Map x back to index
        // x / width = pct
        // pct * events.length = visualIndex (0..N, oldest first)
        // index (newest first) = (events.length - 1) - visualIndex

        const pct = Math.max(0, Math.min(1, x / width))
        const visualIndex = Math.floor(pct * events.length)
        const index = (events.length - 1) - visualIndex

        setHoverIndex(Math.max(0, Math.min(index, events.length - 1)))
        setIsHovering(true)
    }

    const handleClick = () => {
        if (hoverIndex !== null) {
            onSeek(hoverIndex)
        }
    }

    return (
        <div className={`
            fixed bottom-0 left-0 right-0 h-16 
            backdrop-blur-md border-t z-40 transition-all duration-300
            ${isDark
                ? 'bg-slate-900/80 border-slate-700/50'
                : 'bg-white/80 border-slate-200/50'
            }
        `}>
            {/* Tooltip */}
            {isHovering && hoverIndex !== null && events[hoverIndex] && (
                <div
                    className="absolute bottom-full mb-2 -translate-x-1/2 px-3 py-1.5 rounded-lg text-xs font-mono bg-black/80 text-white pointer-events-none"
                    style={{
                        left: `${((events.length - 1 - hoverIndex) / events.length) * 100}%`
                    }}
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
