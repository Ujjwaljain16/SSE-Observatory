/**
 * A tiny JSON path reader for profile fields. Accepts `$.a.b`, `a.b`, `a[0].b` and `a.0.b`.
 * Only own properties are followed, so a path like `__proto__.x` or `constructor.name` finds nothing.
 */
export function getJsonPath(root: unknown, path: string): unknown {
    const steps = parsePath(path)
    if (steps === null) return undefined
    let current: unknown = root
    for (const step of steps) {
        if (current === null || typeof current !== 'object') return undefined
        if (!Object.prototype.hasOwnProperty.call(current, step)) return undefined
        current = (current as Record<string, unknown>)[step]
    }
    return current
}

function parsePath(path: string): string[] | null {
    let rest = path.trim()
    if (rest.startsWith('$')) rest = rest.slice(1)
    if (rest.startsWith('.')) rest = rest.slice(1)
    if (rest === '') return null
    const steps: string[] = []
    for (const part of rest.split('.')) {
        if (part === '') return null
        // "items[0][1]" -> "items", "0", "1"
        const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part)
        if (!match) return null
        if (match[1]) steps.push(match[1])
        for (const index of (match[2] ?? '').matchAll(/\[(\d+)\]/g)) steps.push(index[1] as string)
    }
    return steps.length > 0 ? steps : null
}
