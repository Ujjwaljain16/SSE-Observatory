/**
 * A redaction policy a person writes down once and reuses: the CLI reads it from a file (`--redact-policy`), the app keeps it
 * in the browser and edits it in the export dialog. Both read the same text through `parseRedactionPolicy`, so a policy that
 * works in one works in the other.
 *
 *   { "version": 1,
 *     "extraKeys": ["ssn", "internalNote"],
 *     "extraPatterns": [{ "name": "ticket", "pattern": "ACME-\\d{6}", "flags": "i" }],
 *     "keepHeaders": ["x-request-id"],
 *     "redactPartitions": true }
 *
 * The policy can only add: it makes redaction stricter (more keys, more patterns) or keeps a harmless header. It cannot switch
 * the built-in rules off, and it cannot keep a header that carries credentials. Every problem is reported at once, in words.
 */

import type { RedactionPolicy } from './redact'
import { isSensitiveName } from './secrets'

export const POLICY_VERSION = 1

export const POLICY_LIMITS = {
    keys: 100,
    keyLength: 64,
    patterns: 20,
    patternLength: 200,
    nameLength: 40,
    headers: 50,
    headerLength: 64,
} as const

const FIELDS = ['version', 'extraKeys', 'extraPatterns', 'keepHeaders', 'redactPartitions']
const PATTERN_FIELDS = ['name', 'pattern', 'flags']
/** The flags a person may choose. `g` and `d` are always set by the redactor; `y` and `v` change how matching advances or parses. */
const ALLOWED_FLAGS = new Set(['i', 'm', 's', 'u'])
/** A quantified group that itself contains a quantifier, `(a+)+` or `(.*)*`: the shape that makes a regular expression take exponential time. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/
/** Headers that never carry anything worth keeping in the clear: a value is a credential. */
const ALWAYS_SECRET_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization'])

export interface PolicyParse {
    /** Undefined when there were errors, or when the text holds no rules at all. */
    policy?: RedactionPolicy | undefined
    errors: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function stringList(value: unknown, field: string, max: number, maxLength: number, errors: string[]): string[] | undefined {
    if (!Array.isArray(value)) { errors.push(`"${field}" must be a list of strings.`); return undefined }
    if (value.length > max) errors.push(`"${field}" has ${value.length} entries; the most allowed is ${max}.`)
    const out: string[] = []
    value.slice(0, max).forEach((item, i) => {
        if (typeof item !== 'string' || item.trim() === '') { errors.push(`"${field}[${i}]" must be a non-empty string.`); return }
        const text = item.trim()
        if (text.length > maxLength) { errors.push(`"${field}[${i}]" is ${text.length} characters; the most allowed is ${maxLength}.`); return }
        out.push(text)
    })
    return out
}

function patternList(value: unknown, errors: string[]): NonNullable<RedactionPolicy['extraPatterns']> | undefined {
    if (!Array.isArray(value)) { errors.push('"extraPatterns" must be a list of { "name", "pattern", "flags" } objects.'); return undefined }
    if (value.length > POLICY_LIMITS.patterns) errors.push(`"extraPatterns" has ${value.length} entries; the most allowed is ${POLICY_LIMITS.patterns}.`)
    const out: NonNullable<RedactionPolicy['extraPatterns']> = []
    value.slice(0, POLICY_LIMITS.patterns).forEach((item, i) => {
        const at = `extraPatterns[${i}]`
        if (!isObject(item)) { errors.push(`"${at}" must be an object with a name and a pattern.`); return }
        for (const key of Object.keys(item)) if (!PATTERN_FIELDS.includes(key)) errors.push(`Unknown field "${at}.${key}".`)
        const { name, pattern, flags } = item
        let ok = true
        if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name) || name.length > POLICY_LIMITS.nameLength) {
            errors.push(`"${at}.name" must be 1 to ${POLICY_LIMITS.nameLength} letters, digits, dots, dashes or underscores: it names the rule in the redaction summary.`)
            ok = false
        }
        if (typeof pattern !== 'string' || pattern === '') { errors.push(`"${at}.pattern" must be a non-empty regular expression.`); return }
        if (pattern.length > POLICY_LIMITS.patternLength) { errors.push(`"${at}.pattern" is ${pattern.length} characters; the most allowed is ${POLICY_LIMITS.patternLength}.`); return }
        if (flags !== undefined && (typeof flags !== 'string' || [...flags].some((f) => !ALLOWED_FLAGS.has(f)) || new Set(flags).size !== flags.length)) {
            errors.push(`"${at}.flags" may only use i, m, s and u, each once (the redactor always matches every occurrence).`)
            return
        }
        const given = typeof flags === 'string' ? flags : ''
        try { new RegExp(pattern, `${given}gd`) } catch (error) {
            errors.push(`"${at}.pattern" is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
            return
        }
        if (new RegExp(pattern, given).test('')) { errors.push(`"${at}.pattern" matches the empty string, so it would match everywhere. Make it match something.`); return }
        if (NESTED_QUANTIFIER.test(pattern)) {
            errors.push(`"${at}.pattern" repeats a group that itself repeats (like (a+)+), which can take exponentially long on a long stream. Rewrite it without the nested repeat.`)
            return
        }
        if (ok) out.push({ name: name as string, pattern, ...(given ? { flags: given } : {}) })
    })
    return out
}

/** Reads a policy from JSON text or an already-parsed value. Every problem is listed; a policy with any problem is not used at all. */
export function parseRedactionPolicy(input: unknown): PolicyParse {
    let value = input
    if (typeof input === 'string') {
        if (input.trim() === '') return { errors: [] }
        try { value = JSON.parse(input) } catch (error) { return { errors: [`The policy is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] } }
    }
    if (!isObject(value)) return { errors: ['The policy must be a JSON object, like { "extraKeys": ["ssn"] }.'] }
    const errors: string[] = []
    for (const key of Object.keys(value)) if (!FIELDS.includes(key)) errors.push(`Unknown field "${key}". The fields are ${FIELDS.join(', ')}.`)
    if (value['version'] !== undefined && value['version'] !== POLICY_VERSION) errors.push(`"version" must be ${POLICY_VERSION} (this is the only version that exists).`)

    const policy: RedactionPolicy = {}
    if (value['extraKeys'] !== undefined) {
        const keys = stringList(value['extraKeys'], 'extraKeys', POLICY_LIMITS.keys, POLICY_LIMITS.keyLength, errors)
        if (keys && keys.length > 0) policy.extraKeys = keys
    }
    if (value['extraPatterns'] !== undefined) {
        const patterns = patternList(value['extraPatterns'], errors)
        if (patterns && patterns.length > 0) policy.extraPatterns = patterns
    }
    if (value['keepHeaders'] !== undefined) {
        const headers = stringList(value['keepHeaders'], 'keepHeaders', POLICY_LIMITS.headers, POLICY_LIMITS.headerLength, errors)
        const kept: string[] = []
        for (const h of headers ?? []) {
            if (!/^[A-Za-z0-9-]+$/.test(h)) errors.push(`"keepHeaders" entry "${h}" is not a header name (letters, digits and dashes only).`)
            else if (ALWAYS_SECRET_HEADERS.has(h.toLowerCase()) || isSensitiveName(h)) errors.push(`"keepHeaders" entry "${h}" carries credentials, so its value cannot be kept in a shared capture.`)
            else kept.push(h.toLowerCase())
        }
        if (kept.length > 0) policy.keepHeaders = [...new Set(kept)]
    }
    if (value['redactPartitions'] !== undefined) {
        if (typeof value['redactPartitions'] !== 'boolean') errors.push('"redactPartitions" must be true or false.')
        else policy.redactPartitions = value['redactPartitions']
    }
    if (errors.length > 0) return { errors }
    return Object.keys(policy).length > 0 ? { policy, errors } : { errors }
}

/** The policy as the text the CLI reads and the app edits. */
export function policyToJson(policy: RedactionPolicy | undefined): string {
    if (!policy) return ''
    return JSON.stringify({ version: POLICY_VERSION, ...policy }, null, 2)
}

/** True when the policy changes anything: a capture redacted with one says "custom" in its header. */
export function isCustomPolicy(policy: RedactionPolicy | undefined): boolean {
    return policy !== undefined && ((policy.extraKeys?.length ?? 0) > 0 || (policy.extraPatterns?.length ?? 0) > 0 || (policy.keepHeaders?.length ?? 0) > 0 || policy.redactPartitions === false)
}

/** One short sentence for a summary line: "2 extra key names, 1 extra pattern, 1 kept header". */
export function describePolicy(policy: RedactionPolicy | undefined): string {
    if (!isCustomPolicy(policy)) return 'the built-in rules only'
    const p = policy!
    const parts: string[] = []
    if (p.extraKeys?.length) parts.push(plural(p.extraKeys.length, 'extra key name'))
    if (p.extraPatterns?.length) parts.push(plural(p.extraPatterns.length, 'extra pattern'))
    if (p.keepHeaders?.length) parts.push(plural(p.keepHeaders.length, 'kept header'))
    if (p.redactPartitions === false) parts.push('partition keys kept')
    return parts.join(', ')
}
