/**
 * Did the Doctor find what a fixture says it must, and nothing it says it must not? One definition, used by the lab's page, by the script
 * that makes the lab, and by the test that keeps the lab truthful.
 */

/** A finding key matches a fixture's key or prefix when it is that key or continues it (`stall.silent` matches `stall.silent:events`). */
export const matchesKey = (key: string, prefix: string): boolean => key === prefix || key.startsWith(prefix)

export interface Expectation {
    key: string
    /** For something expected: it was found. For something forbidden: it was NOT found. */
    met: boolean
    /** The findings that broke a "must not" (empty when met). */
    offenders: string[]
}

export interface LabCheck {
    expected: Expectation[]
    forbidden: Expectation[]
    ok: boolean
    /** One sentence per thing that went wrong, for logs. */
    problems: string[]
}

export function checkExpectations(foundKeys: readonly string[], expected: readonly string[], forbidden: readonly string[]): LabCheck {
    const expectedResults = expected.map((key): Expectation => ({ key, met: foundKeys.some((k) => matchesKey(k, key)), offenders: [] }))
    const forbiddenResults = forbidden.map((key): Expectation => {
        // '*' means no finding at all: a healthy twin
        const offenders = key === '*' ? [...foundKeys] : foundKeys.filter((k) => matchesKey(k, key))
        return { key, met: offenders.length === 0, offenders }
    })
    const problems = [
        ...expectedResults.filter((e) => !e.met).map((e) => `${e.key} was expected but not found (found: ${foundKeys.join(', ') || 'nothing'})`),
        ...forbiddenResults.filter((e) => !e.met).map((e) => `${e.key === '*' ? 'no finding' : e.key} was expected to be absent but ${e.offenders.join(', ')} appeared`),
    ]
    return { expected: expectedResults, forbidden: forbiddenResults, ok: problems.length === 0, problems }
}
