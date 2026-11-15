import { useState, useCallback, useEffect } from 'react'
import type { EventMessage } from '../types'
import {
    compileInterceptor,
    applyInterceptorChain,
    disposeInterceptorPool,
} from '../utils/interceptorSandbox'

export interface Interceptor {
    id: string
    name: string
    code: string
    enabled: boolean
    lastError: string | null
    /** True when the code parses without syntax errors — compilation now happens in the Worker */
    compiledFn: true | null
    compileError: string | null
}

const DEFAULT_INTERCEPTOR_CODE = `// Transform the event before it hits the buffer.
// Return the modified event, or return null to drop it.
// Available: ctx.JSON, ctx.atob(), ctx.btoa(), ctx.console.log()
// NOTE: fetch, localStorage, window, document are NOT available (sandboxed Worker).

return event;`

interface UseInterceptorsReturn {
    interceptors: Interceptor[]
    addInterceptor: (name?: string) => void
    removeInterceptor: (id: string) => void
    renameInterceptor: (id: string, newName: string) => void
    updateInterceptorCode: (id: string, code: string) => void
    toggleInterceptor: (id: string) => void
    reorderInterceptors: (fromIndex: number, toIndex: number) => void
    applyInterceptors: (event: EventMessage) => Promise<EventMessage | null>
    hasActiveInterceptors: boolean
}

export const useInterceptors = (): UseInterceptorsReturn => {
    const [interceptors, setInterceptors] = useState<Interceptor[]>([])

    // Dispose Worker pool on unmount (React StrictMode double-mount safe)
    useEffect(() => {
        return () => { disposeInterceptorPool() }
    }, [])

    const addInterceptor = useCallback((name?: string) => {
        // Fallback for environments where crypto.randomUUID might be missing
        const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : (Math.random().toString(36).substring(2) + Date.now().toString(36));

        const { fn, error } = compileInterceptor(DEFAULT_INTERCEPTOR_CODE)

        setInterceptors(prev => {
            const interceptorName = typeof name === 'string' ? name : ""
            const newInterceptor: Interceptor = {
                id,
                name: interceptorName,
                code: DEFAULT_INTERCEPTOR_CODE,
                enabled: true,
                lastError: null,
                compiledFn: fn,
                compileError: error,
            }
            return [...prev, newInterceptor]
        })
    }, [])

    const removeInterceptor = useCallback((id: string) => {
        setInterceptors(prev => prev.filter(i => i.id !== id))
    }, [])

    const renameInterceptor = useCallback((id: string, newName: string) => {
        setInterceptors(prev => prev.map(i => i.id === id ? { ...i, name: newName } : i))
    }, [])

    const updateInterceptorCode = useCallback((id: string, code: string) => {
        // Synchronous syntax-check gives instant feedback in the editor
        const { fn, error } = compileInterceptor(code)
        setInterceptors(prev => prev.map(i => {
            if (i.id !== id) return i
            return { ...i, code, compiledFn: fn, compileError: error, lastError: error }
        }))
    }, [])

    const toggleInterceptor = useCallback((id: string) => {
        setInterceptors(prev => prev.map(i =>
            i.id === id ? { ...i, enabled: !i.enabled } : i
        ))
    }, [])

    const reorderInterceptors = useCallback((fromIndex: number, toIndex: number) => {
        setInterceptors(prev => {
            const updated = [...prev]
            const [removed] = updated.splice(fromIndex, 1)
            updated.splice(toIndex, 0, removed)
            return updated
        })
    }, [])

    /**
     * Applies all enabled interceptors in order via the Worker pool.
     * The Worker pool enforces 100ms terminate()-based timeouts per interceptor.
     */
    const applyInterceptors = useCallback(async (event: EventMessage): Promise<EventMessage | null> => {
        // Only pass interceptors that have valid syntax (compiledFn = true)
        const enabled = interceptors
            .filter(i => i.enabled && i.compiledFn)
            .map(i => ({ id: i.id, code: i.code, enabled: true }))

        if (enabled.length === 0) return event

        const { event: result, errors } = await applyInterceptorChain(enabled, event)

        // Reflect runtime errors in the UI only when something actually changed, so a failing interceptor does not
        // re-render the whole app for every single event. An error belongs to the code that produced it: if the user edited
        // the interceptor while this event was still being processed (a call can take up to the 100 ms limit), the error of
        // the old code must not appear against the new one.
        if (Object.keys(errors).length > 0) {
            const ranWith = new Map(enabled.map((e) => [e.id, e.code]))
            const applies = (i: Interceptor): boolean => errors[i.id] !== undefined && ranWith.get(i.id) === i.code && i.lastError !== errors[i.id]
            setInterceptors(prev => (prev.some(applies) ? prev.map(i => (applies(i) ? { ...i, lastError: errors[i.id] ?? null } : i)) : prev))
        }

        return result
    }, [interceptors])

    return {
        interceptors,
        addInterceptor,
        removeInterceptor,
        renameInterceptor,
        updateInterceptorCode,
        toggleInterceptor,
        reorderInterceptors,
        applyInterceptors,
        // hasActiveInterceptors: true if any enabled interceptor has valid syntax
        hasActiveInterceptors: interceptors.some(i => i.enabled && i.compiledFn),
    }
}
