import type { EventMessage } from '../types'
import { getFieldValue } from './eventUtils'

/**
 * Query language
 *
 *   expr       := or
 *   or         := and ( "OR" and )*
 *   and        := not ( "AND" not )*
 *   not        := "NOT" not | primary
 *   primary    := "(" expr ")" | comparison
 *   comparison := field ( op value | "in" "[" value ("," value)* "]" | "exists" )
 *   op         := == | = | != | > | >= | < | <= | contains | matches
 *   value      := "string" | 'string' | number | true | false | null | bareword
 *
 * Keywords are case-insensitive and only recognised as whole words, so a field called
 * ORDER_ID or ANDROID is just a field. Fields may contain letters, digits and _ $ . - : and
 * [n] array indexes (items[0].id is the same as items.0.id); anything else must be quoted.
 */

export type Operator = '==' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'matches' | 'in' | 'exists'
export type LogicalOperator = 'AND' | 'OR'

export type QueryValue = string | number | boolean | null

export interface QueryNode {
    type: 'comparison' | 'logical' | 'not'
    operator?: Operator | LogicalOperator
    left?: string | QueryNode
    right?: QueryValue | QueryValue[] | QueryNode
}

export class QueryParseError extends Error {
    constructor(message: string, public readonly position: number) {
        super(message)
        this.name = 'QueryParseError'
    }
}

// ---------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------

type TokenKind = 'ident' | 'string' | 'number' | 'op' | 'lparen' | 'rparen' | 'lbracket' | 'rbracket' | 'comma' | 'eof'

interface Token {
    kind: TokenKind
    text: string
    value?: string | number
    pos: number
}

const KEYWORDS = new Set(['and', 'or', 'not', 'contains', 'matches', 'in', 'exists', 'true', 'false', 'null'])
const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[A-Za-z0-9_$.\-:]/
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/

function tokenize(input: string): Token[] {
    const tokens: Token[] = []
    let i = 0
    while (i < input.length) {
        const c = input[i]
        if (/\s/.test(c)) { i++; continue }

        const start = i
        if (c === '(') { tokens.push({ kind: 'lparen', text: c, pos: i++ }); continue }
        if (c === ')') { tokens.push({ kind: 'rparen', text: c, pos: i++ }); continue }
        if (c === '[') { tokens.push({ kind: 'lbracket', text: c, pos: i++ }); continue }
        if (c === ']') { tokens.push({ kind: 'rbracket', text: c, pos: i++ }); continue }
        if (c === ',') { tokens.push({ kind: 'comma', text: c, pos: i++ }); continue }

        // Operators
        const two = input.slice(i, i + 2)
        if (two === '==' || two === '!=' || two === '>=' || two === '<=') {
            tokens.push({ kind: 'op', text: two, pos: i }); i += 2; continue
        }
        if (c === '>' || c === '<' || c === '=') {
            tokens.push({ kind: 'op', text: c === '=' ? '==' : c, pos: i++ }); continue
        }

        // Quoted strings with \ escapes
        if (c === '"' || c === "'") {
            let out = ''
            i++
            let closed = false
            while (i < input.length) {
                const ch = input[i]
                if (ch === '\\' && i + 1 < input.length) {
                    const next = input[i + 1]
                    // Known escapes are decoded; unknown ones keep their backslash so regexes like \d survive.
                    if (next === 'n') out += '\n'
                    else if (next === 't') out += '\t'
                    else if (next === 'r') out += '\r'
                    else if (next === '\\' || next === '"' || next === "'") out += next
                    else out += '\\' + next
                    i += 2
                    continue
                }
                if (ch === c) { closed = true; i++; break }
                out += ch
                i++
            }
            if (!closed) throw new QueryParseError('Unterminated string', start)
            tokens.push({ kind: 'string', text: input.slice(start, i), value: out, pos: start })
            continue
        }

        // Numbers (including negative numbers)
        const numMatch = NUMBER.exec(input.slice(i))
        if (numMatch && (c !== '-' || /[\d.]/.test(input[i + 1] ?? ''))) {
            const after = input[i + numMatch[0].length]
            // "5abc" or "2024-01-01" are barewords, not numbers
            if (after === undefined || !IDENT_PART.test(after) || after === '.') {
                tokens.push({ kind: 'number', text: numMatch[0], value: Number(numMatch[0]), pos: start })
                i += numMatch[0].length
                continue
            }
        }

        // Identifiers / keywords / barewords
        if (IDENT_START.test(c) || /[0-9]/.test(c) || c === '-') {
            i++
            while (i < input.length) {
                const ch = input[i]
                if (ch === '[') { // items[0] → items.0
                    const close = input.indexOf(']', i)
                    if (close === -1 || !/^\d+$/.test(input.slice(i + 1, close))) break
                    i = close + 1
                    continue
                }
                if (!IDENT_PART.test(ch)) break
                i++
            }
            tokens.push({ kind: 'ident', text: input.slice(start, i).replace(/\[(\d+)\]/g, '.$1'), pos: start })
            continue
        }

        throw new QueryParseError(`Unexpected character "${c}"`, i)
    }
    tokens.push({ kind: 'eof', text: '', pos: input.length })
    return tokens
}

// ---------------------------------------------------------------------------------------
// Parser (recursive descent with precedence: NOT > AND > OR)
// ---------------------------------------------------------------------------------------

const isKeyword = (t: Token, word: string) => t.kind === 'ident' && t.text.toLowerCase() === word

export function parseQuery(query: string): QueryNode {
    const tokens = tokenize(query)
    let p = 0
    const peek = () => tokens[p]
    const next = () => tokens[p++]
    const describe = (t: Token) => (t.kind === 'eof' ? 'end of query' : `"${t.text}"`)
    const fail = (t: Token, expected: string): never => {
        throw new QueryParseError(`Unexpected ${describe(t)} at position ${t.pos}, expected ${expected}`, t.pos)
    }

    if (tokens.length === 1) throw new QueryParseError('Empty query', 0)

    const parseValue = (): QueryValue => {
        const t = next()
        if (t.kind === 'string' || t.kind === 'number') return t.value as string | number
        if (t.kind === 'ident') {
            const lower = t.text.toLowerCase()
            if (lower === 'true') return true
            if (lower === 'false') return false
            if (lower === 'null') return null
            if (KEYWORDS.has(lower)) return fail(t, 'a value')
            return t.text // bareword, e.g. status == active
        }
        return fail(t, 'a value')
    }

    const parseComparison = (): QueryNode => {
        const f = next()
        if (f.kind !== 'ident' && f.kind !== 'string') return fail(f, 'a field name or "("')
        if (f.kind === 'ident' && KEYWORDS.has(f.text.toLowerCase()) && !['true', 'false', 'null'].includes(f.text.toLowerCase())) {
            return fail(f, 'a field name')
        }
        const field = String(f.kind === 'string' ? f.value : f.text)

        const t = next()
        if (t.kind === 'op') {
            return { type: 'comparison', operator: t.text as Operator, left: field, right: parseValue() }
        }
        if (isKeyword(t, 'contains') || isKeyword(t, 'matches')) {
            return { type: 'comparison', operator: t.text.toLowerCase() as Operator, left: field, right: parseValue() }
        }
        if (isKeyword(t, 'exists')) return { type: 'comparison', operator: 'exists', left: field }
        if (isKeyword(t, 'in')) {
            const open = next()
            if (open.kind !== 'lbracket') return fail(open, '"["')
            const values: QueryValue[] = []
            if (peek().kind !== 'rbracket') {
                values.push(parseValue())
                while (peek().kind === 'comma') { next(); values.push(parseValue()) }
            }
            const close = next()
            if (close.kind !== 'rbracket') return fail(close, '"]" or ","')
            return { type: 'comparison', operator: 'in', left: field, right: values }
        }
        return fail(t, 'an operator (==, !=, >, >=, <, <=, contains, matches, in, exists)')
    }

    const parseNot = (): QueryNode => {
        if (isKeyword(peek(), 'not')) { next(); return { type: 'not', left: parseNot() } }
        return parsePrimary()
    }
    const parsePrimary = (): QueryNode => {
        if (peek().kind === 'lparen') {
            next()
            const inner = parseOr()
            const close = next()
            if (close.kind !== 'rparen') return fail(close, '")"')
            return inner
        }
        return parseComparison()
    }
    const parseAnd = (): QueryNode => {
        let left = parseNot()
        while (isKeyword(peek(), 'and')) { next(); left = { type: 'logical', operator: 'AND', left, right: parseNot() } }
        return left
    }
    const parseOr = (): QueryNode => {
        let left = parseAnd()
        while (isKeyword(peek(), 'or')) { next(); left = { type: 'logical', operator: 'OR', left, right: parseAnd() } }
        return left
    }

    const node = parseOr()
    if (peek().kind !== 'eof') fail(peek(), 'AND, OR or end of query')
    return node
}

// ---------------------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------------------

export type EventPredicate = (event: EventMessage) => boolean

const looseEquals = (fieldValue: string | null, target: QueryValue): boolean => {
    if (target === null) return fieldValue === null
    if (fieldValue === null) return false
    if (typeof target === 'number') return fieldValue.trim() !== '' && Number(fieldValue) === target
    if (typeof target === 'boolean') return fieldValue === String(target)
    return fieldValue === target
}

const compare = (fieldValue: string | null, target: QueryValue, test: (a: number, b: number) => boolean): boolean => {
    if (fieldValue === null || fieldValue.trim() === '') return false
    const a = Number(fieldValue)
    const b = typeof target === 'number' ? target : Number(target)
    return !Number.isNaN(a) && !Number.isNaN(b) && test(a, b)
}

export function compileQuery(node: QueryNode): EventPredicate {
    if (node.type === 'logical') {
        const left = compileQuery(node.left as QueryNode)
        const right = compileQuery(node.right as QueryNode)
        return node.operator === 'OR' ? (e) => left(e) || right(e) : (e) => left(e) && right(e)
    }
    if (node.type === 'not') {
        const inner = compileQuery(node.left as QueryNode)
        return (e) => !inner(e)
    }

    const path = node.left as string
    const target = node.right as QueryValue
    switch (node.operator) {
        case '==': return (e) => looseEquals(getFieldValue(e, path), target)
        case '!=': return (e) => !looseEquals(getFieldValue(e, path), target)
        case '>': return (e) => compare(getFieldValue(e, path), target, (a, b) => a > b)
        case '<': return (e) => compare(getFieldValue(e, path), target, (a, b) => a < b)
        case '>=': return (e) => compare(getFieldValue(e, path), target, (a, b) => a >= b)
        case '<=': return (e) => compare(getFieldValue(e, path), target, (a, b) => a <= b)
        case 'contains': {
            const needle = String(target).toLowerCase()
            return (e) => {
                const v = getFieldValue(e, path)
                return v !== null && v.toLowerCase().includes(needle)
            }
        }
        case 'matches': {
            let rx: RegExp
            try { rx = new RegExp(String(target), 'i') } catch (err) {
                throw new QueryParseError(`Invalid regular expression: ${(err as Error).message}`, 0)
            }
            return (e) => {
                const v = getFieldValue(e, path)
                return v !== null && rx.test(v)
            }
        }
        case 'in': {
            const list = (target ?? []) as unknown as QueryValue[]
            return (e) => {
                const v = getFieldValue(e, path)
                return list.some((t) => looseEquals(v, t))
            }
        }
        case 'exists': return (e) => getFieldValue(e, path) !== null
        default: throw new QueryParseError(`Unknown operator ${String(node.operator)}`, 0)
    }
}

/** Parse + compile in one step. Throws QueryParseError with a human-readable message. */
export const compileQueryString = (query: string): EventPredicate => compileQuery(parseQuery(query))

/** Backwards-compatible class API used by hooks and the filter worker. */
export class QueryParser {
    constructor(private readonly query: string) {}
    parse(): QueryNode { return parseQuery(this.query) }
    compile(node: QueryNode): EventPredicate { return compileQuery(node) }
}
