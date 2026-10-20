# Diagnostics: rules, evidence and limits

The diagnostics engine reads a capture (see [Capture format](/technical/capture-format)) and reports **findings**. It follows three rules so that a guess is never mistaken for a measurement.

- **Facts and deductions are kept apart.** A fact is something measured, with the records that show it. A deduction always reads "Likely: ..." with a confidence and the other explanations that fit the same facts.
- **"Not evaluated" is never "healthy".** A rule that needs something the capture does not have (response headers hidden by CORS, no chunk records, no declared sequence) says so in the coverage list instead of staying quiet.
- **The same answer everywhere.** Analysing a capture offline gives exactly what the live panel showed. Time-based checks run on the capture's own clock, never the wall clock.

A browser can see that events stopped arriving. It cannot see which layer stopped them. Findings say what was observed, what is likely, and what would tell the possibilities apart.

## Sequence contracts

Numbers that merely look sequential prove nothing: a server may legitimately send 104 and then 111. Gap and duplicate checks therefore need a **declared contract** in the stream profile:

```json
{ "sequence": { "field": "$.seq", "policy": "consecutive", "partitionBy": "$.tenant" }, "delivery": "at_least_once" }
```

Use `"useSseId": true` instead of `field` when the SSE `id:` is the sequence. `consecutive` means every step is +1 and a gap is loss. `monotonic` allows gaps; only repeats and going backwards are findings. `delivery` decides whether a replay after a reconnect is expected (at least once) or a problem.

Without a contract the checks do not run. The coverage list says continuity could not be verified, and notes when ids happen to count up so you can declare them. An event that sets no `id:` of its own (a closing `event: end`) inherits the previous id and is not counted as a repeat.

## The rules

| Rule | Finds | Needs |
|---|---|---|
| R01 `proto.content-type`, `http.status` | wrong media type or a non-200 status (errors); odd charset or redirect (not errors) | response |
| R02 `proto.framing` | what the SSE specification ignores or drops, one finding per kind with counts; severity follows the specification | violations |
| R03 `proto.headers-hints` | headers that can cause buffering (content encoding, missing `Cache-Control: no-cache`) | response headers |
| R04 `timing.first-event` | slow first byte or first event, split into connect, headers, first byte, first event | response |
| R05 `stall.silent` | silence on three clocks: any byte, origin byte, complete event; a stall is judged against the stream's own rhythm | events |
| R06 `delivery.bursty` | events arriving in tight clusters with quiet gaps (a hypothesis of buffering, never a certainty) | events, chunks |
| R07 `reconnect.loop`, `reconnect.duration-pattern` | rapid reconnect loops; connections that all last the same time (a cap or idle timeout) | reconnects |
| R08 `resume.last-event-id` | `Last-Event-ID` not sent, ignored, replayed, ids regenerated per connection, and (with a contract) a resume that skipped events | events, reconnects |
| R09 `seq.integrity` | gaps, duplicates, conflicts (same number, different data), numbers going backwards, late arrivals; only under a declared contract | events |
| R10 `heartbeat.recognition` | heartbeat source (proxy or origin) and rhythm; a late heartbeat | comments |
| R11 `consumer.slow`, `consumer.queue-overflow` | the page processing events late, or dropping them; "receipt healthy, processing late" | page consumer records |
| R12 `security.credentials-in-metadata` | credential-like names in the request URL; never prints a value | connect |
| R13 `proxy.masking`, `proxy.upstream-mismatch` | the proxy alive while the upstream is silent; status or content type differing from what the proxy reported | proxy tags |
| R15 `clock.discontinuity` | a clock jump (a laptop woke up); silences that span it are not judged | |

R14 compares two captures instead of reading one: `compareCaptures` aligns events (by id, then payload text, then sequence number) and compares status, headers, time to first byte, heartbeat cadence, chunk sizes and delivery latency. If a layer between the two captures buffers, it says "Likely: a layer between A and B buffers", never which layer.

## Confidence

| Confidence | Meaning |
|---|---|
| high | several independent signals agree, or a comparison isolates the cause |
| medium | one clear signal with a plausible, named alternative |
| low | consistent with the facts, other explanations are as likely |

A deduction is only upgraded by comparative evidence: another capture, a bypassed layer, a server-side log.

## Honest limits

- Chunk sizes show how bytes reached the client, not what any layer did to them. Node and browsers chunk differently; captures record which client produced them.
- Silence is only called a stall relative to the stream's own rhythm. With no known cadence the rule waits 30 s and says it cannot tell a stall from legitimate idle.
- A cross-origin browser sees only CORS-safelisted response headers, so rules that need others report "not evaluated". Same-origin proxy diagnostics headers are visible.
- The worker-to-page hop is approximate in consumer-lag measurements.
- Rules never read raw payload text. They read the few values a stream profile asks the recorder to extract (sequence, timestamp, partition, heartbeat flag).
