/**
 * Hardening for the interceptor worker.
 *
 * User-written interceptor code runs inside a dedicated worker. Shadowing a few names (`const fetch = undefined`)
 * is not isolation: `(function(){}).constructor('return globalThis')()` hands the code the real global scope.
 * Instead, before any user code is compiled, this function
 *
 *   1. replaces every route to the dynamic-code constructors (Function, eval, and the constructors reachable from
 *      function / async / generator prototypes) with a function that throws, and
 *   2. removes everything from the global scope that is not a pure ECMAScript/Encoding/URL intrinsic: no network,
 *      storage, workers, timers, WebAssembly, `postMessage`, ...
 *
 * The caller must capture whatever it still needs (`postMessage`, `Function`, ...) BEFORE calling this.
 *
 * NOTE: this function is stringified and evaluated inside a fresh realm in tests, so it must stay
 * self-contained (no imports, no references to outer variables).
 */
export function hardenGlobal(g: Record<string, unknown>): { removed: string[]; failed: string[] } {
    const blocked = function blockedDynamicCode(): never {
        throw new Error('Dynamic code evaluation is disabled inside interceptors')
    }

    // --- 1. dynamic code ------------------------------------------------------------------------
    const fnProtos: object[] = [Function.prototype]
    for (const make of [
        () => Object.getPrototypeOf(async function () { /* noop */ }),
        () => Object.getPrototypeOf(function* () { /* noop */ }),
        () => Object.getPrototypeOf(async function* () { /* noop */ }),
    ]) {
        try { fnProtos.push(make()) } catch { /* syntax unsupported in this engine */ }
    }
    for (const proto of fnProtos) {
        try { Object.defineProperty(proto, 'constructor', { value: blocked, writable: false, configurable: false }) } catch { /* already locked */ }
    }
    for (const name of ['Function', 'eval']) {
        try { Object.defineProperty(g, name, { value: blocked, writable: false, configurable: false }) } catch { /* ignore */ }
    }

    // --- 2. capability allow-list ---------------------------------------------------------------
    const allowed = new Set([
        // ECMAScript intrinsics
        'Object', 'Function', 'Array', 'Number', 'parseFloat', 'parseInt', 'Infinity', 'NaN', 'undefined', 'Boolean', 'String',
        'Symbol', 'Date', 'Promise', 'RegExp', 'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError',
        'SyntaxError', 'TypeError', 'URIError', 'globalThis', 'JSON', 'Math', 'Intl', 'ArrayBuffer', 'Atomics', 'Uint8Array',
        'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'Uint8ClampedArray',
        'BigUint64Array', 'BigInt64Array', 'DataView', 'Map', 'BigInt', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect',
        'FinalizationRegistry', 'WeakRef', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape',
        'unescape', 'isFinite', 'isNaN', 'eval', 'Iterator',
        // pure data helpers
        'atob', 'btoa', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'structuredClone', 'console', 'self',
    ])

    const removed: string[] = []
    const failed: string[] = []
    const seen = new Set<object>()
    // The global object, plus the prototypes it inherits browser APIs from (WorkerGlobalScope & co), stopping before Object.prototype.
    let obj: object | null = g
    while (obj && obj !== Object.prototype && !seen.has(obj)) {
        seen.add(obj)
        for (const name of Object.getOwnPropertyNames(obj)) {
            if (allowed.has(name) || name === 'constructor') continue
            const desc = Object.getOwnPropertyDescriptor(obj, name)
            if (!desc) continue
            let done = false
            if (desc.configurable) {
                try { done = delete (obj as Record<string, unknown>)[name] } catch { /* fall through */ }
            }
            if (!done && 'value' in desc && desc.writable) {
                try { (obj as Record<string, unknown>)[name] = undefined; done = true } catch { /* fall through */ }
            }
            if (!done) {
                try {
                    Object.defineProperty(obj, name, { get: () => undefined, set: () => undefined, configurable: false })
                    done = true
                } catch { /* ignore */ }
            }
            ;(done ? removed : failed).push(name)
        }
        obj = Object.getPrototypeOf(obj)
    }
    return { removed, failed }
}

const IMPORT_TOKEN = /\bimport\b/

/**
 * Dynamic `import()` cannot be shadowed or removed — it is syntax, and it would load code that runs with the real
 * global scope. Interceptors never need modules, so any mention of the token is rejected up front.
 * (Conservative: it also rejects the word "import" inside string literals.)
 */
export function findForbiddenSyntax(code: string): string | null {
    return IMPORT_TOKEN.test(code) ? '"import" is not available in interceptors' : null
}
