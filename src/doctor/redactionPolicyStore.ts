/**
 * The person's own redaction rules, kept in this browser (the same format as the CLI's --redact-policy file). They are applied by
 * every shareable export, on top of the built-in rules; they can only make redaction stricter or keep a harmless header.
 *
 * Anything stored that does not pass `parseRedactionPolicy` is ignored, so a hand-edited or old value cannot weaken redaction
 * in surprising ways: a policy with any problem is not used at all and the built-in rules apply alone.
 */

import { parseRedactionPolicy, policyToJson } from '../core/capture/policy'
import type { RedactionPolicy } from '../core/capture/redact'

const KEY = 'sse.redaction.policy'

let memory: string | null = null // where it lives when the browser will not store it (private windows)
let cache: { raw: string | null; policy: RedactionPolicy | undefined } = { raw: null, policy: undefined }
const listeners = new Set<() => void>()

function read(): string | null {
    try { return localStorage.getItem(KEY) } catch { return memory }
}

/** The saved policy, or undefined. The same object is returned until the stored text changes. */
export function getRedactionPolicy(): RedactionPolicy | undefined {
    const raw = read()
    if (raw === cache.raw) return cache.policy
    const checked = raw ? parseRedactionPolicy(raw) : { errors: [] as string[], policy: undefined }
    cache = { raw, policy: checked.errors.length === 0 ? checked.policy : undefined }
    return cache.policy
}

/** The saved policy as editable text ('' when there is none). */
export function getRedactionPolicyText(): string {
    return policyToJson(getRedactionPolicy())
}

/** Save a policy (already checked by the caller), or clear it with undefined. */
export function setRedactionPolicy(policy: RedactionPolicy | undefined): void {
    const raw = policy ? policyToJson(policy) : null
    memory = raw
    try { if (raw) localStorage.setItem(KEY, raw); else localStorage.removeItem(KEY) } catch { /* kept in memory for this tab */ }
    for (const listener of listeners) listener()
}

export function subscribeRedactionPolicy(listener: () => void): () => void {
    listeners.add(listener)
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) listener() } // another tab changed it
    window.addEventListener('storage', onStorage)
    return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage) }
}
