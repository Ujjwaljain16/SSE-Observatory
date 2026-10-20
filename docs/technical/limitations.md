# Known Limitations

## 1. The viewer shows the newest 1,000 events

The in-memory buffer holds 1,000 events. Older events are in IndexedDB (up to 100,000) and can be loaded or exported, but they are not all visible at once. Very high rates are ingested in time-sliced batches and the list is virtualised, so the page stays responsive, but you will only ever see the latest window go by. Use filters, interceptors that drop noise, or the pause control to inspect a moment.

## 2. Hosted deployments cap stream length

On Vercel Hobby the proxy function is limited by the platform (the project config allows up to 60 s and streams are capped at 55 s). When the cap is reached the proxy ends the stream and the browser reconnects automatically, sending `Last-Event-ID` if the target supports it, so you may see a brief pause or a few missed events with targets that cannot resume. Self-host (Docker, or `node server.js` after `npm run build`) and raise `MAX_STREAM_SECONDS` for longer streams.

## 3. The proxy is deliberately restrictive

In production it relays only to `ALLOWED_HOSTS` (or any public host when `PROXY_OPEN=1`), never to private, loopback, link-local or metadata addresses, and only for requests from the app's own origin. Targets that need cookies or custom request headers other than a bearer token are not supported. For local services, turn the proxy off and connect directly (the target must allow CORS), or self-host with `ALLOW_PRIVATE_TARGETS=1`.

## 4. SharedWorker support varies

Some browsers and embedded webviews do not provide a working SharedWorker. The app then runs the connection in the page itself; connections are not shared between tabs in that case.

## 5. Interceptors are bounded

An interceptor call is killed after 100 ms. Heavy transformations on very hot streams add up: keep interceptors small, or move the logic upstream.

The sandbox limits **time**, not **memory**. Browsers have no per-worker memory cap, so interceptor code that allocates without bound (for example pushing large strings into an ever-growing array) can use up the page's memory within its 100 ms budget and crash the tab. Interceptors are code you run yourself; treat that as a self-inflicted limit, and do not paste untrusted snippets.

## 6. Mock sessions are ephemeral

Mock replay sessions live in server memory (or KV when configured) for one hour. A server restart on a single-instance setup discards them; upload the recording again.

## 7. Recording costs memory in the page

Each stream keeps what it observed (connections, response headers, one record per network read and per event, comments, violations) in a bounded store, 8 MiB by default, and the page keeps a copy of what a SharedWorker records.

Measured in the production build in Chrome with a forced garbage collection, for a burst of 20,000 events (three runs each):

| | page heap, peak | page heap kept after GC | long tasks |
|---|---|---|---|
| recording on (default) | +90 to +97 MB | +22 to +30 MB | 0 to 128 ms in 9 s |
| recording off | +47 to +48 MB | +12 to +20 MB | 0 ms |

So recording keeps about 10 MB (the store's design cap) and adds about 45 MB of short-lived garbage at the peak of an extreme burst, which the browser reclaims. A 10-minute soak on a continuous stream stayed flat at 14 to 15 MB of page heap. The store evicts per-read detail first and says so (`truncated` records); it never grows past its cap.

To turn recording off (the viewer is unaffected; the diagnostics then have nothing to read), run `localStorage.setItem('sse.recording', 'off')` in the page's console and reconnect. When several tabs share one connection, the tab that opens it decides for all of them.

## 8. Capture size limits

A capture upload to the mock server is limited to 20 MB (raw NDJSON) or 10 MB (JSON body). On Vercel, functions accept request bodies of about 4.5 MB, so larger captures need a self-hosted server. Wire bytes make a capture roughly a third larger than the stream it holds (Base64), and a full-fidelity capture is never to be shared: redact it first.

## 9. The CLI reads whole files and uses Node's fetch

`analyze` and `redact` read the file into memory; a 116 MB capture (1.2 million records) analyzes in about 24 s inside a 384 MB heap, and redaction handles 200,000 chunks with 200,000 secrets in about 4 s. Node's `fetch` decodes compressed responses itself, does not honour `HTTP_PROXY`, and chunks reads differently from a browser, so a CLI capture and a browser capture of the same stream can differ in chunk sizes; each capture records which client made it.
