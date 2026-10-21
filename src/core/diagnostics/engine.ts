import { SEVERITY_RANK, type Finding, type FindingDraft, type Severity } from './finding'
import { CAPABILITY_EVIDENCE, type Capability, type Rule, type RuleInstance } from './rule'
import { defaultRules } from './rules'
import { StreamModel, type EngineInput } from './streamModel'
import { resolveThresholds, type StreamProfile, type Thresholds } from './thresholds'

export interface EngineOptions {
    /** Defaults to the shipped rule set. */
    rules?: Rule[] | undefined
    thresholds?: Partial<Thresholds> | undefined
    profile?: StreamProfile | undefined
}

export interface RuleCoverage {
    ruleId: string
    ruleVersion: number
    title: string
    /** `not-evaluated` is not the same as healthy: the rule could not look. */
    status: 'evaluated' | 'not-evaluated'
    missingCapabilities: Capability[]
    /** Record kinds that would have satisfied the missing capabilities. */
    missingKinds: string[]
    notes: string[]
}

export interface Engine {
    readonly model: StreamModel
    /** Apply one observation, in order. */
    feed(o: EngineInput): void
    /** Let time pass with nothing observed. Shows what is still going on at `nowT`; changes nothing permanently. */
    tick(nowT: number): void
    /** The capture ended at `endT`: whatever is still going on is final. */
    end(endT: number): void
    findings(): Finding[]
    coverage(): RuleCoverage[]
}

interface Entry { rule: Rule; instance: RuleInstance }

const byImportance = (a: Finding, b: Finding): number =>
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.firstSeenT - b.firstSeenT || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

export function createEngine(options: EngineOptions = {}): Engine {
    const thresholds = resolveThresholds(options.thresholds)
    const profile = options.profile ?? {}
    const model = new StreamModel(thresholds)
    // A rule listed twice (the default set plus the same rule added by hand) runs once.
    const rules = [...new Map((options.rules ?? defaultRules).map((rule) => [rule.id, rule])).values()]
    const entries: Entry[] = rules.map((rule) => ({ rule, instance: rule.create({ thresholds, profile }) }))
    const kept = new Map<string, Finding>()
    let provisional = new Map<string, Finding>()
    let ended = false

    // A severity can come from a record in a file somebody sent: anything that is not one of the four is shown as info, so no
    // renderer ever prints text from a file as a class or a label, and a gate never meets a rank it cannot compare.
    const known = (severity: string): Severity => (Object.prototype.hasOwnProperty.call(SEVERITY_RANK, severity) ? (severity as Severity) : 'info')
    const store = (target: Map<string, Finding>, rule: Rule, drafts: FindingDraft[] | void): void => {
        if (!drafts) return
        for (const d of drafts) target.set(d.key, { ...d, severity: known(d.severity), ruleId: rule.id, ruleVersion: rule.version, status: d.status ?? 'open' })
    }

    return {
        model,
        feed(o) {
            if (ended) return
            model.update(o)
            provisional = new Map()
            for (const { rule, instance } of entries) store(kept, rule, instance.onObservation(o, model))
        },
        tick(nowT) {
            if (ended) return
            const at = Math.max(nowT, model.nowT)
            provisional = new Map()
            for (const { rule, instance } of entries) store(provisional, rule, instance.onTick?.(at, model))
        },
        end(endT) {
            if (ended) return
            const at = Math.max(endT, model.nowT)
            provisional = new Map()
            for (const { rule, instance } of entries) store(kept, rule, instance.onEnd?.(at, model))
            ended = true
        },
        findings() {
            const merged = new Map(kept)
            for (const [key, f] of provisional) merged.set(key, f)
            return [...merged.values()].sort(byImportance)
        },
        coverage() {
            return entries.map(({ rule, instance }): RuleCoverage => {
                const missingCapabilities = rule.requires.filter((cap) => !CAPABILITY_EVIDENCE[cap].some((kind) => model.seenKinds.has(kind)))
                const missingKinds = [...new Set(missingCapabilities.flatMap((cap) => CAPABILITY_EVIDENCE[cap]))]
                if (missingCapabilities.length > 0) {
                    const needs = missingCapabilities.map((c) => c).join(', ')
                    return { ruleId: rule.id, ruleVersion: rule.version, title: rule.title, status: 'not-evaluated', missingCapabilities, missingKinds, notes: [`Not evaluated: the capture has no ${needs} records (needs ${missingKinds.join(' or ') || 'a recorder that supports it'}).`] }
                }
                const extra = instance.coverage?.(model)
                return {
                    ruleId: rule.id, ruleVersion: rule.version, title: rule.title,
                    status: extra && !extra.evaluated ? 'not-evaluated' : 'evaluated',
                    missingCapabilities: [], missingKinds: [], notes: extra?.notes ?? [],
                }
            })
        },
    }
}

export interface AnalyzeOptions extends EngineOptions {
    /** When the capture ended (virtual time). Defaults to the last observation. A later value lets a trailing silence be judged. */
    endT?: number | undefined
}

export interface Analysis {
    findings: Finding[]
    coverage: RuleCoverage[]
    model: StreamModel
}

/** Offline analysis on virtual time: feeds everything, ticks at each observation time and at the end. */
export function analyze(observations: Iterable<EngineInput>, options: AnalyzeOptions = {}): Analysis {
    const engine = createEngine(options)
    let last = 0
    for (const o of observations) {
        engine.feed(o)
        engine.tick(o.t)
        last = Math.max(last, o.t)
    }
    engine.end(options.endT ?? last)
    return { findings: engine.findings(), coverage: engine.coverage(), model: engine.model }
}
