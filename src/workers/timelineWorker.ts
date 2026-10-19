// Draws the event timeline on a background thread using OffscreenCanvas.
//
// byte layout per event slot:
//   bits 0-3: type code (see utils/timelinePalette)
//   bit  4  : selected / current playhead

/// <reference lib="webworker" />

import { colorFor, barHeightFraction } from '../utils/timelinePalette'

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null

// Cap drawing at ~60fps, but never drop the LAST request: a draw that arrives inside the frame budget is
// remembered and executed when the budget is over, so the picture always ends up current.
const FRAME_BUDGET_MS = 16
let lastDraw = 0
let pending: DrawMessage | null = null
let timer: ReturnType<typeof setTimeout> | null = null

interface DrawMessage {
    type: 'draw'
    slots: Uint8Array
    currentIndex: number
    isDark: boolean
    width: number
    height: number
    dpr: number
}

function draw(msg: DrawMessage) {
    if (!canvas || !ctx) return

    const { slots, currentIndex, isDark, width, height, dpr } = msg
    const n = slots.length
    const w = Math.round(width * dpr)
    const h = Math.round(height * dpr)
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (n === 0) return
    ctx.scale(dpr, dpr)

    const gap = 1
    const slotW = width / n

    for (let i = 0; i < n; i++) {
        const byte = slots[i]
        const code = byte & 0x0f
        const selected = ((byte >> 4) & 1) === 1 || i === currentIndex

        // draw oldest events on the left, newest on the right
        const x = (n - 1 - i) * slotW
        const barH = height * barHeightFraction(code, selected)

        ctx.fillStyle = colorFor(code, isDark, selected)
        ctx.beginPath()
        if (ctx.roundRect) ctx.roundRect(x, (height - barH) / 2, Math.max(1, slotW - gap), barH, 2)
        else ctx.rect(x, (height - barH) / 2, Math.max(1, slotW - gap), barH)
        ctx.fill()
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
}

function run(msg: DrawMessage) {
    lastDraw = performance.now()
    const t0 = lastDraw
    draw(msg)
    self.postMessage({ type: 'draw_complete', drawMs: +(performance.now() - t0).toFixed(2) })
}

self.onmessage = (e: MessageEvent) => {
    const msg = e.data

    if (msg.type === 'init') {
        canvas = msg.canvas as OffscreenCanvas
        ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null
        return
    }

    if (msg.type === 'draw') {
        const wait = FRAME_BUDGET_MS - (performance.now() - lastDraw)
        if (wait <= 0 && !timer) return run(msg)
        pending = msg // newest request wins
        if (!timer) {
            timer = setTimeout(() => {
                timer = null
                const next = pending
                pending = null
                if (next) run(next)
            }, Math.max(0, wait))
        }
    }
}
