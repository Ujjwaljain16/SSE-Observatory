# Multi-Stream Correlation

Server-Sent Events are usually analyzed one connection at a time. The **SSE Observatory Multi-Stream** capability allows you to pipe up to 3 asynchronous event streams into the identical Global Timeline to detect race conditions spanning microservices.

## Setup

1. Enable the **Multi-Stream** mode toggle switch located at the top of the interface. 
2. Add endpoints using the `Stream Lanes` drawer. Enter the URL (e.g., `http://localhost:4003/stream-a`) and optionally provide an overriding `Bearer Token`.
3. Give each stream a friendly label (e.g., `Payment Service`).

## Timeline Integration

Every event received natively binds to its origin lane via a randomized global ID algorithm powered by the background `SharedWorker`.

In the Global Timeline UI, streams receive distinct colors (`blue`, `emerald`, `indigo`). Because event timestamp evaluation executes directly via atomic `performance.now()`, intermixed streams are accurately ordered within `<1ms` deviations.

## Distributed Trace Detection

Combining Multi-Stream Mode with the default OpenTelemetry parsers provides immediate architectural insight:

If Stream A emits a `create_order` event containing `"traceId": "t-1234"`, and exactly `300ms` later Stream B emits an `auth_failure` mapped to the identical `traceId` `"t-1234"`, the Observatory natively binds the sequence log together in the Trace Inspector automatically.
