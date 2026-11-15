# Capture format (`.sse-capture` v2)

A capture is the evidence behind a diagnosis: what happened on the wire and in the client, in order, with timing. The same file is read by the in-app Doctor, the `sse-doctor` CLI and the tests, so one capture gives one answer everywhere.

## File layout

The file is newline-delimited JSON (NDJSON). A crash leaves a valid prefix, a long capture can be appended to, and a reader can stream it.

```text
line 1       header   { "format": "sse-capture", "version": "2.0", "kind": "local-full", ... }
lines 2..n   records  one observation per line
last line    footer   { "footer": { "counts": {...}, "endReason": "completed", "integrity": {...} } }
```

- **Versioning.** A major bump is a breaking change, a minor bump only adds. A reader ignores header fields and record kinds it does not know, and keeps them when it writes the file again. A newer minor version is read with a warning.
- **End time.** The footer may carry `endT`, the moment the recording stopped in the clock of the records. Without it a capture ends at its last record. A capture taken from the app while a stream is still open has an `endT` later than its last record, so a silence at the end (a stalled stream) is judged up to that moment when the capture is analysed or reduced.
- **Integrity.** The footer holds a SHA-256 over the record lines exactly as written. It is tamper-evidence for a report that travels between people, not a security control: anyone can recompute it. A file that was cut off (no footer, or a broken last line) is read as far as it goes and a warning says so.
- **Valid records.** The hash says the file was not changed after it was written; it says nothing about a file that was written wrong. Records must also be in a valid order, and a capture that is not is **refused, not analysed**: it would otherwise be judged as if it were a recording and could come out healthy. The rules, exactly: (1) every record has a text `kind` and finite numbers `seq` and `t` (`record.invalid`); (2) a `seq` is never used twice in a capture, wherever the two records are (`seq.duplicate`); (3) `seq` never goes down from one record to the next (`seq.order`; a repeat is reported as a duplicate instead); (4) `t` never goes down from one record to the next (`t.backwards`), where **equal is legal** (reads and events that arrive in the same millisecond share a `t`) and there is no tolerance (9.999 after 10 is a step back). A `seq` that skips numbers or does not start at 0 is legal (a capture trimmed to a window, records dropped by the memory cap). Unknown record kinds follow the same rules. A recorder cannot write a file that breaks them (one counter numbers every record and the clock is clamped so it never decreases), so a file that does was edited, merged from two recordings, or written by something else. The check is `validateCaptureIntegrity` (`lib/capture/integrity.js`, one implementation shared by the command line, the Doctor and the mock server); `parseCapture` still reads such a file as far as it goes and returns the problems, with the line of each record, so a tool can show the damage. A v1 import and every capture the recorder, the CLI's `probe`, the failure lab and the fixtures write pass it.
- **Header** records the tool, the analyzer version, the source (`browser-app`, `cli`, `fixture`, `import-v1`) and the client that produced the bytes (browsers and Node chunk and decode differently), the request (URL with query values removed), the stream profile, the redaction applied, and limits such as the memory cap.

## Records

Every record has `seq` (the recorder numbers records +1 each; a reader requires only that it is never repeated and never goes down, see Valid records above; a total order even when two records share a timestamp), `t` (monotonic milliseconds since the capture started, never decreasing) and `conn` (which connection attempt it belongs to). Wall-clock time appears once, in the header, and is never evidence.

| kind | what it holds |
|---|---|
| `connect` | attempt, redacted URL, method, request header names, `Last-Event-ID` sent |
| `response` | status, content type, redirect flag, diagnostic response headers, time to headers |
| `chunk` | byte count of one network read; the bytes themselves only in a local capture (`b64`) or their redacted text in a sanitized one (`text`) |
| `comment`, `retry` | SSE comment lines (heartbeats) and `retry:` values, each labelled proxy or upstream |
| `event` | event name, SSE id, payload size, a per-capture salted hash, and the few values a stream profile asked to extract (sequence, timestamp, partition, heartbeat flag) |
| `violation` | something the SSE specification ignores or drops, with a severity that follows the specification |
| `phase`, `reconnect` | connection state changes; each reconnect with the id sent and the delay waited |
| `heartbeatSeries`, `truncated` | what the recorder folded or dropped to stay within its memory cap. Nothing is dropped silently |
| `consumer` | page-side samples of how long events waited between arriving and being processed |

Event records carry metadata, not payload text. Rules read the extracted values, never raw payloads. `extracted.shape` is the structure of a JSON payload: field paths and kinds, sorted, such as `$:o|id:n|price:n` (never a value). It is kept as it is when a capture is redacted, because a field named `password` is a name and not a secret. Payload text exists only where a capture keeps the wire bytes, or (for an imported v1 recording) in the event's `data`.

## Two kinds of capture

| | `local-full` | `sanitized` |
|---|---|---|
| Wire bytes | Base64 in each `chunk` (byte-exact) | not kept; redacted text per chunk instead |
| May contain secrets | yes | no (see below) |
| Shared | never | yes, only through `redactCapture()` |
| Replay | byte-for-byte | event-level, timing-faithful (chunk sizes and timing are kept as metadata) |

The type system enforces the split: reports, shared exports and generated scenarios accept only a `RedactedCapture`, a type that `redactCapture()` alone can produce.

## Redaction

- **Placeholders, not hashes.** A secret becomes `[REDACTED_1]`, `[REDACTED_2]`, ... Equal secrets in one export share a placeholder, so equality survives. Nothing in a placeholder is derived from the secret: no hash prefix and no length-preserving mask, since both leak information.
- **Over the whole stream.** Each connection's bytes are decoded and redacted as one string, then cut back at the original chunk boundaries. A secret split across two network reads is found. Chunk records keep their original byte counts.
- **What is recognised.** JWTs, `Bearer` and `Basic` credentials, cloud and API key formats (AWS, GitHub, Slack, Stripe, Google), private key blocks, credentials inside URLs, and the values of keys named like `password`, `token`, `secret`, `api_key`, `authorization`, `cookie`, `session` in JSON or `name=value` text. Request header values are dropped unless the header is on a short safe list; cookies always.
- **Event ids** stay readable so sequences can be analysed, unless an id is itself a credential.
- **After redaction** the result is re-parsed and must contain the same events with the same names. If it does not, nothing is produced.
- **Residual scan.** A second pass reports anything that still looks secret (for example a long random token that matches no known format). It reports where, never the value. Sharing should wait until a person has looked.
- **Your own rules.** A [redaction policy](/guide/redaction-policy) adds key names, patterns and kept headers. A capture redacted with one carries `redaction.policy: "custom"` in its header (otherwise `"default"`), and the rule names appear in `redaction.applied`. A policy can only add to redaction; it cannot turn a built-in rule off or keep a header that carries credentials.
- **Limits.** Redaction recognises shapes, not meaning. An ordinary-looking value that happens to be secret (a customer name, a random order id) is not found; the residual scan can only hint.

## Importing old recordings

`.sse-record` v1.0 files (the viewer's earlier export) import as captures. A v1 recording kept only parsed events and the gap since the previous one, so the timeline is rebuilt from those gaps and marked synthetic. It has no chunks, comments, response headers or reconnects, so rules that need them report **not evaluated** instead of looking healthy. The SSE event name is the recording's `type`; `parsedType` is a value found inside a JSON payload, not an SSE field. The server's own event id is `sseId` (absent when the server sent none, and then the capture's `sseId` is empty); the recording's `id` is the viewer's internal storage uuid, is not imported and is never replayed as an SSE `id:`. What a replay sends for a v1 recording, and what it cannot know, is in [Mock server](/guide/mock-server).
