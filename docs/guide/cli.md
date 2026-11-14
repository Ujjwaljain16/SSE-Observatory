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
| `report <capture>` | Writes a shareable report: `--format md` (default), `html` (one self-contained file), `json`, or `issue` (a short body for a ticket or pull request comment, see [Team reports](#team-reports)). `--output <file>`. |
| `compare <a> <b>` | Compares two captures: status, headers, timing, heartbeat rhythm, chunk sizes, events. |
| `validate <capture> <url>` | Did the fix work? Reads the fixed stream the way the capture was read and says whether the capture's finding is gone ([details](#checking-a-fix)). |
| `env-diff <urlA> <urlB>` | Reads the same stream through two paths at the same time and says where its behaviour differs ([details](#comparing-two-environments)). |
| `curl <capture\|url>` | Prints a curl command that reproduces the request. Header and query values become environment variables. `--shell posix\|powershell` picks the quoting. |
| `repro <capture>` | Shrinks a capture to the smallest one that still reports a finding (`--finding <key>`, default the most severe), writes it redacted to `--output`, and can also write a matching scenario (`--scenario`) and a test template (`--test`). Stops after 3000 analyses and says if the result may not be minimal. |
| `redact <capture>` | Writes a copy that is safe to share: `--output <file>`. |
| `test <scenario.json>...` | Runs [scenario files](/guide/cli-ci). |
| `replay <capture>`, `fixtures list|serve` | Serve a capture or the built-in streams locally ([details](/guide/cli-ci)). |
| `selftest` | Checks that this build works: each rule against a stream that should and one that should not trigger it, plus redaction. |

Options for every command: `--format human|json|md|junit`, `--fail-on info|warning|error|critical` (default `error`), `--profile <file.json>`, `--quiet`, `--verbose`.

A full (not redacted) capture served by `replay` is not readable by web pages unless you pass `--allow-origin <page origin>` (the app's proxy and `curl` work without it); a redacted capture keeps the open policy.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | passed |
| 1 | an open finding at or above `--fail-on` |
| 2 | wrong usage, or an input that is not a capture |
| 3 | could not run (file unreadable, or the server never answered: a probe that got no response exits 3 whatever `--fail-on` says) |
| 4 | inconclusive: no check failed, but a scenario check could not be decided |
| 130 | interrupted |

## JSON output

`--format json` prints a document a script can read, and its shape is a published contract:

- `analyze`, `probe`, `compare` and the other commands that report findings print [`sse-cli-output-1.json`](/schemas/sse-cli-output-1.json): `schemaVersion`, `command`, `subject`, `findings` (each with its `facts`, `deductions`, `limits` and `status`), `coverage` (one entry per check, `evaluated` or `not-evaluated`) and `notes`.
- `test` prints [`sse-test-output-1.json`](/schemas/sse-test-output-1.json): one entry per scenario file with its `status` (`pass`, `fail` or `inconclusive`) and its `checks`.

Within version 1 fields may be added; a field is never removed, and its meaning never changed, without a new `schemaVersion` and a new file. The tests validate what the real commands print against these files.

## Secrets

Put secrets in environment variables, never on the command line (where they end up in shell history and process lists):

```bash
export STREAM_TOKEN=...
sse-doctor probe https://api.example.com/stream --auth-env STREAM_TOKEN
sse-doctor probe https://api.example.com/stream --header-env X-Api-Key=API_KEY --query-env ticket=TICKET
```

- `--auth-env VAR` sends `Authorization: Bearer $VAR`; `--header-env Name=VAR`, `--cookie-env VAR` and `--query-env param=VAR` do the same for a header, a cookie and a query parameter. A literal `--header "Name: value"` works but warns.
- Every value the tool resolves is registered, and every output (screen, errors, files) is scrubbed of it, including URL-encoded and Base64 forms. Values shorter than 4 characters cannot be scrubbed safely and trigger a warning.
- `probe --out` writes a **redacted** capture, so secrets never reach the disk. `--no-redact` writes the raw capture (with the wire bytes, for byte-exact replay) and warns; do not share it. The secrets you gave the command are replaced in its text fields, but the wire bytes are kept exactly as they were (a scrub of base64 would leave a file that cannot be read back), so what a server echoed back may be in them.
- `report` and `curl` accept only a redacted capture. Give them one made by `redact`, or add `--redact`.
- `--redact-policy <file.json>` adds your own rules to the built-in ones for `redact`, `report`, `curl`, `repro` and `probe --out`: more payload key names, more patterns, and request headers whose value may stay. See [Redaction policy](/guide/redaction-policy). A policy with any problem stops the command with exit code 2 and a list of every problem, and nothing is written.

## Comparing two environments

`env-diff` is for "it works here and not there": the origin and the CDN, staging and production, a stream before and after a proxy change.

```sh
sse-doctor env-diff https://origin.example.com/stream https://www.example.com/stream \
  --label-a origin --label-b edge --duration 30 --out-a origin.sse-capture --out-b edge.sse-capture
```

- **Both are read at the same time**, with the same settings, so they see the same stretch of the stream and not two moments apart. `--duration`, `--max-events`, `--profile` and the rest of the [probe options](#commands) apply to both.
- **Credentials per side.** `--auth-env`, `--cookie-env`, `--header-env` and `--query-env` apply to both; add `-a` or `-b` (`--auth-env-b TOKEN_B`) to give one side its own, because two environments rarely share a token. Every value is scrubbed from all output, as for `probe`.
- **The result is the comparison** that `sse-doctor compare` gives for two saved captures: status, headers, timing, heartbeat rhythm, chunk sizes, events. Each difference is a measurement; `Likely:` lines are guesses with their alternatives. It never names a layer, because two readings cannot say which hop caused a difference. Each side's own findings are listed in the notes, so "B alone is buffering" and "both are failing" read differently.
- **`--out-a` and `--out-b`** save each capture, redacted, so the pair can be compared again later with `sse-doctor compare`, or one of them analysed, reported or shrunk.
- **Exit codes.** `--fail-on` (default `error`) gates on the *differences*; use `--fail-on warning` to fail when the two behave differently at all. A side that never answers is exit 3 (could not run), whatever the gate says. Ctrl+C reports what was seen and exits 130. `env-diff` answers "do they behave the same?"; to ask whether either is healthy, `probe` each.

## Checking a fix

You captured a bug, someone fixed the producer, and you want to know whether it worked. `validate` takes the capture and the URL of the fixed stream:

```sh
sse-doctor validate bug.sse-capture https://staging.example.com/stream --finding stall.silent:events
```

It confirms the capture reports that finding (it picks the most serious one if you name none), reads the stream with the capture's own profile (so a declared sequence is still judged), for at least as long as the capture lasted and 30 s (`--duration` changes it; credentials are given as for `probe`), and says one of:

| Exit | Verdict | Meaning |
|---|---|---|
| 0 | **Fixed**, as far as this reading shows | the finding is not reported, and the check that raises it ran |
| 1 | **Not fixed** | the same finding is reported again |
| 4 | **Inconclusive** | it is not reported, but the check could not run on this reading (a stall needs events to judge a silence in), or the stream was read under a different profile than the capture, so its absence does not show the fix worked |
| 3 | could not run | the stream never answered |
| 2 | usage | the capture does not report the finding asked about, or reports none |

The profile guard matters: a check that needs a declared sequence cannot run without one, and its silence would otherwise look like a fix. Other findings the reading raises are listed, not judged. One reading is not proof, since a fault that comes and goes can be missing from it. When the verdict is fixed, `sse-doctor repro <capture> --scenario <file>` turns the capture into a [scenario](/guide/cli-ci) that fails if the problem comes back.

## Team reports

`sse-doctor report <capture> --format issue` writes a body to paste into a ticket or a pull request comment, for someone who has not seen the capture:

- the verdict in one line (`Stream check: 2 findings, worst error`) and the request it is about;
- a table of the findings, worst first;
- what was observed for the worst three, with the `Likely:` deduction, its alternatives and the next check;
- how to reproduce: attach the redacted capture and run `sse-doctor analyze`, or repeat the request with the listed environment variables;
- the full report folded away in a `<details>` block (cut, with a note, if it would pass the 65,536 characters an issue or comment may hold).

It ends with a hidden marker (`<!-- sse-doctor:report -->`) so a tool that updates a comment in place can find its own. Nothing is posted anywhere: the text is made, and you paste it. Like every report, it takes only a redacted capture and escapes anything that came from the stream. The app's Export dialog has the same thing as **For an issue or pull request**.

For scenario runs in CI, `sse-doctor test --summary <file.md>` always writes a Markdown summary, whatever `--format` is. The [composite action](/guide/cli-ci#in-ci) uses it for the job summary and, if you ask, a pull request comment.

## Stream profile

A profile file is checked before it is used: an unknown field, a sequence without a policy, a path that is not a JSON path, or a delivery name that does not exist stops the command with exit code 2 and a list of every problem. The app's Doctor has a form for the same file (see [Stream Doctor](/guide/stream-doctor)).

A profile tells the tool what the stream promises. Continuity checks (gaps, duplicates, skipped events on resume) run only when a sequence is declared, because ids that merely look sequential prove nothing.

```json
{ "sequence": { "useSseId": true, "policy": "consecutive" }, "delivery": "at_least_once", "expected": { "heartbeatMs": 15000 } }
```

A profile may also carry a `display` mapping (`type`, `summary` and `id` JSON paths) for the app's event list. The command line checks it like the rest of the file and otherwise ignores it: no check depends on how events are shown.

See [Diagnostics](/technical/diagnostics) for the rules, and [Capture format](/technical/capture-format) for the files. This build runs on Node 20 or newer; Node's fetch decodes compressed responses itself and chunks reads differently from a browser, and captures record which client produced them.
