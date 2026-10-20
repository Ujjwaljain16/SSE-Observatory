# Scenarios and CI

A scenario is a JSON file that says what a stream must do, and `sse-doctor test` runs it and exits with a verdict a CI job can act on. The format is described by a published schema, so editors complete and check it: `https://sse-observatory.vercel.app/docs/schemas/sse-scenario-1.json`.

```json
{
  "$schema": "https://sse-observatory.vercel.app/docs/schemas/sse-scenario-1.json",
  "version": 1,
  "name": "orders stream resumes after a dropped connection",
  "target": {
    "url": "${ENV:STREAM_URL}",
    "headers": { "Authorization": "${ENV:STREAM_AUTHORIZATION}" },
    "sequence": { "field": "$.seq", "policy": "consecutive" },
    "delivery": "at_least_once"
  },
  "expect": { "status": 200, "content_type": "text/event-stream", "first_event_within_ms": 3000 },
  "steps": [
    { "collect_events": 20, "timeout_ms": 20000 },
    { "disconnect": { "mode": "client" } },
    { "reconnect": { "after_ms": 500, "resume_from_last_event_id": true } },
    { "collect_events": 20, "timeout_ms": 20000 }
  ],
  "verify": ["no_unexplained_sequence_gaps", "no_unexpected_duplicates", "preserve_event_order"],
  "fail_on_severity": "error"
}
```

## Targets

| `target` | Runs against |
|---|---|
| `url` with `${ENV:NAME}` or an `https://` address | a live stream |
| `url: "fixture://f06-skips?scale=0.05"` | a built-in faulty or healthy stream, started in-process (`sse-doctor fixtures list`) |
| `replay: { "capture": "file.sse-capture", "honor_last_event_id": true, "test_aids": { "skip_ids": ["6"], "drop_after": 3 } }` | a saved capture served from this process, so the scenario needs no live server |

Secrets enter only through `${ENV:NAME}`. A literal token, key or password in a scenario is rejected (exit 2), and every value taken from the environment is scrubbed from all output.

## Steps

- `collect_events` waits for that many events, or fails at `timeout_ms`.
- `disconnect` with `mode: "client"` closes the connection; with `mode: "server"` waits for the server (a fixture or a replay with `drop_after`) to drop it.
- `reconnect` waits `after_ms`, then connects again; `resume_from_last_event_id: false` forgets the cursor first.
- `wait` pauses.

## Checks and the three outcomes

| Check | Needs |
|---|---|
| `no_unexplained_sequence_gaps` | `target.sequence` declared |
| `no_unexpected_duplicates` | `target.sequence`; with `exactly_once` delivery a replay after a reconnect also counts |
| `preserve_event_order` | `target.sequence` |
| `{ "no_findings_at_or_above": "warning" }` | nothing |

`expect` checks the status, the content type and the time to the first event. `fail_on_severity` (default `error`) fails the scenario on any open finding that severe.

**A sequence check on a stream that declares no sequence is inconclusive, not a pass**: ids that look sequential prove nothing, so the tool will not claim there was no loss. Inconclusive exits 4 unless you pass `--allow-inconclusive`.

| Exit | Meaning |
|---|---|
| 0 | every scenario passed |
| 1 | a check failed |
| 2 | the scenario file is invalid, names an unset variable, or contains a literal secret |
| 3 | could not run |
| 4 | no check failed, but at least one could not be decided |

## In CI

This repository runs its own scenarios (`scenarios/ci`) against the fixtures: the passing ones must pass, the failing ones must fail, the unprovable ones must be inconclusive, and the JUnit result is uploaded as an artifact (`npm run doctor:scenarios`).

For your own stream, with the composite action in this repository:

```yaml
- uses: Ujjwaljain16/SSE-Observatory@v2
  env:
    STREAM_URL: ${{ secrets.STREAM_URL }}
    STREAM_AUTHORIZATION: ${{ secrets.STREAM_AUTHORIZATION }}
  with:
    scenarios: scenarios/orders.json
    format: junit
    output: results.xml
```

or by hand, which works without the action:

```yaml
- run: git clone --depth 1 https://github.com/Ujjwaljain16/SSE-Observatory.git sse-observatory
- run: cd sse-observatory && npm ci --ignore-scripts && npm run build:cli
- run: node sse-observatory/dist-cli/bin/sse-doctor.mjs test scenarios/orders.json --format junit --output results.xml
  env:
    STREAM_URL: ${{ secrets.STREAM_URL }}
```

The tool is not published to npm yet; building it from the repository is the supported path.

## Other commands

- `sse-doctor replay <capture>` serves a capture as a local SSE endpoint (`--port`, `--speed`, `--honor-last-event-id`, `--drop-after n`, `--skip-ids a,b`, `--end close|hold|rst|end-event`), to point a client or a test at recorded behaviour.
- `sse-doctor fixtures list` and `fixtures serve` expose the built-in streams.

Not built yet: minimizing a capture to the smallest one that still shows a finding (`repro`).
