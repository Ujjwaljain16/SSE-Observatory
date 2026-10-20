import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { defaultRules } from '../../core/diagnostics/rules'
import { sequenceIntegrity } from '../../core/diagnostics/rules/r09SequenceIntegrity'
import { resumeLastEventId } from '../../core/diagnostics/rules/r08ResumeLastEventId'
import type { Finding } from '../../core/diagnostics/finding'
import { startFixtureServer, type FixtureServer } from '../server'
import { observeFixture } from './observeFixture'

let server: FixtureServer
beforeAll(async () => { server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server.close() })

const RULES = [...defaultRules, sequenceIntegrity, resumeLastEventId]
const observe = (id: string, query: Record<string, string | number> = {}, withContract = true) => observeFixture(server, RULES, id, query, withContract)

const keys = (findings: Finding[]) => findings.map((f) => f.key)

describe('F06: a resume that skips ids', () => {
    it('reports the skipped events once, as the resume rule, when the sequence is declared', async () => {
        const { findings, observations } = await observe('f06-skips')
        expect(observations.some((o) => o.kind === 'reconnect')).toBe(true)
        const skipped = findings.find((f) => f.key === 'resume.last-event-id:skipped')!
        expect(skipped.severity).toBe('error')
        expect(skipped.summary).toMatch(/5-7|5, 6, 7|4-6|numbers between/)
        expect(keys(findings)).not.toContain('seq.integrity:gap')
    })

    it('says nothing about loss when the sequence is not declared (opaque ids prove nothing)', async () => {
        const { findings, coverage } = await observe('f06-skips', {}, false)
        expect(keys(findings).filter((k) => k.startsWith('seq.') || k.includes(':skipped'))).toEqual([])
        expect(coverage.find((c) => c.ruleId === 'seq.integrity')!.notes.join(' ')).toMatch(/not verified/)
    })

    it('stays silent for the twin that resumes correctly', async () => {
        const { findings, observations } = await observe('f06-resumes')
        expect(observations.some((o) => o.kind === 'reconnect')).toBe(true)
        expect(findings.map((f) => `${f.key}: ${f.summary}`)).toEqual([])
    })
})

describe('F07: a flood of tiny events', () => {
    it('raises no network or sequence finding while thousands of events arrive', async () => {
        const { findings, events } = await observe('f07-flood')
        expect(events).toBeGreaterThanOrEqual(2000)
        expect(findings.map((f) => `${f.key}: ${f.summary}`)).toEqual([])
    })
})
