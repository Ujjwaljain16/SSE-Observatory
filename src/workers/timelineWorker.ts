// renders the event timeline on a background thread using offscreencanvas
// avoids blocking the main ui rendering cycle when drawing thousands of events
//
// byte layout per event slot:
//   bits 0-3: type code
//   bits 4-5: flags (bit4=selected, bit5=hovered)

/// <reference lib="webworker" />

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null

// cap draw frequency to 60fps to save cpu
let lastDraw = 0
const FRAME_BUDGET_MS = 16

const COLORS_DARK = {
    default: '#475569',
    error: '#ef4444',
    ping: '#f59e0b',
    update: '#0ea5e9',
    selected: '#6366f1',
}
const COLORS_LIGHT = {
    default: '#cbd5e1',
    error: '#f87171',
    ping: '#fbbf24',
    update: '#38bdf8',
    selected: '#818cf8',
}

function typeColor(code: number, isDark: boolean): string {
    const p = isDark ? COLORS_DARK : COLORS_LIGHT
    switch (code & 0x0F) {
        case 1: return p.error
        case 2: return p.ping
        case 3: return p.update
        default: return p.default
    }
}

function draw(msg: {
    slots: Uint8Array
    currentIndex: number
    isDark: boolean
    width: number
    height: number
    dpr: number
}) {
    if (!canvas || !ctx) return

    const { slots, currentIndex, isDark, width, height, dpr } = msg
    const n = slots.length
    if (n === 0) return
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.scale(dpr, dpr)

    const gap = 1
    const slotW = width / n

    for (let i = 0; i < n; i++) {
        const byte = slots[i]
        const typeCode = byte & 0x0F
        const isSelected = (byte >> 4) & 0x01

        // draw oldest events on the left, newest on the right
        const visualIndex = (n - 1) - i
        const x = visualIndex * slotW
        const w = Math.max(1, slotW - gap)

        const isCurrentPosition = i === currentIndex
        let barH = height * 0.6
        if (typeCode === 1) barH = height * 0.8
        if (isCurrentPosition || isSelected) barH = height * 0.9

        const y = (height - barH) / 2

        ctx.fillStyle = isCurrentPosition ? (isDark ? COLORS_DARK.selected : COLORS_LIGHT.selected)
            : typeColor(typeCode, isDark)

        ctx.beginPath()
        // fallback for browsers lacking roundrect support in workers
        if (ctx.roundRect) {
            ctx.roundRect(x, y, w, barH, 2)
        } else {
            ctx.rect(x, y, w, barH)
        }
        ctx.fill()
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
    const msg = e.data

    if (msg.type === 'init') {
        canvas = msg.canvas as OffscreenCanvas
        ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null
        return
    }

    if (msg.type === 'draw') {
        const now = performance.now()
        if (now - lastDraw < FRAME_BUDGET_MS) return

        lastDraw = now
        const t0 = performance.now()
        draw(msg)
        const drawMs = +(performance.now() - t0).toFixed(2)
        self.postMessage({ type: 'draw_complete', drawMs })
    }
}
