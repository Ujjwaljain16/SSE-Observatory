import '@testing-library/jest-dom'
import 'fake-indexeddb/auto'
import { createInterceptorRunner } from '../workers/interceptorCore'

// Mock canvas for JSDOM (skipped in node-environment test files)
if (typeof HTMLCanvasElement !== 'undefined') HTMLCanvasElement.prototype.getContext = () => {
    return {
        fillRect: () => { },
        clearRect: () => { },
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
            data: new Array(w * h * 4)
        }),
        putImageData: () => { },
        createImageData: () => [],
        setTransform: () => { },
        drawImage: () => { },
        save: () => { },
        fillText: () => { },
        restore: () => { },
        beginPath: () => { },
        moveTo: () => { },
        lineTo: () => { },
        closePath: () => { },
        stroke: () => { },
        translate: () => { },
        scale: () => { },
        rotate: () => { },
        arc: () => { },
        fill: () => { },
        measureText: () => ({ width: 0 }),
        transform: () => { },
        rect: () => { },
        clip: () => { },
    } as any
}

// Mock Web Worker for JSDOM. Interceptor requests run through the REAL interceptor core (the same code the
// production worker uses — minus the global-scope lockdown, which is tested separately in a fresh realm).
class MockWorker {
    onmessage: any
    onerror: any
    terminated = false
    private run = createInterceptorRunner({
        compile: Function as never,
        ctx: { JSON, atob, btoa, Math, Date, console },
        stringify: (v) => JSON.stringify(v),
    })
    constructor(_stringUrl: string | URL, _options?: any) {
        setTimeout(() => { if (!this.terminated) this.onmessage?.({ data: { type: 'ready' } }) }, 0)
    }
    postMessage(msg: any) {
        if (!msg || msg.code === undefined || msg.event === undefined) return
        setTimeout(() => {
            if (this.terminated) return
            this.onmessage?.({ data: this.run(msg) })
        }, 1)
    }
    terminate() { this.terminated = true }
}
(globalThis as any).Worker = MockWorker
if (typeof window !== 'undefined') {
    (window as any).Worker = MockWorker
}

// Mock SharedWorker for JSDOM
class MockSharedWorker {
    port: any
    constructor(_stringUrl: string | URL, _options?: any) {
        this.port = {
            start: () => { },
            postMessage: () => { },
            addEventListener: () => { },
            onmessage: null
        }
    }
}
(globalThis as any).SharedWorker = MockSharedWorker
if (typeof window !== 'undefined') {
    (window as any).SharedWorker = MockSharedWorker
}
