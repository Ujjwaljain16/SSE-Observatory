import type { FindingDraft } from '../finding'
import type { Rule, RuleContext } from '../rule'
import { kindWord, parseShape, type ShapeKind } from '../../observe/payloadShape'
import { ev, plural } from './util'

/**
 * R16 schema.drift: the structure of an event's JSON payload changed and stayed changed. Each event is recorded with its shape (field
 * names and kinds, never values). For each event name the first events set a baseline; later, when most of the recent events share a
 * shape that is not the baseline's, the difference is reported: fields that are gone, fields that are new, fields whose kind changed.
 * A single odd event (an error payload, an optional field) is not a change; a sustained one is. New fields alone are an info note, because
 * adding a field rarely breaks a consumer; a field that is gone or changed kind may.
 */

interface Sample { shape: string; seq: number; t: number }

interface NameState {
    withShape: number
    /** Shapes of the baseline events, with the first record that had each. */
    baseline: Map<string, Sample>
    paths: Map<string, Map<ShapeKind, number>>
    core?: Map<string, ShapeKind>
    allKinds?: Map<string, Set<ShapeKind>>
    first?: Sample
    recent: Sample[]
    /** The shape the open finding is about, and how many events have had it since. */
    reported?: { shape: string; firstSeenT: number; firstSeq: number; occurrences: number } | undefined
}

const list = (items: string[], max = 5): string => `${items.slice(0, max).join(', ')}${items.length > max ? `, and ${items.length - max} more` : ''}`

export const schemaDrift: Rule = {
    id: 'schema.drift',
    version: 1,
    title: 'Payload shape drift',
    requires: ['payload'],
    create({ thresholds: th }: RuleContext) {
        const names = new Map<string, NameState>()
        const parsed = new Map<string, Map<string, ShapeKind>>()
        let withShape = 0
        let baselines = 0

        const fieldsOf = (shape: string): Map<string, ShapeKind> => {
            let f = parsed.get(shape)
            if (!f) {
                f = parseShape(shape)
                if (parsed.size > 2000) parsed.clear() // bounded: a stream with endlessly different shapes must not grow this
                parsed.set(shape, f)
            }
            return f
        }

        const completeBaseline = (s: NameState): void => {
            s.core = new Map()
            s.allKinds = new Map()
            for (const [path, kinds] of s.paths) {
                s.allKinds.set(path, new Set(kinds.keys()))
                const count = [...kinds.values()].reduce((x, y) => x + y, 0)
                // a field belongs to the baseline when nearly every baseline event had it
                if (count >= th.driftCoreShare * s.withShape) {
                    s.core.set(path, [...kinds.entries()].sort((a, b) => b[1] - a[1])[0]![0])
                }
            }
            baselines++
        }

        return {
            onObservation(o) {
                if (o.kind !== 'event') return
                const shape = o.extracted?.shape
                if (shape === undefined) return
                withShape++
                const name = o.event === '' ? 'message' : o.event
                let s = names.get(name)
                if (!s) { s = { withShape: 0, baseline: new Map(), paths: new Map(), recent: [] }; names.set(name, s) }
                s.withShape++
                const sample: Sample = { shape, seq: o.seq, t: o.t }

                if (s.core === undefined) {
                    if (!s.first) s.first = sample
                    if (!s.baseline.has(shape)) s.baseline.set(shape, sample)
                    for (const [path, kind] of fieldsOf(shape)) {
                        const kinds = s.paths.get(path) ?? new Map<ShapeKind, number>()
                        kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
                        s.paths.set(path, kinds)
                    }
                    if (s.withShape >= th.driftBaselineEvents) completeBaseline(s)
                    return
                }

                s.recent.push(sample)
                if (s.recent.length > th.driftWindowEvents) s.recent.shift()
                if (s.reported && shape === s.reported.shape) s.reported.occurrences++
                if (s.recent.length < th.driftWindowEvents) return

                // the shape most of the window shares
                const counts = new Map<string, number>()
                for (const r of s.recent) counts.set(r.shape, (counts.get(r.shape) ?? 0) + 1)
                const [dominant, share] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!
                if (share < th.driftWindowShare * s.recent.length) return

                const fields = fieldsOf(dominant)
                const removed = [...s.core.keys()].filter((p) => !fields.has(p))
                const changed = [...s.core.entries()].filter(([p, k]) => fields.has(p) && fields.get(p) !== k && !s.allKinds!.get(p)!.has(fields.get(p)!)).map(([p]) => p)
                const added = [...fields.keys()].filter((p) => !s.allKinds!.has(p))
                const different = removed.length + changed.length + added.length > 0

                if (!different) {
                    if (!s.reported) return
                    const back = s.reported
                    s.reported = undefined
                    const first = s.recent.find((r) => r.shape === dominant) ?? sample
                    return [{
                        key: `schema.drift:${name}`, severity: 'warning', title: `Payload format changed: ${name}`,
                        summary: `The "${name}" events are back to the shape they had at the start.`,
                        facts: [{ text: `${share} of the last ${s.recent.length} "${name}" events have a shape that matches the first ${th.driftBaselineEvents}.`, evidence: [ev(first.seq, first.t, 'event with the baseline shape')] }],
                        deductions: [], limits: [],
                        status: 'resolved', firstSeenT: back.firstSeenT, lastSeenT: o.t, occurrences: back.occurrences,
                    } satisfies FindingDraft]
                }
                if (s.reported?.shape === dominant) return

                const firstNew = s.recent.find((r) => r.shape === dominant) ?? sample
                s.reported = { shape: dominant, firstSeenT: firstNew.t, firstSeq: firstNew.seq, occurrences: share }
                const parts: string[] = []
                if (removed.length) parts.push(`${plural(removed.length, 'field')} gone (${list(removed)})`)
                if (added.length) parts.push(`${plural(added.length, 'field')} new (${list(added)})`)
                if (changed.length) parts.push(`${plural(changed.length, 'field')} with a different kind (${list(changed.map((p) => `${p}: ${kindWord(s!.core!.get(p)!)} → ${kindWord(fields.get(p)!)}`))})`)
                const breaking = removed.length + changed.length > 0
                const baselineFields = [...s.core.keys()]
                const first = s.first!
                return [{
                    key: `schema.drift:${name}`, severity: breaking ? 'warning' : 'info', title: `Payload format changed: ${name}`,
                    summary: `The shape of the "${name}" events changed: ${parts.join('; ')}.`,
                    facts: [
                        { text: `The first ${th.driftBaselineEvents} "${name}" events had the fields ${list(baselineFields, 8) || '(none)'}.`, evidence: [ev(first.seq, first.t, 'first event of this name')] },
                        { text: `${share} of the last ${s.recent.length} "${name}" events share a different shape: ${parts.join('; ')}.`, evidence: [ev(firstNew.seq, firstNew.t, 'first event with the new shape'), ev(sample.seq, sample.t, 'latest event')] },
                    ],
                    deductions: [{
                        statement: 'Likely: the producer changed the payload format of this event (a release, a version switch or a different code path), which a consumer written for the old shape may not handle.',
                        confidence: breaking ? 'medium' : 'low', basis: [first.seq, firstNew.seq],
                        alternatives: ['A different kind of message now uses this event name.', 'The fields are optional and are missing from the recent events by chance.', 'An intermediary rewrote or filtered the payload.'],
                    }],
                    nextCheck: { description: 'Compare an event from before and after in the event list, and look at the producer\'s release history around that time.' },
                    limits: ['Only the structure of JSON payloads is compared (field names and kinds), not their values. Arrays are described by their first element, and only the first three levels and 40 fields are looked at.', 'Payloads that are not JSON, or longer than 4 KB, are not covered.'],
                    status: 'open', firstSeenT: firstNew.t, lastSeenT: o.t, occurrences: share,
                } satisfies FindingDraft]
            },
            coverage() {
                if (withShape === 0) return { evaluated: false, notes: ['No event carried a payload shape: the payloads are not JSON, or the recording was made before shapes were kept.'] }
                if (baselines === 0) return { evaluated: false, notes: [`No event name has reached ${th.driftBaselineEvents} events yet, and a change needs that baseline to be compared with.`] }
                return { evaluated: true, notes: [] }
            },
        }
    },
}
