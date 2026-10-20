/**
 * The one place a connection is built.
 *
 * Three call sites used to each build their own SSEClient and re-implement the same things (turn the request
 * into a fetch, shape each message for the UI, map phases, stamp arrival time): the SharedWorker, the in-page
 * fallback in useSharedStream, and every lane in useMultiStream. They now call this, so observation and recording
 * live in a single place, and there is one behaviour to test.
 *
 * Recording is opt-in (`recording`). When on, the stream owns a Recorder (stamps every record), a CaptureStore
 * (bounded memory) and a PayloadProbe (extracts the profile's fields from each payload, once), and hands records to the
 * caller in batches. When off, nothing observes and the client does no extra work.
 *
 * The factory is deliberately thin about everything else: what a caller does with a message (buffering for late
 * joiners, the ingest queue, a per-lane list) stays with the caller.
 */

import { SSEClient, type SSEClientOptions, type SSEPhase, type SSEPhaseInfo } from './sseClient'
import type { SSEMessage } from './sseParser'
import type { IncomingSSE } from './incoming'
import type { Clock } from '../clock'
import { newCaptureId } from '../observe/captureId'
import { CaptureStore } from '../observe/captureStore'
import { createBatcher, type Batcher } from '../observe/batcher'
import type { Observation } from '../observe/observation'
import { PayloadProbe, type PayloadProbeConfig } from '../observe/payloadProbe'
import { Recorder, type RecorderOverhead } from '../observe/recorder'

export interface ObservedStreamSinks {
    onMessage(message: IncomingSSE): void
    onPhase(phase: SSEPhase, info: SSEPhaseInfo): void
}

export interface RecordingOptions {
    /** Which payload fields to extract (sequence, timestamp, partition, heartbeat). Default: none, only a hash. */
    profile?: PayloadProbeConfig
    /** Keep the wire bytes of every read, for a byte-exact local capture (default off). Counts against the memory cap. */
    captureBytes?: boolean
    /** Memory cap for retained records (default 8 MiB). */
    capBytes?: number
    /** Time source for stamping; defaults to the real monotonic clock. */
    clock?: Clock
    /** Where the records were taken: the transport (default) or the page. */
    domain?: 'transport' | 'page'
    /** Receives records in batches (every `flushMs`, or when `maxBatch` are pending, or on flush/stop). */
    onObservations?: (batch: Observation[]) => void
    flushMs?: number
    maxBatch?: number
}

export interface ObservedStreamOptions {
    /** Builds the request for every (re)connection; `lastEventId` is '' until the server sent an id. */
    request: SSEClientOptions['request']
    sinks: ObservedStreamSinks
    /** Gives each message a sequence number. The SharedWorker numbers messages across all of its connections. */
    nextSeq?: () => number
    /** Wall-clock milliseconds stamped on each message as `arrivalTime`. Defaults to Date.now. */
    now?: () => number
    /** Replaces how the client is constructed (the worker's test seam). Defaults to `new SSEClient(options)`. */
    clientFactory?: (options: SSEClientOptions) => SSEClient
    /** Extra client options (retry/backoff tuning, stop events, initialLastEventId...). Callbacks set here are overridden. */
    clientOptions?: Partial<Omit<SSEClientOptions, 'request' | 'onMessage' | 'onPhase' | 'onObservation' | 'describeEvent'>>
    /** Turn on recording. Absent means no observation at all. */
    recording?: RecordingOptions | undefined
}

export interface ObservedStream {
    /** Opaque random id for this stream's capture. Never derived from the URL or token. */
    readonly captureId: string
    start(): void
    /** Stops the client and hands over any pending observations. */
    stop(): void
    readonly isRunning: boolean
    /** The last event id the server sent, as the client would send it on reconnect. */
    readonly lastId: string
    /** Present only when recording is on. */
    readonly recorder: Recorder | undefined
    readonly store: CaptureStore | undefined
    /** Hand over pending observations now (a no-op when recording is off). */
    flushObservations(): void
    /** What recording costs; undefined when recording is off. */
    overhead(): RecorderOverhead | undefined
}

export function createObservedStream(options: ObservedStreamOptions): ObservedStream {
    const { request, sinks, nextSeq, clientFactory, clientOptions, recording } = options
    const now = options.now ?? Date.now

    let recorder: Recorder | undefined
    let store: CaptureStore | undefined
    let batcher: Batcher<Observation> | undefined
    let probe: PayloadProbe | undefined
    let lastEventSeq: number | undefined

    if (recording) {
        store = new CaptureStore(recording.capBytes !== undefined ? { capBytes: recording.capBytes } : {})
        probe = new PayloadProbe(recording.profile ?? {})
        const onObservations = recording.onObservations
        if (onObservations) batcher = createBatcher<Observation>(recording.flushMs ?? 100, recording.maxBatch ?? 200, onObservations)
        const sinkStore = store
        const sinkBatcher = batcher
        recorder = new Recorder({
            clock: recording.clock,
            domain: recording.domain ?? 'transport',
            onRecord: (o) => {
                if (o.kind === 'event') lastEventSeq = o.seq // the client records the event just before it delivers it
                sinkStore.append(o)
                sinkBatcher?.push(o)
            },
        })
    }

    const activeRecorder = recorder
    const activeProbe = probe
    const clientConfig: SSEClientOptions = {
        ...clientOptions,
        request,
        onMessage: (m) => {
            const incoming: IncomingSSE = { event: m.event, data: m.data, id: m.id, raw: m.raw, arrivalTime: now() }
            if (nextSeq) incoming.seq = nextSeq()
            if (activeRecorder && lastEventSeq !== undefined) incoming.obsSeq = lastEventSeq
            sinks.onMessage(incoming)
        },
        onPhase: (phase, info) => sinks.onPhase(phase, info),
        ...(activeRecorder ? { onObservation: (draft) => { activeRecorder.record(draft) } } : {}),
        ...(activeProbe ? { describeEvent: (m: SSEMessage) => activeProbe.probe(m) } : {}),
        ...(activeRecorder && recording?.captureBytes ? { captureBytes: true } : {}),
    }
    const client = clientFactory ? clientFactory(clientConfig) : new SSEClient(clientConfig)

    return {
        captureId: newCaptureId(),
        start: () => client.start(),
        stop: () => { client.stop(); batcher?.stop() },
        get isRunning() { return client.isRunning },
        get lastId() { return client.lastId },
        recorder,
        store,
        flushObservations: () => batcher?.flush(),
        overhead: () => recorder?.overhead(),
    }
}
