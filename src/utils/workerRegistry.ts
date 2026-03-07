/**
 * workerRegistry.ts
 *
 * Centralized worker lifecycle manager.
 * Prevents duplicate Worker instances when hooks re-mount during HMR or StrictMode.
 *
 * Usage:
 *   const w = workerRegistry.create('filter', () => new Worker(new URL('../workers/filterWorker.ts', import.meta.url)))
 *   workerRegistry.terminate('filter')
 */

type WorkerLike = Worker | SharedWorker

interface Entry<T extends WorkerLike> {
    instance: T
    refCount: number
}

const registry = new Map<string, Entry<WorkerLike>>()

export const workerRegistry = {
    create<T extends WorkerLike>(key: string, factory: () => T): T {
        const existing = registry.get(key)
        if (existing) {
            existing.refCount++
            return existing.instance as T
        }
        const instance = factory()
        registry.set(key, { instance, refCount: 1 })
        return instance
    },

    release(key: string): void {
        const entry = registry.get(key)
        if (!entry) return
        entry.refCount--
        if (entry.refCount <= 0) {
            if (entry.instance instanceof Worker) {
                entry.instance.terminate()
            } else {
                // SharedWorker — close our port
                (entry.instance as SharedWorker).port.close()
            }
            registry.delete(key)
        }
    },

    terminate(key: string): void {
        const entry = registry.get(key)
        if (!entry) return
        if (entry.instance instanceof Worker) {
            entry.instance.terminate()
        } else {
            (entry.instance as SharedWorker).port.close()
        }
        registry.delete(key)
    },

    has(key: string): boolean {
        return registry.has(key)
    },

    _registry: registry,
}
