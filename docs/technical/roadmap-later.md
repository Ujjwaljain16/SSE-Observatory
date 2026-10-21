# Later track

What v2 deliberately does not do, and the places it was built to grow. None of this is promised for a date; it is
written down so that the choices in v2 make sense and so that the extension points are not a surprise.

## What v2 is

A way to find out **why** a stream is stuck, late or losing events, to **prove it with evidence**, and to turn the
diagnosis into a **regression test**. It reads one stream (or one lane at a time), from the browser or from Node, and it
says what it measured separately from what it deduces. See [Diagnostics](/technical/diagnostics).

## Not in v2

| Left out | Why |
|---|---|
| A public `fault-proxy` command and general fault injection | The fixtures and the `replay` test aids (`--honor-last-event-id`, `--drop-after`, `--skip-ids`) prove the rules. A fault proxy is a product of its own. |
| `env-diff` and live multi-environment probing | v2 compares two **saved** captures. Probing several environments at once needs a design for credentials and for what "the same request" means. |
| Naming the layer that caused a problem from one browser capture | A browser sees that bytes stopped arriving, not which hop stopped them. Findings say "likely" and list the alternatives. |
| Gap detection on opaque ids | Ids that merely look sequential prove nothing; only a declared sequence is judged. |
| AI explanations | Findings must first be reproducible, evidence-backed and identical across the browser, the CLI and tests. |
| A browser extension, a server SDK, OpenTelemetry export, event lineage, a synthetic monitoring service | See below. |
| Per-stream profiles, a heartbeat predicate in the profile | One profile applies to every stream in a browser. The recorder can already read a heartbeat predicate, but no rule uses it yet, so offering one would promise something the checks do not do. |
| Bookmarks inside exported files | The format has no record for them yet; they stay with the recording in the browser. |
| npm publishing of `sse-doctor` | Built to be publishable, not published. See [Publishing](/technical/publishing). |

## Extension points

- **Fault laboratory and environment comparison.** The `replay` test aids and the scenario `target` shape are the
  extension points. A fault-proxy rule schema and `env-diff` can be added without changing the capture format. For faults
  below HTTP (packet loss, TLS), use an external tool such as toxiproxy or `tc netem` in front of a fixture.
- **Server SDK.** The observation record is the wire contract. A server could emit `: sse-obs {json}` comments (the same
  family as the proxy's `: sse-proxy` tags) or an `X-SSE-Obs` header; the record kinds `server-emit` and `queue-depth` are
  reserved, and the header's `sources[]` and a clock-skew field would let a client capture and a server capture be merged.
- **OpenTelemetry.** A documented mapping from observations to spans and events. `traceparent` is already preserved in
  captures; an adapter folder is reserved.
- **Lineage.** An optional `correlationId` on event records and a profile `lineageField`.
- **Synthetic monitoring.** `test`, scenario files, the versioned JSON and JUnit output and the exit codes are the unit of
  a monitor; a scheduler comes later. `compare` against a stored baseline is the regression primitive.
- **An AI explainer.** An `Explainer` taking a redacted capture and the finding set and returning narrative marked as AI
  output. It would not be able to change a severity, a confidence or the evidence, would treat stream payloads as untrusted
  input, and the CLI keeps `--explain` reserved for it.
- **More rules.** A rule is a small object with a `requires` list, a `create()` that returns an instance, and a failing
  fixture with a silent healthy twin. The rule that reads a heartbeat predicate, and rules over the producer timestamp, are the next candidates.
