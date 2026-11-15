// Types for lib/capture/integrity.js (plain JavaScript so the mock server and the TypeScript core share one implementation).

export type CaptureProblemCode = 'record.invalid' | 'seq.duplicate' | 'seq.order' | 't.backwards'

export interface CaptureProblem {
    code: CaptureProblemCode
    /** What is wrong and where, in a sentence. */
    message: string
    /** The record's `seq`, when it has a usable one. */
    seq?: number
    /** Position among the records, from 0. */
    index: number
    /** The line in the file, when the records were read from one. */
    line?: number
}

export const MAX_CAPTURE_PROBLEMS: number
export function recordShapeProblem(record: unknown): string | undefined
export function validateCaptureIntegrity(records: ReadonlyArray<unknown>, options?: { lines?: ReadonlyArray<number | undefined> }): CaptureProblem[]
export function describeCaptureProblems(problems: readonly CaptureProblem[], shown?: number): string
