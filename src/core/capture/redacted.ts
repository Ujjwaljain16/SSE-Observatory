/**
 * `RedactedCapture` is a Capture that went through `redactCapture()`. Anything that leaves the machine (reports,
 * shared files, generated scenarios) accepts only this type, so "redact before sharing" is checked by the compiler.
 *
 * The brand can only be applied through `markRedacted`, which the public barrel does not export. A function that
 * wants to hand out a capture has to call `redactCapture`.
 */

import type { Capture } from './format'

declare const redactedBrand: unique symbol

export type RedactedCapture = Capture & { readonly [redactedBrand]: true }

/** Internal: used by redact.ts only. */
export function markRedacted(capture: Capture): RedactedCapture {
    return capture as RedactedCapture
}
