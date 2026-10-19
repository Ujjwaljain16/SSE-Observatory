import '@testing-library/jest-dom'
import 'fake-indexeddb/auto'

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

// Mock Web Worker for JSDOM
class MockWorker {
    onmessage: any
    onerror: any
    constructor(_stringUrl: string | URL, _options?: any) { }
    postMessage(msg: any) {
        // Evaluate the interceptor message asynchronously to mimic worker isolation
        setTimeout(() => {
            if (!this.onmessage) return
            try {
                if (msg.code !== undefined && msg.event !== undefined) {
                    const { code, event } = msg
                    // Replicate the interceptorWorker.ts security wrap
                    const fn = new Function('event', `
                        const window = undefined;
                        const document = undefined;
                        const fetch = undefined;
                        const localStorage = undefined;
                        ${code}
                    `)
                    Promise.resolve(fn(event)).then(res => {
                        this.onmessage({ data: { result: res, error: null } })
                    }).catch(err => {
                        this.onmessage({ data: { result: event, error: err.message } })
                    })
                }
            } catch (err: any) {
                this.onmessage({ data: { result: msg.event, error: err.message } })
            }
        }, 5)
    }
    terminate() { }
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
