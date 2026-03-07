// runs user-provided javascript to modify streaming events securely
// isolates execution to prevent malicious code from accessing dom or storage
// masks global apis like fetch to prevent external network calls
//
// message in  (main -> worker): { code, event }
// message out (worker -> main): { result, error }

/// <reference lib="webworker" />

import type { EventMessage } from '../types'


// explicit allowed sandbox context for user scripts
// limits available runtime functions to safe built-ins
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
        // redefine dangerous globals as undefined in the function scope closure
        // forces the user script to execute within the restricted sandbox

        const fn = new Function(
            'event', 'ctx',
            // shadow restricted globals to isolate sandbox
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
${code}`
        ) as (event: EventMessage, ctx: typeof SAFE_CTX) => EventMessage | null

        const result = fn(event, SAFE_CTX)
        self.postMessage({ result: result ?? null, error: null })
    } catch (err: any) {
        // stringify error manually because structured clone fails on custom error prototypes
        self.postMessage({
            result: event,
            error: err instanceof Error ? err.message : String(err)
        })
    }
}
