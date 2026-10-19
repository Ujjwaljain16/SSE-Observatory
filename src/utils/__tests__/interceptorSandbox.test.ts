import { describe, it, expect, afterEach, vi } from 'vitest'
import { compileInterceptor, runInterceptorWithTimeout, applyInterceptorChain, disposeInterceptorPool, InterceptorWorkerPool } from '../interceptorSandbox'
import type { EventMessage } from '../../types'

const ev = (data = '{}', extra: Partial<EventMessage> = {}): EventMessage =>
    ({ id: 'e1', type: 'message', timestamp: 't', raw: '', data, ...extra })

afterEach(() => disposeInterceptorPool())

// In jsdom the global Worker is a MockWorker that runs the REAL interceptor core (same code as production),
// so these tests cover the request/response protocol, normalisation and the pool.
describe('compileInterceptor (editor feedback)', () => {
    it('accepts valid code and reports syntax errors', () => {
        expect(compileInterceptor('return event;')).toEqual({ fn: true, error: null })
        const bad = compileInterceptor('return event;;;;;; {{}')
        expect(bad.fn).toBeNull()
        expect(bad.error).toBeTruthy()
    })
    it('does not reject variable names the old sandbox reserved (origin, location...)', () => {
        expect(compileInterceptor('const origin = event.type; const location = 1; return event;').fn).toBe(true)
    })
    it('rejects dynamic import up front', () => {
        expect(compileInterceptor('const m = await import("data:text/javascript,1"); return event;').error).toMatch(/import/)
    })
})

describe('runInterceptorWithTimeout', () => {
    it('transforms events', async () => {
        const { result, error } = await runInterceptorWithTimeout('event.data = event.data.toUpperCase(); return event;', ev('hello'))
        expect(error).toBeNull()
        expect(result?.data).toBe('HELLO')
    })

    it('returning null drops the event', async () => {
        expect(await runInterceptorWithTimeout('return null;', ev())).toEqual({ result: null, error: null })
    })

    it('returning nothing is an error that keeps the event (it used to silently drop everything)', async () => {
        const { result, error } = await runInterceptorWithTimeout('const unused = 1;', ev('keep'))
        expect(error).toMatch(/returned nothing/)
        expect(result?.data).toBe('keep')
    })

    it('rejects non-object results', async () => {
        const { error } = await runInterceptorWithTimeout('return 42;', ev())
        expect(error).toMatch(/must return an event object or null/)
    })

    it('merges a partial result over the original and stringifies object payloads', async () => {
        const { result } = await runInterceptorWithTimeout('return { data: { redacted: true } };', ev('{"secret":1}', { id: 'keep-id', type: 'order' }))
        expect(result).toMatchObject({ id: 'keep-id', type: 'order', data: '{"redacted":true}' })
    })

    it('a throwing interceptor reports the error and passes the event through unchanged', async () => {
        const { result, error } = await runInterceptorWithTimeout('throw new Error("boom")', ev('orig'))
        expect(error).toBe('boom')
        expect(result?.data).toBe('orig')
    })

    it('can use the safe ctx helpers', async () => {
        const { result } = await runInterceptorWithTimeout('return { data: ctx.btoa(event.data) };', ev('hello'))
        expect(result?.data).toBe('aGVsbG8=')
        const parsed = await runInterceptorWithTimeout('const o = ctx.JSON.parse(event.data); o.n *= 2; return { data: ctx.JSON.stringify(o) };', ev('{"n":21}'))
        expect(parsed.result?.data).toBe('{"n":42}')
    })

    it('refuses dynamic import at run time too (defence in depth)', async () => {
        const { error } = await runInterceptorWithTimeout('return import("data:text/javascript,export default 1");', ev())
        expect(error).toMatch(/import/)
    })
})

describe('applyInterceptorChain', () => {
    it('chains in order, skips disabled ones, and stops at a drop', async () => {
        const out = await applyInterceptorChain([
            { id: '1', code: 'return { data: event.data + "-A" };', enabled: true },
            { id: '2', code: 'return { data: "never" };', enabled: false },
            { id: '3', code: 'return { data: event.data + "-B" };', enabled: true },
        ], ev('X'))
        expect(out.event?.data).toBe('X-A-B')

        const dropped = await applyInterceptorChain([
            { id: '1', code: 'return null;', enabled: true },
            { id: '2', code: 'return { data: "never" };', enabled: true },
        ], ev('X'))
        expect(dropped.event).toBeNull()
    })

    it('isolates failures: an error is recorded and the chain continues with the unchanged event', async () => {
        const out = await applyInterceptorChain([
            { id: 'bad', code: 'throw new Error("crash")', enabled: true },
            { id: 'good', code: 'return { data: event.data + "!" };', enabled: true },
        ], ev('X'))
        expect(out.event?.data).toBe('X!')
        expect(out.errors).toEqual({ bad: 'crash' })
    })
})

describe('InterceptorWorkerPool', () => {
    class FakeWorker {
        static all: FakeWorker[] = []
        onmessage: ((e: MessageEvent) => void) | null = null
        onerror: ((e: ErrorEvent) => void) | null = null
        terminated = false
        constructor(public readonly hang: boolean) { FakeWorker.all.push(this) }
        postMessage(msg: { id: number; code: string; event: EventMessage }) {
            if (msg.code.includes('while(true)')) return // never answers, like an infinite loop
            setTimeout(() => this.onmessage?.({ data: { id: msg.id, result: msg.event, error: null } } as MessageEvent), 1)
        }
        terminate() { this.terminated = true }
        announceReady() { this.onmessage?.({ data: { type: 'ready' } } as MessageEvent) }
    }

    const setup = () => {
        FakeWorker.all = []
        vi.stubGlobal('Worker', class extends FakeWorker { constructor() { super(false) } })
    }
    afterEach(() => vi.unstubAllGlobals())

    it('does not start the clock until a worker is ready, so a slow start-up is not a timeout', async () => {
        setup()
        const pool = new InterceptorWorkerPool(1, 30)
        const p = pool.run('return event;', ev('a'))
        await new Promise((r) => setTimeout(r, 120)) // far longer than the 30 ms deadline, worker still starting
        FakeWorker.all[0].announceReady()
        expect((await p).error).toBeNull()
        pool.dispose()
    })

    it('kills a runaway job, replaces the worker, and keeps serving later jobs', async () => {
        setup()
        const pool = new InterceptorWorkerPool(1, 30)
        FakeWorker.all[0].announceReady()
        const hung = await pool.run('while(true){}', ev('x'))
        expect(hung.error).toMatch(/exceeded 30ms/)
        expect(hung.result?.data).toBe('x')
        expect(FakeWorker.all[0].terminated).toBe(true)
        expect(FakeWorker.all).toHaveLength(2) // a fresh worker replaced it
        FakeWorker.all[1].announceReady()
        expect((await pool.run('return event;', ev('y'))).error).toBeNull()
        pool.dispose()
    })

    it('queues jobs beyond the pool size instead of spawning more workers', async () => {
        setup()
        const pool = new InterceptorWorkerPool(2, 200)
        FakeWorker.all.forEach((w) => w.announceReady())
        const results = await Promise.all(Array.from({ length: 20 }, (_, i) => pool.run('return event;', ev(String(i)))))
        expect(results.map((r) => r.result?.data)).toEqual(Array.from({ length: 20 }, (_, i) => String(i)))
        expect(FakeWorker.all).toHaveLength(2)
        pool.dispose()
    })

    it('replaces a crashed worker and reports the error for the job it was running', async () => {
        setup()
        const pool = new InterceptorWorkerPool(1, 500)
        FakeWorker.all[0].announceReady()
        const p = pool.run('while(true){}', ev('z'))
        await new Promise((r) => setTimeout(r, 5))
        FakeWorker.all[0].onerror?.({ message: 'out of memory' } as ErrorEvent)
        const r = await p
        expect(r.error).toBe('out of memory')
        expect(FakeWorker.all).toHaveLength(2)
        pool.dispose()
    })

    it('dispose() terminates workers and settles pending jobs', async () => {
        setup()
        const pool = new InterceptorWorkerPool(1, 500)
        const p = pool.run('return event;', ev())
        pool.dispose()
        expect((await p).error).toMatch(/disposed/)
        expect(FakeWorker.all.every((w) => w.terminated)).toBe(true)
        expect((await pool.run('return event;', ev())).error).toMatch(/disposed/)
    })
})
