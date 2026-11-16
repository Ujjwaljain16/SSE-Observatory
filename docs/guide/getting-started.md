# Getting Started

SSE Observatory is a browser-based tool for inspecting Server-Sent Event (SSE) streams in real time. Parsing, filtering and interceptors run in Web Workers; events are kept in a bounded in-memory buffer and mirrored to IndexedDB.

## Installation

Requires **Node.js 20+**.

```sh
git clone https://github.com/Ujjwaljain16/SSE-Observatory.git
cd SSE-Observatory
npm ci
npm run dev
```

Open `http://localhost:3001`. `npm run dev` starts the Vite UI and the local API server (`server.js`, port 3000) that provides the stream proxy and mock replay API.

## Connecting to a stream

1. **Endpoint:** paste the URL of the SSE stream into the **Connection** panel.
2. **Authentication:** optional bearer token. It is sent as `Authorization: Bearer <token>` and, with the proxy on, in a POST body rather than the URL. Saved profiles do not store the token unless you tick **Remember token**.
3. **Connect.** While connecting you can cancel; if the connection drops you will see a retry countdown.

If the address is not an event stream at all (a web page or a JSON endpoint answers instead), the connection stops after the first attempt and says so, for example "The address answers with text/html, not text/event-stream, so there is nothing to retry." The same message appears with the proxy on or off. A server that is down, or answers 5xx, is retried with a countdown.

For assistive technology, a connection that **fails for good** (a refused address, HTTP 401/403/404, the retries used up) is announced at once as an alert. A **retry** ("Connection lost … Retrying in 5s (attempt 2)") is announced politely, once for each attempt: the seconds are shown but are not part of what a screen reader reads, so a countdown never makes it repeat itself. The same applies to each lane in Multi-Stream. This was checked by automated tests and by reading the accessibility tree; it has not been tried with a real screen reader.

Leave **Use Server Proxy** on for endpoints that do not send CORS headers. Turn it off to connect straight from the browser (the endpoint must allow your origin).

## Try it with the test servers

In another terminal:

- `npm run simple`: clean heartbeats
- `npm run chaos`: dropped connections, latency and bursts
- `npm run demo`: a realistic order, payment and error stream on `http://localhost:4010/demo`

Run `npm run dev:all` to start the app and the chaos server together. More scenarios live in `test-servers/` (multi-stream, patterns, interceptors).

Local test servers are reachable through the proxy in development. In production the proxy refuses private addresses, so connect directly or self-host with `ALLOW_PRIVATE_TARGETS=1`.

## Find out why a stream misbehaves (new in 2.0)

1. Connect to the stream as above, then open **Doctor** (the button beside the event list). The health strip says whether the connection is open, when the last byte and the last event arrived, and how many reconnects there were. Findings appear as the stream shows a problem, each with what was observed, what is only inferred and a command to check next. [Details](/guide/stream-doctor).
2. To keep the evidence, choose **Export...**: a report, a shareable capture (redacted before it leaves the page), a curl command, or a test scenario that fails while the problem is there and passes when it is fixed.
3. The same checks run on the command line, for CI and for streams you cannot open in a browser:

```sh
npm run build:cli
npm run doctor -- probe https://example.com/stream --duration 30 --out incident.sse-capture
npm run doctor -- analyze incident.sse-capture
npm run doctor -- fixtures list        # the built-in faulty streams and their healthy twins, to try every rule
```

See [the command line](/guide/cli) and [Scenarios and CI](/guide/cli-ci). What changed in this release is on [What's new in 2.0](/guide/whats-new).

## Try the hosted demo

The hosted demo at `https://sse-observatory.vercel.app` runs the same app. Its proxy relays public streams only (it refuses private and cloud-metadata addresses), so a public stream such as `https://stream.wikimedia.org/v2/stream/recentchange` works there, and the mock replay API is off on that deployment. To check that a deployment works end to end, run `npm run smoke:live` (a real browser against `--base <url>`).

