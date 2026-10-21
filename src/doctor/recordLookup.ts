import type { Observation } from '../core/observe/observation'
import { observationRegistry } from './observationRegistry'

/** Page-domain sequence numbers start here, far above any transport record (see doctorSession.ts). */
export const CONSUMER_SEQ_BASE = 1_000_000_000

/** The retained record a finding points to, or undefined when it has been folded away or the stream was cleared. */
export function recordFor(streamId: string, seq: number): Observation | undefined {
    const entry = observationRegistry.get(streamId)
    if (!entry) return undefined
    if (seq >= CONSUMER_SEQ_BASE) return entry.consumer.find((c) => c.seq === seq - CONSUMER_SEQ_BASE)
    return entry.store.snapshot().find((o) => o.seq === seq)
}
