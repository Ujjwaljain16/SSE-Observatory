/** What a transport hands to the UI for every SSE message. */
export interface IncomingSSE {
    /** SSE event name ("message" when unnamed). */
    event: string
    data: string
    /** Server-sent event id in effect ('' when none). */
    id: string
    /** Wire form of the event. */
    raw: string
    arrivalTime: number
    /** Monotonic sequence assigned by the SharedWorker (used to drop duplicates on catch-up). */
    seq?: number
    /** Sequence number of this event's observation record, when recording is on (lets evidence point at the event). */
    obsSeq?: number
}
