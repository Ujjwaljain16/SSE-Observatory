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

## 8. Capture size limits, and the mock API on Vercel

A capture upload to the mock server is limited to 20 MB (raw NDJSON) or 10 MB (JSON body). On Vercel, functions accept request bodies of about 4.5 MB (a larger upload gets `413 FUNCTION_PAYLOAD_TOO_LARGE` before it reaches the app), so larger captures need a self-hosted server.

On Vercel the upload and the stream are different functions with separate memory, so the mock API **needs a working KV store** (`KV_REST_API_URL`); without one the upload is refused with a 503 that says so. Checked against a real preview deployment: NDJSON and JSON uploads are accepted, the stream finds a session only through KV, and a KV store that is configured but unreachable also gives a 503 ("Mock storage unavailable"). Wire bytes make a capture roughly a third larger than the stream it holds (Base64), and a full-fidelity capture is never to be shared: redact it first.

## 9. The CLI reads whole files and uses Node's fetch

`analyze` and `redact` read the file into memory; a 116 MB capture (1.2 million records) analyzes in about 24 s inside a 384 MB heap, and redaction handles 200,000 chunks with 200,000 secrets in about 4 s. Node's `fetch` decodes compressed responses itself, does not honour `HTTP_PROXY`, and chunks reads differently from a browser, so a CLI capture and a browser capture of the same stream can differ in chunk sizes; each capture records which client made it.

## 10. What the Doctor can and cannot see

The Doctor reads what the client observed, so it knows when bytes arrived, how large they were, what the response said and which events were parsed. It does not know what happened on the other side:

- **No layer attribution.** A browser capture shows that bytes stopped arriving, not whether the producer, a proxy, a CDN or the network stopped them. Findings state the measurement, then a deduction worded "Likely: …" with its confidence and the other explanations that fit. The check to run next is the one that tells them apart.
- **Cross-origin responses hide headers.** A page can read only the CORS-safelisted headers plus whatever the server exposes. Checks that need others report *not evaluated* for such a stream, and work in full through the app's own proxy (which adds `X-SSE-*` headers a page on the same origin can read) and in the command line.
- **Silence is judged against the stream's own rhythm** (three times its 95th percentile gap, or twice its heartbeat interval, once enough gaps were seen). Before that, or for a stream that is quiet by design, it waits 30 s and says it cannot tell a stall from an idle period. A tab hidden for 2 s or more restarts the measurement instead of reporting the time away.
- **Continuity needs a declaration.** Gaps and duplicates are judged only for a declared sequence (a JSON path or the SSE id, counted one by one or upwards). Ids that merely count up are shown as a hint.
- **The app records what happened on the wire, not what events said.** Event bodies are not kept, so an export has no event data, a replay uses placeholder bodies of the original size, and checks that read a payload see only the fields the profile names, read as each event is recorded. A stream already connected when a profile is declared carries the numbers only after it reconnects.
- **The recording is bounded** (8 MB per stream). Per-read detail is folded away first, and the recording and an exported capture say so.
- **"No findings" is not "healthy".** Checks that had nothing to look at are listed as *not evaluated*, and a capture imported from an older `.sse-record` has event times only.

## 11. What is kept in the browser

A capture saved to the library is the recording as the app held it, **not redacted**, in this browser's IndexedDB (up to 20 captures of 20 MB), together with its bookmarks. The profile, pinned fields and saved filters are in `localStorage`. Clearing the site's data removes all of it, and a private window may not keep it. Nothing is uploaded; a capture leaves the browser only through Export, which redacts it, shows what it replaced, scans the result for anything that still looks secret and waits for a person to acknowledge a hit. The scan is a check and not a guarantee: a secret in free text that matches no known format and looks like ordinary words cannot be found.

## 12. Reproduction is only as faithful as what was recorded

Replaying an exported capture reproduces its timing, ids, event names, reconnects and the numbers the profile reads. It does not reproduce payloads, and it plays the timings back instead of measuring a network, so the Doctor labels a replay as one. The mock server it uses is on in development and off on a public deployment unless `ENABLE_MOCK_API=1` is set; when it is on, uploads and streams are rate limited per client and per hour (see [Mock Server & Replay](/guide/mock-server)).

## 13. Not tested yet

The Doctor has automated accessibility checks (axe, WCAG A and AA), keyboard-only runs and checks of the accessibility tree, but **has not been used with a real screen reader**, on Mac Safari or on mobile Chrome. It has been run through Chromium locally and in CI on Chromium, Firefox and WebKit; the soak run on a long continuous stream is ten minutes, not an hour.
