/**
 * The page's view of what each stream recorded, keyed by stream id ('main' for the single stream, the lane id for a
 * lane). The Doctor panel and the diagnostics read from here.
 *
 * Records reach it two ways, and both end up in a bounded CaptureStore:
 *  - from the SharedWorker, as batched `observations` messages (`receive`; the registry owns the store), and
 *  - from a stream running in this page (in-page fallback, lanes), which already keeps its own store (`attach` adopts it
 *    instead of copying it; the stream calls `notify` after each batch).
 * Page-domain `consumer` samples live in their own bounded list with their own sequence numbers: they are measured in
 * the page and are not part of the transport's record order.
 */

import { CaptureStore } from '../core/observe/captureStore'
import type { Observation, ObservationBody } from '../core/observe/observation'
import { Recorder } from '../core/observe/recorder'

const MAX_CONSUMER_SAMPLES = 2000

export interface RegistryEntry {
    streamId: string
    /** Identifies the capture the records belong to; a new id means the connection restarted, so old records are dropped. */
    captureId: string | null
    store: CaptureStore
    consumer: Observation[]
    /** Bumped on every change; a cheap value for useSyncExternalStore. */
    version: number
}

interface Internal extends RegistryEntry {
    adopted: boolean
    pageRecorder: Recorder
}

export interface IncomingObservations {
    captureId: string
    batch: Observation[]
    /** The batch is the whole retained history (sent to a tab that joined late): replace what is held. */
    replace?: boolean | undefined
}

export class ObservationRegistry {
    private readonly entries = new Map<string, Internal>()
    private readonly listeners = new Set<() => void>()

    get(streamId: string): RegistryEntry | undefined {
        return this.entries.get(streamId)
    }

    ids(): string[] {
        return [...this.entries.keys()]
    }

    /** Records from the SharedWorker for this stream. */
    receive(streamId: string, message: IncomingObservations): void {
        let entry = this.entries.get(streamId)
        if (!entry || entry.adopted) entry = this.create(streamId, new CaptureStore(), message.captureId, false)
        if (entry.captureId !== message.captureId) {
            entry.store = new CaptureStore()
            entry.captureId = message.captureId
            entry.consumer = []
        } else if (message.replace) {
            entry.store.clear()
        }
        for (const record of message.batch) entry.store.append(record)
        this.bump(entry)
    }

    /** Adopt the store of a stream that runs in this page (no copy). Replaces whatever the id held. */
    attach(streamId: string, store: CaptureStore, captureId: string): void {
        const previous = this.entries.get(streamId)
        const entry = this.create(streamId, store, captureId, true)
        if (previous) entry.consumer = [] // a new stream, new measurements
        this.bump(entry)
    }

    /** An attached stream appended records; tell subscribers. */
    notify(streamId: string): void {
        const entry = this.entries.get(streamId)
        if (entry) this.bump(entry)
    }

    /** A page-domain sample of how long events waited for processing. */
    recordConsumer(streamId: string, body: Extract<ObservationBody, { kind: 'consumer' }>): void {
        const entry = this.entries.get(streamId)
        if (!entry) return
        entry.consumer.push(entry.pageRecorder.record(body))
        if (entry.consumer.length > MAX_CONSUMER_SAMPLES) entry.consumer.splice(0, entry.consumer.length - MAX_CONSUMER_SAMPLES)
        this.bump(entry)
    }

    /** Forget the records of a stream that is about to start over. */
    reset(streamId: string): void {
        const entry = this.entries.get(streamId)
        if (!entry) return
        if (!entry.adopted) entry.store.clear()
        this.entries.delete(streamId)
        this.emit()
    }

    close(streamId: string): void {
        if (this.entries.delete(streamId)) this.emit()
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }

    private create(streamId: string, store: CaptureStore, captureId: string, adopted: boolean): Internal {
        const entry: Internal = { streamId, captureId, store, consumer: [], version: this.entries.get(streamId)?.version ?? 0, adopted, pageRecorder: new Recorder({ domain: 'page' }) }
        this.entries.set(streamId, entry)
        return entry
    }

    private bump(entry: Internal) {
        entry.version++
        this.emit()
    }

    private emit() {
        for (const listener of this.listeners) listener()
    }
}

export const observationRegistry = new ObservationRegistry()
export const MAIN_STREAM = 'main'
