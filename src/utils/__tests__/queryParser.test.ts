import { describe, it, expect } from 'vitest'
import { QueryParser } from '../queryParser'
import type { EventMessage } from '../../types'

describe('QueryParser', () => {
    it('should parse simple equality', () => {
        const parser = new QueryParser('level == "error"')
        const ast = parser.parse()
        expect(ast).toEqual({
            type: 'comparison',
            operator: '==',
            left: 'level',
            right: 'error'
        })
    })

    it('should compile and evaluate equality', () => {
        const parser = new QueryParser('level == "error"')
        const fn = parser.compile(parser.parse())

        expect(fn({ id: '1', data: { level: 'error' } } as unknown as EventMessage)).toBe(true)
        expect(fn({ id: '2', data: { level: 'info' } } as unknown as EventMessage)).toBe(false)
    })

    it('should handle numeric comparisons', () => {
        const parser = new QueryParser('status > 400')
        const fn = parser.compile(parser.parse())

        expect(fn({ id: '1', data: { status: 500 } } as unknown as EventMessage)).toBe(true)
        expect(fn({ id: '2', data: { status: 400 } } as unknown as EventMessage)).toBe(false)
    })

    it('should evaluate logical AND', () => {
        const parser = new QueryParser('level == "info" AND status == 200')
        const fn = parser.compile(parser.parse())

        expect(fn({ id: '1', data: { level: 'info', status: 200 } } as unknown as EventMessage)).toBe(true)
        expect(fn({ id: '2', data: { level: 'error', status: 200 } } as unknown as EventMessage)).toBe(false)
    })

    it('should evaluate nested parens', () => {
        const parser = new QueryParser('(level == "info" OR level == "warn") AND status == 200')
        const fn = parser.compile(parser.parse())

        expect(fn({ id: '1', data: { level: 'warn', status: 200 } } as unknown as EventMessage)).toBe(true)
        expect(fn({ id: '2', data: { level: 'error', status: 200 } } as unknown as EventMessage)).toBe(false)
        expect(fn({ id: '3', data: { level: 'warn', status: 500 } } as unknown as EventMessage)).toBe(false)
    })

    it('should evaluate contains', () => {
        const parser = new QueryParser('message contains "timeout"')
        const fn = parser.compile(parser.parse())

        expect(fn({ id: '1', data: { message: 'Connection timeout occurred' } } as unknown as EventMessage)).toBe(true)
        expect(fn({ id: '2', data: { message: 'Normal operation' } } as unknown as EventMessage)).toBe(false)
    })

    it('should compile matches (regex)', () => {
        const parser = new QueryParser('requestId matches "^REQ-\\d+$"')
        const fn = parser.compile(parser.parse())

        expect(fn({ id: '1', data: { requestId: 'REQ-1234' } } as unknown as EventMessage)).toBe(true)
        expect(fn({ id: '2', data: { requestId: 'REQ-ABCD' } } as unknown as EventMessage)).toBe(false)
    })

    it('should throw on syntax errors', () => {
        expect(() => {
            const parser = new QueryParser('level == "error" AND OR')
            parser.parse()
        }).toThrow()
    })
})
