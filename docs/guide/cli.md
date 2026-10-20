# Command line: `sse-doctor`

`sse-doctor` runs the same diagnostics as the app, from a terminal or a CI job. It is built from this repository (`npm run build:cli`, then `npm run doctor -- <command>`); it is not published to npm yet.

```bash
npm run build:cli
npm run doctor -- probe https://api.example.com/stream --duration 20 --out stream.sse-capture
npm run doctor -- analyze stream.sse-capture
```

## Commands

| Command | What it does |
|---|---|
| `probe <url>` | Connects, watches the stream, prints the findings. `--duration <s>` (default 30), `--max-events <n>`, `--idle-timeout <s>` decide when to stop. `--out <file>` saves the capture. |
| `analyze <capture>` | Analyzes a saved capture (`.sse-capture`, or an old `.sse-record`). |
| `report <capture>` | Writes a shareable report: `--format md` (default), `html` (one self-contained file) or `json`. `--output <file>`. |
| `compare <a> <b>` | Compares two captures: status, headers, timing, heartbeat rhythm, chunk sizes, events. |
| `curl <capture\|url>` | Prints a curl command that reproduces the request. Header and query values become environment variables. |
| `redact <capture>` | Writes a copy that is safe to share: `--output <file>`. |
| `test <scenario.json>...` | Runs [scenario files](/guide/cli-ci). |
| `replay <capture>`, `fixtures list|serve` | Serve a capture or the built-in streams locally ([details](/guide/cli-ci)). |
| `selftest` | Checks that this build works: each rule against a stream that should and one that should not trigger it, plus redaction. |

Options for every command: `--format human|json|md|junit`, `--fail-on info|warning|error|critical` (default `error`), `--profile <file.json>`, `--quiet`, `--verbose`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | passed |
| 1 | an open finding at or above `--fail-on` |
| 2 | wrong usage, or an input that is not a capture |
| 3 | could not run (file unreadable, connection failed without a diagnosis) |
| 4 | inconclusive: no check failed, but a scenario check could not be decided |
| 130 | interrupted |

## Secrets

Put secrets in environment variables, never on the command line (where they end up in shell history and process lists):

```bash
export STREAM_TOKEN=...
sse-doctor probe https://api.example.com/stream --auth-env STREAM_TOKEN
sse-doctor probe https://api.example.com/stream --header-env X-Api-Key=API_KEY --query-env ticket=TICKET
```

- `--auth-env VAR` sends `Authorization: Bearer $VAR`; `--header-env Name=VAR`, `--cookie-env VAR` and `--query-env param=VAR` do the same for a header, a cookie and a query parameter. A literal `--header "Name: value"` works but warns.
- Every value the tool resolves is registered, and every output (screen, errors, files) is scrubbed of it, including URL-encoded and Base64 forms. Values shorter than 4 characters cannot be scrubbed safely and trigger a warning.
- `probe --out` writes a **redacted** capture, so secrets never reach the disk. `--no-redact` writes the raw capture (with the wire bytes, for byte-exact replay) and warns; do not share it.
- `report` and `curl` accept only a redacted capture. Give them one made by `redact`, or add `--redact`.

## Stream profile

A profile tells the tool what the stream promises. Continuity checks (gaps, duplicates, skipped events on resume) run only when a sequence is declared, because ids that merely look sequential prove nothing.

```json
{ "sequence": { "useSseId": true, "policy": "consecutive" }, "delivery": "at_least_once", "expected": { "heartbeatMs": 15000 } }
```

See [Diagnostics](/technical/diagnostics) for the rules, and [Capture format](/technical/capture-format) for the files. This build runs on Node 20 or newer; Node's fetch decodes compressed responses itself and chunks reads differently from a browser, and captures record which client produced them.
