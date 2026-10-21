/**
 * A stream profile is what the author of a stream says to expect of it: how its events are numbered, what it promises on
 * delivery, how often it should be heard from. The same JSON is read by the command line (`--profile`) and edited in the
 * app. This module checks one, describes one in a line, and says which part of it must already be known when events
 * are recorded (the fields to read out of each payload).
 */

import type { PayloadProbeConfig } from '../observe/payloadProbe'
import type { DeliverySemantics, SequenceContract, StreamProfile } from './thresholds'

const POLICIES: SequenceContract['policy'][] = ['consecutive', 'monotonic']
const DELIVERIES: DeliverySemantics[] = ['at_least_once', 'exactly_once', 'at_most_once']
const TOP_KEYS = ['sequence', 'delivery', 'timestampField', 'expected', '$schema']

/** The fields the recorder reads out of each payload as it is recorded. The rest of a profile is read when events are analysed. */
export function probeConfigOf(profile: StreamProfile | undefined): PayloadProbeConfig {
    const config: PayloadProbeConfig = {}
    if (profile?.sequence) {
        config.sequence = { ...(profile.sequence.field ? { field: profile.sequence.field } : {}), ...(profile.sequence.useSseId ? { useSseId: true } : {}) }
        if (profile.sequence.partitionBy) config.partitionBy = profile.sequence.partitionBy
    }
    if (profile?.timestampField) config.timestampField = profile.timestampField
    return config
}

/** True when two profiles ask the recorder to read the same things from payloads. */
export const sameProbe = (a: StreamProfile | undefined, b: StreamProfile | undefined): boolean => JSON.stringify(probeConfigOf(a)) === JSON.stringify(probeConfigOf(b))

export type ProfileCheck = { ok: true; profile: StreamProfile } | { ok: false; errors: string[] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPath = (v: unknown): v is string => typeof v === 'string' && /^(\$\.?|)[A-Za-z0-9_-]+(\[\d+\]|\.[A-Za-z0-9_-]+)*$/.test(v.trim())

/** Checks a value read from JSON and returns it as a profile, or says what is wrong in plain words. Nothing is guessed. */
export function parseProfile(value: unknown): ProfileCheck {
    if (!isObject(value)) return { ok: false, errors: ['A profile is a JSON object.'] }
    const errors: string[] = []
    for (const key of Object.keys(value)) if (!TOP_KEYS.includes(key)) errors.push(`Unknown field "${key}". A profile has: sequence, delivery, timestampField, expected.`)
    const profile: StreamProfile = {}

    const seq = value['sequence']
    if (seq !== undefined) {
        if (!isObject(seq)) errors.push('"sequence" must be an object with a policy and a field or useSseId.')
        else {
            for (const key of Object.keys(seq)) if (!['field', 'useSseId', 'policy', 'partitionBy'].includes(key)) errors.push(`Unknown field "sequence.${key}".`)
            const policy = seq['policy']
            if (!POLICIES.includes(policy as SequenceContract['policy'])) errors.push(`"sequence.policy" must be "consecutive" (every step is +1, a gap is loss) or "monotonic" (gaps are fine, repeats and going backwards are not).`)
            const field = seq['field']
            const useSseId = seq['useSseId']
            if (field !== undefined && !isPath(field)) errors.push('"sequence.field" must be a JSON path such as $.seq or $.data.id.')
            if (useSseId !== undefined && typeof useSseId !== 'boolean') errors.push('"sequence.useSseId" must be true or false.')
            if (field === undefined && useSseId !== true) errors.push('"sequence" needs a "field" or "useSseId": true, or there is nothing to count.')
            if (field !== undefined && useSseId === true) errors.push('"sequence" takes a "field" or "useSseId", not both.')
            const part = seq['partitionBy']
            if (part !== undefined && part !== '$event' && !isPath(part)) errors.push('"sequence.partitionBy" must be a JSON path, or "$event" to count each event name separately.')
            if (errors.length === 0) {
                profile.sequence = {
                    policy: policy as SequenceContract['policy'],
                    ...(typeof field === 'string' ? { field: field.trim() } : {}),
                    ...(useSseId === true ? { useSseId: true } : {}),
                    ...(typeof part === 'string' ? { partitionBy: part.trim() } : {}),
                }
            }
        }
    }

    const delivery = value['delivery']
    if (delivery !== undefined) {
        if (!DELIVERIES.includes(delivery as DeliverySemantics)) errors.push('"delivery" must be "at_least_once", "exactly_once" or "at_most_once".')
        else profile.delivery = delivery as DeliverySemantics
    }

    const ts = value['timestampField']
    if (ts !== undefined) {
        if (!isPath(ts)) errors.push('"timestampField" must be a JSON path such as $.ts.')
        else profile.timestampField = ts.trim()
    }

    const expected = value['expected']
    if (expected !== undefined) {
        if (!isObject(expected)) errors.push('"expected" must be an object.')
        else {
            const out: NonNullable<StreamProfile['expected']> = {}
            for (const [key, v] of Object.entries(expected)) {
                if (key !== 'firstEventMs' && key !== 'maxSilenceMs' && key !== 'heartbeatMs') errors.push(`Unknown field "expected.${key}".`)
                else if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) errors.push(`"expected.${key}" must be a number of milliseconds above 0.`)
                else out[key] = v
            }
            if (Object.keys(out).length > 0) profile.expected = out
        }
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true, profile }
}

/** One line for a header or a log: what this profile declares. */
export function describeProfile(profile: StreamProfile | undefined): string {
    if (!profile) return 'no profile'
    const parts: string[] = []
    const s = profile.sequence
    if (s) parts.push(`sequence ${s.useSseId ? 'in the SSE id' : s.field ?? '?'} (${s.policy}${s.partitionBy ? `, per ${s.partitionBy}` : ''})`)
    if (profile.delivery) parts.push(profile.delivery.replace(/_/g, ' '))
    if (profile.timestampField) parts.push(`timestamp ${profile.timestampField}`)
    if (profile.expected) parts.push('expected timings')
    return parts.length > 0 ? parts.join(', ') : 'empty profile'
}
