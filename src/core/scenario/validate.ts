/**
 * A small JSON Schema validator for exactly the keywords the shipped schemas use (see `Schema`). It exists so the CLI
 * and the browser can check a scenario without a validator dependency; a conformance test compares its verdicts with
 * Ajv's. Messages are plain words, with a JSON pointer to the value they are about.
 */

import { SCENARIO_SCHEMA, type Schema } from './schema'
import { findSecrets } from './secrets'
import type { Scenario } from './types'

export type { Scenario } from './types'

export interface ValidationError {
    /** JSON pointer to the value, `''` for the document itself. */
    pointer: string
    message: string
    /** `syntax` for text that is not JSON, `secret` for a literal secret (the CLI exits 2 on these). Plain schema errors have no code. */
    code?: 'syntax' | 'secret' | undefined
    /** 1-based position of a syntax error. */
    line?: number | undefined
    column?: number | undefined
}

const escapePointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1')

const kindOf = (v: unknown): 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'other' => {
    if (v === null) return 'null'
    if (Array.isArray(v)) return 'array'
    switch (typeof v) {
        case 'object': return 'object'
        case 'string': return 'string'
        case 'number': return 'number'
        case 'boolean': return 'boolean'
        default: return 'other'
    }
}

const describe = (v: unknown): string => {
    const k = kindOf(v)
    return k === 'number' ? (Number.isInteger(v) ? 'an integer' : 'a number') : k === 'null' ? 'null' : `${k === 'object' || k === 'array' ? 'an' : 'a'} ${k}`
}

const deepEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true
    const ka = kindOf(a)
    if (ka !== kindOf(b)) return false
    if (ka === 'array') {
        const x = a as unknown[]
        const y = b as unknown[]
        return x.length === y.length && x.every((v, i) => deepEqual(v, y[i]))
    }
    if (ka === 'object') {
        const x = a as Record<string, unknown>
        const y = b as Record<string, unknown>
        const keys = Object.keys(x)
        return keys.length === Object.keys(y).length && keys.every((k) => k in y && deepEqual(x[k], y[k]))
    }
    return false
}

const patterns = new Map<string, RegExp>()
const regexOf = (source: string): RegExp => {
    let re = patterns.get(source)
    if (!re) { re = new RegExp(source, 'u'); patterns.set(source, re) }
    return re
}

const matchesType = (type: NonNullable<Schema['type']>, v: unknown): boolean => {
    const k = kindOf(v)
    return type === 'integer' ? k === 'number' && Number.isInteger(v) : type === k
}

const article = (type: string): string => (type === 'object' || type === 'array' || type === 'integer' ? `an ${type}` : `a ${type}`)

function check(schema: Schema, value: unknown, pointer: string, errors: ValidationError[]): void {
    const fail = (message: string, at = pointer): void => { errors.push({ pointer: at, message }) }

    if (schema.type !== undefined && !matchesType(schema.type, value)) {
        fail(`must be ${article(schema.type)} (found ${describe(value)})`)
        return
    }
    if (schema.const !== undefined && !deepEqual(schema.const, value)) fail(`must be ${JSON.stringify(schema.const)}`)
    if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) fail(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`)

    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) fail(`must be at least ${schema.minimum}`)
        if (schema.maximum !== undefined && value > schema.maximum) fail(`must be at most ${schema.maximum}`)
    }

    if (typeof value === 'string') {
        if (schema.minLength !== undefined && [...value].length < schema.minLength) fail(schema.minLength === 1 ? 'must not be empty' : `must be at least ${schema.minLength} characters`)
        if (schema.pattern !== undefined && !regexOf(schema.pattern).test(value)) fail('has the wrong format')
    }

    if (Array.isArray(value) && schema.items) {
        value.forEach((item, i) => check(schema.items!, item, `${pointer}/${i}`, errors))
    }

    if (kindOf(value) === 'object') {
        const obj = value as Record<string, unknown>
        const keys = Object.keys(obj)
        for (const name of schema.required ?? []) if (!(name in obj)) fail(`missing required property "${name}"`)
        if (schema.minProperties !== undefined && keys.length < schema.minProperties) fail(`must have at least ${schema.minProperties} propert${schema.minProperties === 1 ? 'y' : 'ies'}`)
        if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) fail(`must have at most ${schema.maxProperties} propert${schema.maxProperties === 1 ? 'y' : 'ies'}`)
        for (const key of keys) {
            const at = `${pointer}/${escapePointer(key)}`
            const known = schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, key) ? schema.properties[key] : undefined
            if (known) check(known, obj[key], at, errors)
            else if (schema.additionalProperties === false) fail(`unknown property "${key}"`, at)
            else if (typeof schema.additionalProperties === 'object') check(schema.additionalProperties, obj[key], at, errors)
        }
    }

    if (schema.oneOf) {
        const results = schema.oneOf.map((branch) => { const e: ValidationError[] = []; check(branch, value, pointer, e); return e })
        const matched = results.filter((e) => e.length === 0).length
        if (matched > 1) fail('matches more than one of the allowed forms')
        else if (matched === 0) {
            // Report the branch that came closest. When several are equally close the value is probably of neither
            // kind, so say what each would have needed.
            const best = Math.min(...results.map((e) => e.length))
            const closest = results.filter((e) => e.length === best)
            if (closest.length === 1) errors.push(...closest[0]!)
            else fail(`does not match any allowed form (${closest.map((e) => e[0]!.message).join(' / ')})`)
        }
    }
}

/** Checks `value` against `schema`. An empty result means valid. */
export function validateJson(schema: Schema, value: unknown): ValidationError[] {
    const errors: ValidationError[] = []
    check(schema, value, '', errors)
    return errors
}

/** Line and column (1-based) of a character offset. */
function positionOf(text: string, offset: number): { line: number; column: number } {
    let line = 1
    let lineStart = 0
    const end = Math.min(offset, text.length)
    for (let i = 0; i < end; i++) {
        if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1 }
    }
    return { line, column: end - lineStart + 1 }
}

class SyntaxAt extends Error {
    constructor(readonly offset: number, message: string) { super(message) }
}

/**
 * Finds where text stops being JSON. The engines disagree on how (or whether) they report a position, so the first
 * error is located here, the same way everywhere. Only called after JSON.parse has already failed.
 */
function locateSyntaxError(text: string): SyntaxAt {
    let i = 0
    const fail = (message: string, at = i): never => { throw new SyntaxAt(at, message) }
    const here = (): string => (i >= text.length ? 'the text ends too early' : `unexpected ${JSON.stringify(text[i])}`)
    const skip = (): void => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++ }

    const string = (): void => {
        i++ // opening quote
        for (;;) {
            if (i >= text.length) fail('the string is never closed')
            const c = text[i]!
            if (c === '"') { i++; return }
            if (c < ' ') fail('a line break or control character inside a string must be escaped')
            if (c === '\\') {
                const e = text[i + 1]
                if (e === 'u') {
                    if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('a \\u escape needs four hex digits', i)
                    i += 6
                } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2
                else fail('unknown escape in a string', i)
            } else i++
        }
    }
    const value = (): void => {
        skip()
        const c = text[i]
        if (c === '{') {
            i++; skip()
            if (text[i] === '}') { i++; return }
            for (;;) {
                skip()
                if (text[i] !== '"') fail('expected a property name in double quotes')
                string(); skip()
                if (text[i] !== ':') fail("expected ':' after the property name")
                i++; value(); skip()
                if (text[i] === ',') { i++; continue }
                if (text[i] === '}') { i++; return }
                fail("expected ',' or '}'")
            }
        } else if (c === '[') {
            i++; skip()
            if (text[i] === ']') { i++; return }
            for (;;) {
                value(); skip()
                if (text[i] === ',') { i++; continue }
                if (text[i] === ']') { i++; return }
                fail("expected ',' or ']'")
            }
        } else if (c === '"') string()
        else if (c !== undefined && (c === '-' || (c >= '0' && c <= '9'))) {
            const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i))
            if (!m) fail('not a valid number')
            i += m![0].length
        } else {
            const word = ['true', 'false', 'null'].find((w) => text.startsWith(w, i))
            if (!word) fail(here())
            i += word!.length
        }
    }

    try {
        value(); skip()
        if (i < text.length) fail('unexpected text after the end of the JSON value')
    } catch (e) {
        if (e instanceof SyntaxAt) return e
    }
    return new SyntaxAt(text.length, 'the text could not be read as JSON')
}

function syntaxError(text: string): ValidationError {
    const found = locateSyntaxError(text)
    const { line, column } = positionOf(text, found.offset)
    return { pointer: '', code: 'syntax', line, column, message: `not valid JSON at line ${line}, column ${column}: ${found.message}` }
}

/** Schema check plus the secret rule. */
export function validateScenario(doc: unknown): ValidationError[] {
    return [...validateJson(SCENARIO_SCHEMA, doc), ...findSecrets(doc)]
}

/** Parses scenario text (JSON). `value` is set only when there are no errors. */
export function parseScenarioText(text: string): { value?: Scenario; errors: ValidationError[] } {
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    if (body.trim() === '') return { errors: [{ pointer: '', code: 'syntax', line: 1, column: 1, message: 'the scenario file is empty' }] }
    let doc: unknown
    try { doc = JSON.parse(body) } catch { return { errors: [syntaxError(body)] } }
    const errors = validateScenario(doc)
    return errors.length > 0 ? { errors } : { value: doc as Scenario, errors }
}
