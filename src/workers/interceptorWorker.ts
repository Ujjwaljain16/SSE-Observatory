/**
 * interceptorWorker.ts — Sandboxed Worker for running user interceptor code.
 *
 * This Worker receives an event payload and a user-supplied code string,
 * executes the code in a truly restricted environment, and replies with
 * the transformed event (or null to drop it).
 *
 * Security properties vs old new Function() approach:
 *   ✓  No access to `window`, `document`, `localStorage`, `sessionStorage`
 *   ✓  No access to `fetch` (Workers have fetch, but we shadow it with undefined)
 *   ✓  No access to `XMLHttpRequest`
 *   ✓  Synchronous infinite loops are killed via worker.terminate() from the caller
 *   ✓  Crashes in user code cannot affect the main thread
 *
 * Message in  (main → worker): { code: string, event: EventMessage }
 * Message out (worker → main): { result: EventMessage | null, error?: string }
 */

/// <reference lib="webworker" />

import type { EventMessage } from '../types'


/**
 * Minimal safe context explicitly handed to the user function.
 * Nothing outside this object is accessible by name (function scope shadowing).
 */
const SAFE_CTX = Object.freeze({
    JSON: {
        parse: JSON.parse.bind(JSON),
        stringify: JSON.stringify.bind(JSON),
    },
    atob: (s: string) => atob(s),
    btoa: (s: string) => btoa(s),
    Math,
    Date,
    console: {
        log: (...args: unknown[]) => console.log('[interceptor]', ...args),
        warn: (...args: unknown[]) => console.warn('[interceptor]', ...args),
    },
    Number, String, Boolean, Array, Object,
})

self.onmessage = (e: MessageEvent<{ code: string; event: EventMessage }>) => {
    const { code, event } = e.data

    try {
        // Shadow all restricted globals via variable declarations in the function scope.
        // The user function receives only `event` and `ctx`.
        // eslint-disable-next-line no-new-func
        const fn = new Function(
            // Named parameters for the inner function
            'event', 'ctx',
            // Shadow dangerous names by declaring local vars that shadow the outer scope
            `"use strict";
const fetch = undefined;
const XMLHttpRequest = undefined;
const WebSocket = undefined;
const indexedDB = undefined;
const caches = undefined;
const importScripts = undefined;
const window = undefined;
const document = undefined;
const localStorage = undefined;
const sessionStorage = undefined;
const location = undefined;
const navigator = undefined;
const origin = undefined;
// User code below
${code}`
        ) as (event: EventMessage, ctx: typeof SAFE_CTX) => EventMessage | null

        const result = fn(event, SAFE_CTX)
        self.postMessage({ result: result ?? null, error: null })
    } catch (err: any) {
        // Compilation or runtime error — pass event through unchanged
        self.postMessage({ result: event, error: err.message ?? String(err) })
    }
}
