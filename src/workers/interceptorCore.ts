// The logic of the interceptor worker, free of any browser-global dependency so it can be unit-tested.
// interceptorWorker.ts wires it to postMessage and locks the sandbox down first.

import type { EventMessage } from '../types'
import { findForbiddenSyntax } from '../utils/sandboxHarden'

export interface InterceptorRequest { id: number; code: string; event: EventMessage }
export interface InterceptorResponse { id: number; result: EventMessage | null; error: string | null }

type InterceptorFn = (event: EventMessage, ctx: object) => unknown

export interface RunnerDeps {
    /** The REAL Function constructor, captured before the global scope is hardened. */
    compile: (...args: string[]) => InterceptorFn
    /** The only object user code can reach besides `event`. */
    ctx: object
    stringify: (value: unknown) => string
}

const MAX_CACHE = 32

export function createInterceptorRunner({ compile, ctx, stringify }: RunnerDeps) {
    const cache = new Map<string, InterceptorFn>()

    const getFunction = (code: string): InterceptorFn => {
        let fn = cache.get(code)
        if (!fn) {
            const forbidden = findForbiddenSyntax(code)
            if (forbidden) throw new Error(forbidden)
            fn = compile('event', 'ctx', `"use strict";\n${code}`)
            if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string)
            cache.set(code, fn)
        }
        return fn
    }

    /** Normalises what the user returned into a full event, or null (= drop the event). */
    const normalise = (original: EventMessage, result: unknown): EventMessage | null => {
        if (result === null) return null
        if (result === undefined) throw new Error('The interceptor returned nothing. Return the event (possibly modified), or null to drop it.')
        if (typeof result !== 'object') throw new Error(`The interceptor must return an event object or null, not ${typeof result}.`)
        const merged = { ...original, ...(result as Partial<EventMessage>) } as EventMessage
        if (typeof merged.data !== 'string') merged.data = stringify(merged.data)
        return merged
    }

    return function run({ id, code, event }: InterceptorRequest): InterceptorResponse {
        try {
            return { id, result: normalise(event, getFunction(code)(event, ctx)), error: null }
        } catch (err) {
            // Errors are reduced to strings: structured clone cannot transfer arbitrary error objects.
            return { id, result: event, error: err instanceof Error ? err.message : String(err) }
        }
    }
}
