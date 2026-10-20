/**
 * The one place a connection is built.
 *
 * Three call sites used to each build their own SSEClient and re-implement the same four things (turn the request
 * into a fetch, shape each message for the UI, map phases, stamp arrival time): the SharedWorker, the in-page
 * fallback in useSharedStream, and every lane in useMultiStream. They now call this, so there is a single place to add
 * observation and recording, and one behaviour to test.
 *
 * The factory is deliberately thin: it owns the client and the message shaping, and hands results to sinks. What each
 * caller does with a message (buffering for late joiners, the ingest queue, a per-lane list) stays with the caller.
 */

import { SSEClient, type SSEClientOptions, type SSEPhase, type SSEPhaseInfo } from './sseClient'
import type { IncomingSSE } from './incoming'
import { newCaptureId } from '../observe/captureId'

export interface ObservedStreamSinks {
    onMessage(message: IncomingSSE): void
    onPhase(phase: SSEPhase, info: SSEPhaseInfo): void
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
    /** Extra client options (retry/backoff tuning, stop events...). Callbacks set here are overridden. */
    clientOptions?: Partial<Omit<SSEClientOptions, 'request' | 'onMessage' | 'onPhase'>>
}

export interface ObservedStream {
    /** Opaque random id for this stream's capture. Never derived from the URL or token. */
    readonly captureId: string
    start(): void
    stop(): void
    readonly isRunning: boolean
    /** The last event id the server sent, as the client would send it on reconnect. */
    readonly lastId: string
}

export function createObservedStream(options: ObservedStreamOptions): ObservedStream {
    const { request, sinks, nextSeq, clientFactory, clientOptions } = options
    const now = options.now ?? Date.now

    const clientConfig: SSEClientOptions = {
        ...clientOptions,
        request,
        onMessage: (m) => {
            const incoming: IncomingSSE = { event: m.event, data: m.data, id: m.id, raw: m.raw, arrivalTime: now() }
            if (nextSeq) incoming.seq = nextSeq()
            sinks.onMessage(incoming)
        },
        onPhase: (phase, info) => sinks.onPhase(phase, info),
    }
    const client = clientFactory ? clientFactory(clientConfig) : new SSEClient(clientConfig)

    return {
        captureId: newCaptureId(),
        start: () => client.start(),
        stop: () => client.stop(),
        get isRunning() { return client.isRunning },
        get lastId() { return client.lastId },
    }
}
