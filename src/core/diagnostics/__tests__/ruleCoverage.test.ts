// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { defaultRules } from '../rules'
import { FIXTURE_ROUTES } from '../../../fixtures/server'

// Campaign C6: the promise "every rule has a failing fixture and a healthy twin" is checked, not remembered. A rule that ships without a
// fixture stream that makes it fire, or a faulty fixture without a healthy stream to compare with, fails here, unless it is on the waiver list
// below WITH a reason. The waiver lists are exact: a waiver that is no longer needed fails too, so the lists can only shrink and the work
// they name stays visible. (The built-in self test is checked rule by rule in cli/__tests__/hardening.test.ts, S24.)

/** The finding-key prefixes each rule produces, as a fixture route would name them. A new rule must be added here. */
const RULE_KEYS: Record<string, string[]> = {
    'proto.content-type': ['proto.content-type', 'http.status'],
    'proto.framing': ['proto.framing'],
    'proto.headers-hints': ['proto.headers-hints'],
    'timing.first-event': ['timing.first-event'],
    'stall.silent': ['stall.silent'],
    'delivery.bursty': ['delivery.bursty'],
    'reconnect.loop': ['reconnect.loop', 'reconnect.duration-pattern'],
    'resume.last-event-id': ['resume.last-event-id'],
    'seq.integrity': ['seq.integrity'],
    'heartbeat.recognition': ['heartbeat.'],
    'consumer.slow': ['consumer.slow', 'consumer.queue-overflow'],
    'security.credentials-in-metadata': ['security.credentials-in-metadata'],
    'proxy.masking': ['proxy.masking', 'proxy.upstream-mismatch'],
    'clock.discontinuity': ['clock.discontinuity'],
    'schema.drift': ['schema.drift'],
}

/** Rules no fixture route makes fire yet. Each reason names the work. */
const NO_FIXTURE_YET: Record<string, string> = {
    'proxy.masking': 'R13: f04-masked expects stall.silent:origin; no fixture ROUTE expects the masking finding itself: it needs the real proxy in front of a route, which proxyInTheLoop.test.ts does (R13 fires there on the real tags, plan A6) but a route of the fixture server cannot declare.',
    'clock.discontinuity': 'R15: a clock jump cannot be produced by a server; it is unit-tested only.',
}

/** Faulty routes that have no healthy twin yet. */
const NO_TWIN_YET: Record<string, string> = {}

describe('every rule has a fixture that makes it fire, or a named reason it has not', () => {
    it('knows every rule that ships (a new rule has to be registered here)', () => {
        expect(defaultRules.map((r) => r.id).filter((id) => !(id in RULE_KEYS))).toEqual([])
        expect(Object.keys(RULE_KEYS).filter((id) => !defaultRules.some((r) => r.id === id))).toEqual([])
    })

    const covered = (ruleId: string): string[] =>
        FIXTURE_ROUTES.filter((r) => r.expectedFindings.some((k) => RULE_KEYS[ruleId]!.some((p) => k === p || k.startsWith(p)))).map((r) => r.id)

    for (const rule of defaultRules) {
        it(`${rule.id}: a fixture route expects one of its findings${rule.id in NO_FIXTURE_YET ? ' (WAIVED: ' + NO_FIXTURE_YET[rule.id] + ')' : ''}`, () => {
            const routes = covered(rule.id)
            if (rule.id in NO_FIXTURE_YET) expect(routes, 'a waiver that is no longer needed: remove it').toEqual([])
            else expect(routes.length, `no route expects ${RULE_KEYS[rule.id]!.join(' or ')}`).toBeGreaterThan(0)
        })
    }

    it('the waiver list names only rules that exist, each with a reason', () => {
        for (const [id, reason] of Object.entries(NO_FIXTURE_YET)) {
            expect(defaultRules.some((r) => r.id === id), id).toBe(true)
            expect(reason.length, id).toBeGreaterThan(20)
        }
    })
})

describe('every faulty fixture has a healthy twin to compare it with', () => {
    const faulty = FIXTURE_ROUTES.filter((r) => r.expectedFindings.length > 0)
    for (const route of faulty) {
        it(`${route.id}${route.id in NO_TWIN_YET ? ' (WAIVED)' : ''}`, () => {
            if (route.id in NO_TWIN_YET) { expect(route.healthyTwin, 'a waiver that is no longer needed: remove it').toBeFalsy(); return }
            expect(route.healthyTwin, `${route.id} names no healthy twin`).toBeTruthy()
            const twin = FIXTURE_ROUTES.find((r) => r.id === route.healthyTwin)
            expect(twin, `${route.id}'s twin ${route.healthyTwin} is not a route`).toBeDefined()
            expect(twin!.expectedFindings, `the twin ${twin!.id} must expect nothing`).toEqual([])
            expect(twin!.forbiddenFindings, `the twin ${twin!.id} must forbid every finding`).toContain('*')
        })
    }

    it('there are faulty fixtures to check (the loop above is not empty)', () => {
        expect(faulty.length).toBeGreaterThan(15)
    })
})
