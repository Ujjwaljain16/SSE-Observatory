# Architecture

The app is a browser pipeline that keeps parsing, filtering and sandboxed code off the UI thread and keeps every buffer bounded.

```text
SSE source ──(optional /api/sse proxy)──► SSEClient ──► ingest queue ──► interceptors ──► ring buffer (1,000)
                                                                              │                  │
                                                                              ▼                  ├─► filter engine ─► virtualised list
                                                                         IndexedDB (≤100k)       ├─► pattern / correlation / schema
                                                                                                 └─► timeline canvas
```

## Transport

`SSEClient` is a `fetch`-based, spec-compliant SSE client (`SSEParser` handles `\r\n`, multi-line data, `retry:`, `id:`). It supports named events, `Last-Event-ID` resume, exponential backoff with jitter, and distinguishes fatal errors (bad URL, 401/403/404, wrong content type) from retryable ones. `event: end` or a `204` stops it for good.

When the **Use Server Proxy** switch is on, the request is sent as `POST /api/sse` with `{url, token}` in the body, so the token never appears in a URL or access log.

`sharedSSEWorker.ts` runs one `SSEClient` per url+token and fans events out to every tab over `MessagePort`s. Where SharedWorker is unavailable the same client runs in the page.

## Ingest

`useEventIngest` queues incoming events and flushes them in time-boxed slices (about 8 ms) driven by `requestAnimationFrame` with a timer fallback, so a burst cannot block a frame. The queue is bounded; excess events are counted as dropped and shown in the UI. Interceptors run in order before events are stored.

## Buffers and storage

- **Ring buffer:** the newest **1,000** events live in memory (newest first). Consumers detect new events by identity and see wholesale replacement (reconnect, history load) through an `epoch` counter.
- **IndexedDB:** every event is also written in batches; the newest 100,000 are kept. **Load history** reads back what fits the viewer; **Export all** writes everything to a `.sse-record` file.

## Workers

| Worker | Job |
|---|---|
| `sharedSSEWorker` | One connection per url+token, shared across tabs. |
| `filterWorker` | Holds a bounded copy of the buffer and applies the query, search and field filters incrementally (`FilterEngine`). |
| `interceptorWorker` | Runs user interceptors in a hardened global with a 100 ms kill timer (see the interceptor guide). |
| `timelineWorker` | Draws the timeline on an `OffscreenCanvas` when available. |

## Server

`server.js` (Express) and the Vercel function in `api/` share the same code in `lib/`: the proxy (`lib/proxy`) and the mock replay API (`lib/mock`). The proxy is closed by default in production, blocks private/metadata addresses after DNS resolution and pins the connection to the validated IP, requires a same-origin browser request, only relays `200 text/event-stream` responses, and caps stream duration, bytes and concurrency. See the README for the environment variables.
