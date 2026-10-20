import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { defaultRules } from '../../core/diagnostics/rules'
import { compareCaptures } from '../../core/capture/derived'
import { startFixtureServer, type FixtureServer } from '../server'
import { observeFixture } from './observeFixture'

let server: FixtureServer
beforeAll(async () => { server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server.close() })

const observe = (id: string) => observeFixture(server, defaultRules, id)

describe('F09: one stream behind two paths, compared as two captures', () => {
    it('both streams are fine on their own', async () => {
        expect((await observe('f09-healthy')).findings).toEqual([])
        expect((await observe('f09-buffered')).findings).toEqual([])
    })

    it('the comparison finds the buffering signature in only one of them, and names no layer', async () => {
        const healthy = await observe('f09-healthy')
        const buffered = await observe('f09-buffered')
        const findings = compareCaptures(healthy.capture, buffered.capture)
        const chunks = findings.find((f) => f.key === 'compare.chunk-sizes')!
        expect(chunks.severity).toBe('warning')
        expect(chunks.summary).toMatch(/B received/)
        expect(chunks.deductions[0]!.statement).toMatch(/^Likely: a layer between A and B buffers/)
        expect(JSON.stringify(chunks)).not.toMatch(/nginx|cloudflare|proxy server/i)
        // the events themselves are the same
        expect(findings.find((f) => f.key === 'compare.events')?.severity ?? 'info').toBe('info')
    })

    it('comparing the healthy stream with itself raises nothing above info', async () => {
        const a = await observe('f09-healthy')
        const b = await observe('f09-healthy')
        expect(compareCaptures(a.capture, b.capture).filter((f) => f.severity !== 'info')).toEqual([])
    })
})
