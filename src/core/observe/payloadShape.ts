/**
 * The structure of a JSON payload, without its values: which fields are there and what kind each is. Recorded with every event so a
 * later change of format (a field gone, a field new, a number that became a string) can be found by comparing events, long after the
 * payload text itself is gone.
 *
 * A shape is a short string, `id:n|user:o|user.name:s|tags:a|tags[]:s`: one `path:kind` per field, sorted, so the order a producer
 * writes its keys in does not matter. Kinds: z null, b true/false, n number, s string, o object, a array. Arrays are described by their
 * first element (`tags[]`). Only the first three levels and the first 40 fields are described, and a key longer than 32 characters is cut:
 * a shape is a fingerprint of the format, not a copy of the payload. It holds key NAMES and kinds, never a value.
 */

export type ShapeKind = 'z' | 'b' | 'n' | 's' | 'o' | 'a'

/** A payload longer than this is not described: parsing it costs more than the shape is worth. */
export const SHAPE_MAX_CHARS = 4 * 1024
const MAX_FIELDS = 40
const MAX_DEPTH = 3
const MAX_KEY = 32

const kindOf = (v: unknown): ShapeKind => (v === null ? 'z' : Array.isArray(v) ? 'a' : typeof v === 'object' ? 'o' : typeof v === 'boolean' ? 'b' : typeof v === 'number' ? 'n' : 's')

/** `|` and `:` separate the parts of a shape and `.` and `[` build paths, so none may appear inside a key. */
const cleanKey = (key: string): string => (key === '' ? '_' : key.slice(0, MAX_KEY).replace(/[|:.[\]]/g, '_'))

function describe(value: unknown, path: string, depth: number, out: Map<string, ShapeKind>): void {
    if (out.size >= MAX_FIELDS) return
    const kind = kindOf(value)
    out.set(path, kind)
    if (depth >= MAX_DEPTH) return
    if (kind === 'o') {
        for (const key of Object.keys(value as Record<string, unknown>).slice(0, MAX_FIELDS)) {
            describe((value as Record<string, unknown>)[key], path === '$' ? cleanKey(key) : `${path}.${cleanKey(key)}`, depth + 1, out)
        }
    } else if (kind === 'a') {
        const first = (value as unknown[])[0]
        if (first !== undefined) describe(first, `${path === '$' ? '' : path}[]`, depth + 1, out)
    }
}

/** The shape of an already parsed payload, or undefined when it is not an object or an array. */
export function shapeOfValue(value: unknown): string | undefined {
    const kind = kindOf(value)
    if (kind !== 'o' && kind !== 'a') return undefined
    const fields = new Map<string, ShapeKind>()
    describe(value, '$', 0, fields)
    return [...fields.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([path, k]) => `${path}:${k}`).join('|')
}

/** The shape of payload text, or undefined when it is too long, does not look like a JSON object or array, or does not parse. */
export function shapeOfText(data: string): string | undefined {
    if (data.length === 0 || data.length > SHAPE_MAX_CHARS) return undefined
    const first = data.trimStart()[0]
    if (first !== '{' && first !== '[') return undefined
    try { return shapeOfValue(JSON.parse(data)) } catch { return undefined }
}

/** A shape back into its fields. A string that is not a shape gives an empty map. */
export function parseShape(shape: string): Map<string, ShapeKind> {
    const fields = new Map<string, ShapeKind>()
    for (const part of shape.split('|')) {
        const at = part.lastIndexOf(':')
        if (at <= 0) continue
        const kind = part.slice(at + 1)
        if (kind === 'z' || kind === 'b' || kind === 'n' || kind === 's' || kind === 'o' || kind === 'a') fields.set(part.slice(0, at), kind)
    }
    return fields
}

const KIND_WORD: Record<ShapeKind, string> = { z: 'null', b: 'true/false', n: 'a number', s: 'text', o: 'an object', a: 'a list' }
export const kindWord = (k: ShapeKind): string => KIND_WORD[k]
