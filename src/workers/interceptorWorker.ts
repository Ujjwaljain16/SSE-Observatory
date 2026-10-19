// Runs user-written interceptor code in isolation.
//
//   pool → worker:  { id, code, event }
//   worker → pool:  { type: 'ready' }   once, after the sandbox is locked down
//                   { id, result, error } per request
//
// Isolation: everything this file needs is captured first; then the global scope is stripped down to pure
// language intrinsics and every route to eval/Function is closed (see utils/sandboxHarden.ts). The code then
// has no network, storage, timers or messaging, so the only thing it can do is compute a result.
// Runaway code (infinite loops) is stopped by the pool, which terminates this worker after a short deadline.

/// <reference lib="webworker" />

import { hardenGlobal } from '../utils/sandboxHarden'
import { createInterceptorRunner, type RunnerDeps } from './interceptorCore'

// --- capture what we need before the global scope is stripped ------------------------------------
const post = self.postMessage.bind(self) as (message: unknown) => void
const JSONRef = JSON
const atobRef = atob
const btoaRef = btoa
const log = (kind: 'log' | 'warn') => (...args: unknown[]) => console[kind]('[interceptor]', ...args)

const SAFE_CTX = Object.freeze({
    JSON: Object.freeze({ parse: JSONRef.parse.bind(JSONRef), stringify: JSONRef.stringify.bind(JSONRef) }),
    atob: (s: string) => atobRef(s),
    btoa: (s: string) => btoaRef(s),
    Math,
    Date,
    console: Object.freeze({ log: log('log'), warn: log('warn') }),
})

const run = createInterceptorRunner({
    compile: Function as unknown as RunnerDeps['compile'],
    ctx: SAFE_CTX,
    stringify: (v) => JSONRef.stringify(v),
})

self.addEventListener('message', (e) => post(run((e as MessageEvent).data)))

hardenGlobal(self as unknown as Record<string, unknown>)
post({ type: 'ready' })
