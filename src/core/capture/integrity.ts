/**
 * Is the list of records in a capture what a recorder writes? The rules (a duplicate `seq`, a `seq` that goes down, a `t` that goes
 * backwards, a record that lacks `kind`, `seq` or `t`) live in `lib/capture/integrity.js`, in plain JavaScript, because the mock server cannot
 * run TypeScript and must reach the same verdict on the same file. This module is the typed way in for the command line and the Doctor.
 * The signatures are written out here (not re-exported) so the declarations the package ships do not point outside it.
 */

import * as shared from '../../../lib/capture/integrity.js'

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

/** The list stops here: a hostile file must not make the answer as large as the file. */
export const MAX_CAPTURE_PROBLEMS: number = shared.MAX_CAPTURE_PROBLEMS

/** Why a value is not a record (no text `kind`, or a `seq` or `t` that is not a finite number), or undefined when it is one. */
export const recordShapeProblem = (record: unknown): string | undefined => shared.recordShapeProblem(record)

/** Checks the records in file order. `lines[i]` is the line of `records[i]` when they came from a file. */
export const validateCaptureIntegrity = (records: ReadonlyArray<unknown>, options?: { lines?: ReadonlyArray<number | undefined> }): CaptureProblem[] => shared.validateCaptureIntegrity(records, options)

/** What a person is told about an invalid capture; the empty string when there is no problem. */
export const describeCaptureProblems = (problems: readonly CaptureProblem[], shown?: number): string => shared.describeCaptureProblems(problems, shown)
