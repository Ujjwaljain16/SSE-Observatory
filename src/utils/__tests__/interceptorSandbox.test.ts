import { describe, it, expect, afterAll } from 'vitest'
import { compileInterceptor, runInterceptorWithTimeout, disposeInterceptorPool } from '../interceptorSandbox'
import type { EventMessage } from '../../types'

describe('Interceptor Sandbox', () => {
    afterAll(() => {
        disposeInterceptorPool()
    })

    it('should successfully compile valid code', () => {
        const code = `return event;`
        const { fn, error } = compileInterceptor(code)
        expect(fn).toBe(true)
        expect(error).toBeNull()
    })

    it('should fail compilation on invalid syntax', () => {
        const code = `return event;;;;;; {{}`
        const { fn, error } = compileInterceptor(code)
        expect(fn).toBeNull()
        expect(error).toBeDefined()
    })

    it('should transform an event payload normally', async () => {
        const code = `
            event.data.modified = true;
            return event;
        `
        const event = { id: 'test', data: { modified: false } } as any as EventMessage
        const { result, error } = await runInterceptorWithTimeout(code, event)

        expect(error).toBeNull()
        expect((result?.data as any).modified).toBe(true)
    })

    it('should drop an event if interceptor returns null', async () => {
        const code = `return null;`
        const event = { id: 'test', data: '{}' } as unknown as EventMessage
        const { result, error } = await runInterceptorWithTimeout(code, event)

        expect(error).toBeNull()
        expect(result).toBeNull()
    })

    it('should not allow access to window', async () => {
        const code = `
            return window.location;
        `
        const event = { id: 'test', data: '{}' } as unknown as EventMessage
        const { error } = await runInterceptorWithTimeout(code, event)

        // It should either return the event unchanged with an error, or the worker catches it
        expect(error).toContain('Cannot read properties of undefined (reading \'location\')')
    })

    it('should not allow access to document', async () => {
        const code = `
            document.body.innerHTML = "hacked";
            return event;
        `
        const event = { id: 'test', data: '{}' } as unknown as EventMessage
        const { error } = await runInterceptorWithTimeout(code, event)

        expect(error).toContain('Cannot read properties of undefined (reading \'body\')')
    })

    it('should not allow access to fetch', async () => {
        const code = `
            fetch("http://evil.com");
            return event;
        `
        const event = { id: 'test', data: '{}' } as unknown as EventMessage
        const { error } = await runInterceptorWithTimeout(code, event)

        expect(error).toContain('fetch is not a function')
    })

    it.skip('should timeout on synchronous infinite loop', async () => {
        const code = `
            while (true) {}
            return event;
        `
        const event = { id: 'test', data: '{}' } as unknown as EventMessage
        const { result, error } = await runInterceptorWithTimeout(code, event)

        expect(error).toContain('Interceptor exceeded 100ms — killed')
        expect(result?.id).toBe('test') // Return original event un-mutated
    })
})
