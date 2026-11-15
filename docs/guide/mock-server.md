# Mock Server & Replay

Any captured session can be exported to a `.sse-record` file and replayed later from a local URL. This lets you reproduce an incident without access to the original backend.

## Exporting a session

1. Connect to a stream and let events arrive. Events are also saved to IndexedDB (up to 100,000, oldest evicted first).
2. Open the **Storage** panel and click **Export all**. This downloads a `.sse-record` JSON file with the events in order and the time between them (`deltaMs`).

## Replaying a session

1. Open the **Mock Server** tab and upload the file.
2. Choose a speed (**0.5x**, **1x**, **2x**) and whether to **Loop**.
3. Click **Start Mock Server**. The panel shows a private URL like `/api/mock/stream?session=<id>&speed=1&loop=false`.
4. Switch to **Monitor Mode**, paste that URL and connect. Everything else (filters, interceptors, patterns, timeline) works as it does on a live stream. `curl -N` works too.

When a non-looping replay finishes, the server sends an `event: end` message so the client stops instead of reconnecting and replaying again. Looping replays run until you disconnect or stop the server.

## Safety

- Each session has its own unguessable id; one session cannot be read through another.
- Sessions expire after one hour and are deleted when you click **Stop Mock Server**.
- Uploads are validated (event count, total size, `deltaMs` range).
- In production the mock API is off unless `ENABLE_MOCK_API=1` is set. For multi-instance deployments configure KV storage so every instance sees the same sessions.
- On Vercel the upload and the stream are separate functions, so a KV store (`KV_REST_API_URL`) is required; without it uploads are refused with a 503.
- Because the endpoint is public once enabled, it is rate limited per client and has a global hourly budget. Over a limit it answers `429` with a `Retry-After` header. Limits (set to `0` to turn one off):

  | Variable | Default | Meaning |
  |---|---|---|
  | `MOCK_UPLOADS_PER_MINUTE` | 20 | uploads per client per minute |
  | `MOCK_STREAMS_PER_MINUTE` | 60 | stream requests per client per minute |
  | `MOCK_SESSIONS_PER_HOUR` | 500 | stored sessions per hour, all clients |
  | `MOCK_MB_PER_HOUR` | 50 | stored megabytes per hour, all clients |
  | `MOCK_MAX_OPEN_STREAMS` | 50 | mock streams open at once, all clients (more get 429) |
  | `MOCK_MAX_STREAM_SECONDS` | 300 | how long one stream may stay open; a looping or held replay is ended after this |

  On Vercel a mock stream is cut after 60 seconds; a client that reconnects counts against the stream limit.

## Record format

```json
{
  "version": "1.0",
  "events": [
    { "sseId": "1", "type": "tick", "data": "{\"n\":1}", "deltaMs": 0 }
  ]
}
```

`data` must be a string.

### What a `.sse-record` replays (v1 recordings)

A v1 event carries three different things, and they are kept apart:

| Field in the file | What it is | What the replay sends |
|---|---|---|
| `sseId` | the `id:` the original server sent (absent when it sent none) | `id: <sseId>` |
| `type` | the `event:` name the original server sent (the viewer stores `message` when it sent none) | `event: <type>`, except `message` |
| `id` | the viewer's own storage identifier (a random uuid) | **nothing**: it is not an SSE field and is never sent as `id:` |
| `data` | the payload | sent as it is, byte for byte; the name is **not** merged into a JSON payload any more |

Where the recording did not keep a field, the replay sends no line for it and does not make one up:

- An event the server sent without an `id:` has no `sseId` in the file, so it is replayed with no `id:` line. Nothing in the file says what its id was.
- The name `message` is not written as `event: message`. The viewer stores `message` both for "no `event:` line" and for an explicit `event: message`, so the file cannot tell them apart; a client dispatches both as the same `message` event, and the capture replay does the same.
- `parsedType` (a `type` value found inside a JSON payload) is not an SSE field and is not replayed.
- A file written by hand with only `id` (the form this page used to show) now replays with no `id:` line. Use `sseId` for an id you want sent.

**Resuming with `Last-Event-ID`.** A `.sse-record` upload is replayed from the start on every request: the server ignores the `Last-Event-ID` header for it, whatever the id, so a recording never pretends to resume. The ids it sends are the real ones, so a client that reconnects with one gets the whole recording again. To get resumption, upload the recording as a capture instead (the Doctor imports a `.sse-record` as a capture): with `honorLastEventId=1` the replay continues after the event whose `id:` equals the header, and works only on real ids. If the id is not in the recording (an event that has none can never be one), `unknownId` decides (the default is to start from the beginning).

**About the samples.** The four v1 samples in the test suite were produced by running the v1 viewer's own export code, not downloaded from a running v1 app. They show the fields that code writes; compatibility with every real v1 export is not established until real files are tried.

## Replaying a capture (`.sse-capture` v2)

The mock server also takes a [capture](/technical/capture-format), as raw NDJSON (`Content-Type: application/x-ndjson`) or a JSON envelope `{ "capture": "<ndjson text>" }`. Old `.sse-record` files keep working exactly as before.

What is replayed depends on what the capture kept:

| Capture holds | Replay | Response header |
|---|---|---|
| wire bytes (local full-fidelity capture) | each network read is written again at its recorded time, so lumps, frames split across reads and comments reproduce byte for byte | `X-Mock-Fidelity: chunk-faithful` |
| redacted text per read (sanitized export) | the same, with the redacted text: timing-faithful, not byte-identical | `chunk-faithful` |
| only events (an imported v1 recording), or the replay must change what is sent | frames are rebuilt from the events or cut out of the recorded text | `event-level` |

A capture with no payload (nothing but metadata) is refused with a message saying so. The recorder keeps wire bytes only when asked; it is off by default because it makes captures large and able to hold secrets.

**Reconnects.** Each request to a capture session gets the next recorded connection (the first request gets the first connection, the second the second, and the last one repeats), so a capture that contained a reconnect reproduces it. Add `connection=<n>` to pick one.

Query parameters on `/api/mock/stream` for a capture session:

| Parameter | Meaning |
|---|---|
| `speed`, `loop` | as before |
| `honorLastEventId=1` | resume after the `Last-Event-ID` the client sent, across all recorded connections (event-level) |
| `unknownId=from-start\|400\|ignore` | what to do with an id that is not in the capture (default `from-start`) |
| `end=close\|hold\|rst\|end-event` | how a replay ends: a plain close (a client sees a dropped connection and reconnects, the default), keep the connection open, reset it, or send `event: end` |
| `skipIds=a,b`, `dropAfter=<n>` | test aids: leave out frames with these ids; end the connection after n frames or reads |
