/**
 * interceptorSandbox.ts — Safe execution environment for user-defined interceptors.
 *
 * ARCHITECTURE:
 * Each interceptor execution spins up a fresh dedicated Worker (interceptorWorker.ts).
 * The worker compiles and runs the user code, then is terminated.
 *
 * Security properties (vs the previous new Function() on main thread approach):
 *   ✓  Off-main-thread: UI never blocked by user code
 *   ✓  Worker has no window/document/localStorage — globals shadowed to undefined
 *   ✓  Synchronous infinite loops: Worker.terminate() genuinely kills them
 *      (Promise.race alone cannot kill synchronous code on the same thread)
 *   ✓  Network exfiltration: fetch is shadowed to undefined inside the worker code
 *   ✓  Crashes are isolated — uncaught errors in the worker don't propagate to main
 *
 * Performance trade-off:
 *   Creating a new Worker per event is expensive (~2-5ms overhead). To mitigate
 *   this, we use a small pool of 2 reusable workers (POOL_SIZE) that are recycled
 *   between runs. If a worker must be terminated (timeout), a fresh one is spawned
 *   to replace it.
 */

import type { EventMessage } from '../types'

const TIMEOUT_MS = 100   // Kill the worker if it takes longer than 100ms
const POOL_SIZE = 2       // Reusable worker pool size

type WorkerEntry = { worker: Worker; busy: boolean }

class InterceptorWorkerPool {
    private pool: WorkerEntry[] = []

    private createWorker(): WorkerEntry {
        const worker = new Worker(
            new URL('../workers/interceptorWorker.ts', import.meta.url),
            { type: 'module' }
        )
        const entry: WorkerEntry = { worker, busy: false }
        return entry
    }

    private acquire(): WorkerEntry {
        const idle = this.pool.find(e => !e.busy)
        if (idle) {
            idle.busy = true
            return idle
        }
        // Pool exhausted — create an extra worker (will not be returned to pool after use)
        const entry = this.createWorker()
        entry.busy = true
        return entry
    }

    private release(entry: WorkerEntry) {
        entry.busy = false
    }

    private terminate(entry: WorkerEntry) {
        entry.worker.terminate()
        // Replace the terminated entry with a fresh worker
        const idx = this.pool.indexOf(entry)
        if (idx !== -1) {
            this.pool[idx] = this.createWorker()
        }
    }

    async run(code: string, event: EventMessage): Promise<{ result: EventMessage | null; error: string | null }> {
        const entry = this.acquire()

        return new Promise((resolve) => {
            const killTimer = setTimeout(() => {
                // Genuine kill — terminates even synchronous infinite loops
                this.terminate(entry)
                resolve({ result: event, error: `Interceptor exceeded ${TIMEOUT_MS}ms — killed` })
            }, TIMEOUT_MS)

            entry.worker.onmessage = (e) => {
                clearTimeout(killTimer)
                this.release(entry)
                resolve(e.data)
            }

            entry.worker.onerror = (e) => {
                clearTimeout(killTimer)
                this.release(entry)
                resolve({ result: event, error: e.message ?? 'Worker error' })
            }

            entry.worker.postMessage({ code, event })
        })
    }

    initialise() {
        if (this.pool.length === 0) {
            for (let i = 0; i < POOL_SIZE; i++) {
                this.pool.push(this.createWorker())
            }
        }
    }

    dispose() {
        for (const entry of this.pool) {
            entry.worker.terminate()
        }
        this.pool = []
    }
}

// Singleton pool — instantiated lazily on first interceptor use
let _pool: InterceptorWorkerPool | null = null

function getPool(): InterceptorWorkerPool {
    if (!_pool) {
        _pool = new InterceptorWorkerPool()
        _pool.initialise()
    }
    return _pool
}

/**
 * Validates that user code compiles (syntax check) without running it.
 * Returns an error string if compilation fails, null if valid.
 */
export const compileInterceptor = (
    code: string
): { fn: true | null; error: string | null } => {
    try {
        // eslint-disable-next-line no-new-func
        new Function('event', 'ctx', `"use strict";\n${code}`)
        return { fn: true, error: null }
    } catch (e: any) {
        return { fn: null, error: e.message }
    }
}

/**
 * Runs a single interceptor code string against an event in the Worker pool.
 * Returns the transformed event, null (drop), or the original event on error/timeout.
 */
export const runInterceptorWithTimeout = async (
    code: string,
    event: EventMessage
): Promise<{ result: EventMessage | null; error: string | null }> => {
    return getPool().run(code, event)
}

/**
 * Applies a full chain of interceptors sequentially (async pipeline).
 * If any interceptor returns null, the event is dropped immediately.
 * If any interceptor errors/times out, it is skipped and the chain continues.
 */
export const applyInterceptorChain = async (
    interceptors: Array<{
        id: string
        code: string
        enabled: boolean
    }>,
    event: EventMessage
): Promise<{ event: EventMessage | null; errors: Record<string, string> }> => {
    let current: EventMessage | null = event
    const errors: Record<string, string> = {}

    for (const { id, code, enabled } of interceptors) {
        if (!enabled || current === null) continue

        const { result, error } = await runInterceptorWithTimeout(code, current)
        if (error) {
            errors[id] = error
            // Don't drop on error — pass current state unchanged
        } else {
            current = result
        }

        if (current === null) break
    }

    return { event: current, errors }
}

/** Call on app teardown (e.g. React strict-mode unmount) to release worker threads. */
export const disposeInterceptorPool = () => {
    _pool?.dispose()
    _pool = null
}
