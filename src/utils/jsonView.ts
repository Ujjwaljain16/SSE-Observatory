/**
 * Helpers for showing a payload: a tokenizer for syntax highlighting, and the one-line summary of a node of a collapsible tree.
 * Pure, so they are tested without a browser. The tokenizer never changes the text: joining the tokens gives back the input.
 */

export type JsonTokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'space' | 'text'

export interface JsonToken {
    kind: JsonTokenKind
    text: string
}

/** Past this many characters the payload is shown as plain text: thousands of spans per row cost more than the colours are worth. */
export const MAX_HIGHLIGHT_CHARS = 8000

// A string (and whether a colon follows, which makes it a key), a number, a literal, punctuation, white space, or any one other character.
const TOKEN = /("(?:\\.|[^"\\\n])*")(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b|[{}[\],:]|\s+|[^]/g

export function tokenizeJson(text: string): JsonToken[] {
    const tokens: JsonToken[] = []
    TOKEN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = TOKEN.exec(text)) !== null) {
        const [whole, str, colon] = m
        if (str !== undefined) {
            if (colon !== undefined) {
                tokens.push({ kind: 'key', text: str })
                tokens.push({ kind: 'punct', text: colon })
            } else tokens.push({ kind: 'string', text: str })
        } else if (/^\s+$/.test(whole)) tokens.push({ kind: 'space', text: whole })
        else if (/^[{}[\],:]$/.test(whole)) tokens.push({ kind: 'punct', text: whole })
        else if (/^-?\d/.test(whole)) tokens.push({ kind: 'number', text: whole })
        else if (whole === 'true' || whole === 'false' || whole === 'null') tokens.push({ kind: 'literal', text: whole })
        else tokens.push({ kind: 'text', text: whole })
    }
    return tokens
}

export type JsonShape = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

export function shapeOf(value: unknown): JsonShape {
    if (value === null || value === undefined) return 'null'
    if (Array.isArray(value)) return 'array'
    switch (typeof value) {
        case 'object': return 'object'
        case 'string': return 'string'
        case 'number': return 'number'
        case 'boolean': return 'boolean'
        default: return 'string'
    }
}

/** What a collapsed node says about itself: `{3 keys}`, `[12 items]`. A leaf has no summary. */
export function summarise(value: unknown): string | undefined {
    const shape = shapeOf(value)
    if (shape === 'array') {
        const n = (value as unknown[]).length
        return `[${n} item${n === 1 ? '' : 's'}]`
    }
    if (shape === 'object') {
        const n = Object.keys(value as object).length
        return `{${n} key${n === 1 ? '' : 's'}}`
    }
    return undefined
}

/** The children of a node as [label, value] pairs, in the order the payload has them. */
export function childrenOf(value: unknown): Array<[string, unknown]> {
    const shape = shapeOf(value)
    if (shape === 'array') return (value as unknown[]).map((v, i) => [String(i), v])
    if (shape === 'object') return Object.entries(value as Record<string, unknown>)
    return []
}

/** A leaf as it is written in JSON. */
export function leafText(value: unknown): string {
    if (value === undefined) return 'null'
    try { return JSON.stringify(value) ?? 'null' } catch { return String(value) }
}
