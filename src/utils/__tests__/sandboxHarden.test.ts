// @vitest-environment node
import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { hardenGlobal, findForbiddenSyntax } from '../sandboxHarden'

const CAPABILITIES = `
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'SharedWorker', 'Worker', 'BroadcastChannel']) {
        globalThis[name] = function () { return 'capability:' + name }
    }
    globalThis.indexedDB = {}
    globalThis.caches = {}
    globalThis.crypto = {}
    globalThis.navigator = { sendBeacon: () => true }
    globalThis.location = { href: 'https://app.example/' }
    globalThis.postMessage = () => 'posted'
    globalThis.setTimeout = () => 1
    globalThis.setInterval = () => 1
    globalThis.WebAssembly = { compile() {} }
    globalThis.secretGlobal = 'should be gone'
    globalThis.btoa = (s) => 'b64:' + s   // a pure data helper the worker keeps
    globalThis.atob = (s) => s
`

/**
 * The lockdown permanently alters the realm it runs in (non-configurable properties), so it is exercised in a
 * fresh vm realm that mimics a worker global: browser-only capabilities are defined first, then the REAL
 * hardenGlobal source is evaluated inside that realm. The context is created empty on purpose: passing a sandbox
 * object would leak the host realm's Object/Function into it and make escape tests meaningless.
 */
function createHardenedRealm() {
    const context = vm.createContext()
    vm.runInContext(CAPABILITIES, context)
    const report = vm.runInContext(`(${hardenGlobal.toString()})(globalThis)`, context) as { removed: string[]; failed: string[] }
    const run = (code: string) => vm.runInContext(code, context)
    return { run, report }
}

describe('hardenGlobal', () => {
    const { run, report } = createHardenedRealm()
    const fails = (code: string, pattern: RegExp) => {
        let message = ''
        try { run(code) } catch (e) { message = String((e as Error).message) }
        expect(message, code).toMatch(pattern)
    }

    it('reports what it removed', () => {
        for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'indexedDB', 'postMessage', 'WebAssembly', 'secretGlobal']) {
            expect(report.removed, name).toContain(name)
        }
        expect(report.failed).toEqual([])
    })

    it('removes network, storage, messaging, workers and timers from the global scope', () => {
        for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches',
            'navigator', 'location', 'postMessage', 'setTimeout', 'setInterval', 'WebAssembly', 'SharedWorker', 'Worker',
            'BroadcastChannel', 'crypto', 'secretGlobal']) {
            expect(run(`typeof ${name}`), name).toBe('undefined')
        }
        fails('fetch("https://evil.example")', /fetch is not defined/)
    })

    it('closes every route to dynamic code', () => {
        const blocked = /Dynamic code evaluation is disabled/
        fails('Function("return 1")()', blocked)
        fails('new Function("return 1")', blocked)
        fails('eval("1+1")', blocked)
        fails('(0, eval)("1+1")', blocked)
        fails('(function(){}).constructor("return globalThis")()', blocked)
        fails('(() => {}).constructor("return globalThis")()', blocked)
        fails('(async function(){}).constructor("return globalThis")()', blocked)
        fails('(function*(){}).constructor("return globalThis")()', blocked)
        fails('(async function*(){}).constructor("return globalThis")()', blocked)
        fails('[].map.constructor("return globalThis")()', blocked)
        fails('Object.constructor("return globalThis")()', blocked)
        // NOTE: globalThis.constructor.constructor is the classic escape from Node's vm module (its global template
        // functions belong to the host realm); that is a vm artefact. In a real worker it is verified in a browser.
        fails('Reflect.construct(Object.getPrototypeOf(function(){}).constructor, ["return 1"])', blocked)
    })

    it('the classic escape no longer reaches the real global (the bug this replaces)', () => {
        fails('(function(){}).constructor("return fetch")()', /Dynamic code evaluation is disabled/)
    })

    it('cannot be undone by user code', () => {
        const fnProto = 'Object.getPrototypeOf(function(){})'
        fails(`Object.defineProperty(${fnProto}, 'constructor', { value: Object })`, /Cannot redefine property/)
        fails(`'use strict'; delete ${fnProto}.constructor`, /Cannot delete property/)
        fails(`'use strict'; ${fnProto}.constructor = Object`, /read only|Cannot assign/)
        fails('Function = Object; (function(){}).constructor("return 1")()', /Dynamic code evaluation is disabled|Cannot assign|read only/)
    })

    it('leaves ordinary computation working', () => {
        expect(run('JSON.stringify({ a: [1, 2, 3].map(n => n * 2) })')).toBe('{"a":[2,4,6]}')
        expect(run('Math.max(1, 5, 3)')).toBe(5)
        expect(run('new Date(0).toISOString()')).toBe('1970-01-01T00:00:00.000Z')
        expect(run('btoa("x")')).toBe('b64:x')
        expect(run('new Map([[1, 2]]).get(1)')).toBe(2)
        expect(run('[3, 1, 2].sort().join("")')).toBe('123')
        expect(run('Object.keys({ a: 1, b: 2 }).length')).toBe(2)
        expect(run('(() => { try { null.x } catch (e) { return e instanceof TypeError } })()')).toBe(true)
        expect(run('Promise.resolve(1) instanceof Promise')).toBe(true)
    })
})

describe('findForbiddenSyntax', () => {
    it('rejects the import keyword (dynamic import cannot be shadowed or removed)', () => {
        expect(findForbiddenSyntax('return import("x")')).toMatch(/import/)
        expect(findForbiddenSyntax('const x = await import ("x")')).toMatch(/import/)
        expect(findForbiddenSyntax('return event;')).toBeNull()
        expect(findForbiddenSyntax('const important = 1; return event;')).toBeNull() // whole word only
    })
})
