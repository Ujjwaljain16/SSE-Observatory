# Multi-Stream

Multi-Stream mode connects several SSE endpoints at once and merges their events into one list, newest first, so you can see how services interleave.

## Setup

1. Switch to **Multi-Stream** at the top of the page.
2. In **Stream Lanes**, enter a name and URL (for example `http://localhost:4003/stream-a`), optionally a bearer token, and click **Add**.
3. Press **Connect** on each lane. Each lane can be connected, disconnected, cleared or removed on its own; the header shows how many lanes are live.

Every lane gets its own colour, and every event is tagged with its lane.

## Ordering

Events are ordered by their arrival time in your browser, not by any clock on the servers, so two streams from different machines compare fairly. Arrival time is when the browser received an event; network latency between you and each server still applies.

## Finite streams

A stream that sends `event: end` is treated as finished and the lane stops. A stream that simply closes is treated as a dropped connection and reconnects with exponential backoff, resuming from the last event id when the server supports `Last-Event-ID`.

## Correlating across streams

If events in different lanes carry the same correlation id in their payload, they are grouped into one trace in the Trace panel. The fields checked, at the top level and one level down, are `traceId`, `requestId`, `correlationId` and `transactionId` (and their `snake_case`, `kebab-case` and `x-` header variants). `spanId`, `userId` and `sessionId` are intentionally not used: they identify a single span or group unrelated activity.
