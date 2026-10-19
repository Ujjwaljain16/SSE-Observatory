/**
 * interceptorSandbox.ts — runs user-defined interceptors in a small pool of isolated workers.
 *
 *  - Off the main thread: slow or hostile code can never block the UI.
 *  - Each worker locks its global scope down before it reports "ready" (see interceptorWorker.ts).
 *  - A job gets TIMEOUT_MS of *execution* time (the clock starts when a ready worker picks it up, so worker start-up
 *    cannot cause false timeouts). On timeout the worker is terminated — the only way to stop a synchronous infinite
 *    loop — and replaced.
 *  - The pool has a fixed size; extra jobs wait in a queue. Nothing is spawned per event and nothing is leaked.
 */

import type { EventMessage } from '../types'
import { findForbiddenSyntax } from './sandboxHarden'

export const TIMEOUT_MS = 100
const POOL_SIZE = 2

export interface InterceptorResult { result: EventMessage | null; error: string | null }

interface Job {
    id: number
    code: string
    event: EventMessage
    resolve: (r: InterceptorResult) => void
    timer?: ReturnType<typeof setTimeout>
}

interface Slot {
    worker: Worker | null
    ready: boolean
    job: Job | null
}

export class InterceptorWorkerPool {
    private slots: Slot[] = []
    private queue: Job[] = []
    private nextId = 1
    private disposed = false

    constructor(size = POOL_SIZE, private readonly timeoutMs = TIMEOUT_MS) {
        for (let i = 0; i < size; i++) {
            const slot: Slot = { worker: null, ready: false, job: null }
            this.slots.push(slot)
            this.spawn(slot)
        }
    }

    private spawn(slot: Slot) {
        if (this.disposed) return
        const worker = new Worker(new URL('../workers/interceptorWorker.ts', import.meta.url), { type: 'module' })
        slot.worker = worker
        slot.ready = false
        slot.job = null

        worker.onmessage = (e: MessageEvent) => {
            if (slot.worker !== worker) return
            const msg = e.data
            if (msg?.type === 'ready') {
                slot.ready = true
                this.pump()
                return
            }
            const job = slot.job
            if (!job || msg?.id !== job.id) return
            clearTimeout(job.timer)
            slot.job = null
            job.resolve({ result: msg.result ?? null, error: msg.error ?? null })
            this.pump()
        }
        worker.onerror = (e: ErrorEvent) => {
            if (slot.worker !== worker) return
            const job = slot.job
            worker.terminate()
            if (job) {
                clearTimeout(job.timer)
                job.resolve({ result: job.event, error: e.message || 'Interceptor worker crashed' })
            }
            this.spawn(slot)
        }
    }

    private pump() {
        for (const slot of this.slots) {
            if (this.queue.length === 0) return
            if (!slot.ready || slot.job || !slot.worker) continue
            const job = this.queue.shift()!
            slot.job = job
            job.timer = setTimeout(() => this.kill(slot, job), this.timeoutMs)
            slot.worker.postMessage({ id: job.id, code: job.code, event: job.event })
        }
    }

    private kill(slot: Slot, job: Job) {
        if (slot.job !== job) return
        slot.worker?.terminate()
        job.resolve({ result: job.event, error: `Interceptor exceeded ${this.timeoutMs}ms — killed` })
        this.spawn(slot)
    }

    run(code: string, event: EventMessage): Promise<InterceptorResult> {
        if (this.disposed) return Promise.resolve({ result: event, error: 'Interceptor pool was disposed' })
        return new Promise((resolve) => {
            this.queue.push({ id: this.nextId++, code, event, resolve })
            this.pump()
        })
    }

    dispose() {
        this.disposed = true
        for (const slot of this.slots) {
            if (slot.job) { clearTimeout(slot.job.timer); slot.job.resolve({ result: slot.job.event, error: 'Interceptor pool was disposed' }) }
            slot.worker?.terminate()
            slot.worker = null
            slot.job = null
        }
        for (const job of this.queue) job.resolve({ result: job.event, error: 'Interceptor pool was disposed' })
        this.queue = []
        this.slots = []
    }
}

let _pool: InterceptorWorkerPool | null = null
const getPool = () => (_pool ??= new InterceptorWorkerPool())

/** Syntax check for instant feedback in the editor. Compiles only — nothing is executed. */
export const compileInterceptor = (code: string): { fn: true | null; error: string | null } => {
    const forbidden = findForbiddenSyntax(code)
    if (forbidden) return { fn: null, error: forbidden }
    try {
        new Function('event', 'ctx', `"use strict";\n${code}`)
        return { fn: true, error: null }
    } catch (e) {
        return { fn: null, error: (e as Error).message }
    }
}

export const runInterceptorWithTimeout = (code: string, event: EventMessage): Promise<InterceptorResult> =>
    getPool().run(code, event)

export const applyInterceptorChain = async (
    interceptors: Array<{ id: string; code: string; enabled: boolean }>,
    event: EventMessage
): Promise<{ event: EventMessage | null; errors: Record<string, string> }> => {
    let current: EventMessage | null = event
    const errors: Record<string, string> = {}

    for (const { id, code, enabled } of interceptors) {
        if (!enabled || current === null) continue
        const { result, error } = await runInterceptorWithTimeout(code, current)
        if (error) errors[id] = error // an erroring interceptor passes the event through unchanged
        else current = result
    }
    return { event: current, errors }
}

export const disposeInterceptorPool = () => {
    _pool?.dispose()
    _pool = null
}
