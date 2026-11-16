# Command line: `sse-doctor`

`sse-doctor` runs the same diagnostics as the app, from a terminal or a CI job. It is published to npm as [`sse-doctor`](https://www.npmjs.com/package/sse-doctor) (Node 20 or newer, no dependencies), so `npx sse-doctor <command>` works anywhere; from a checkout of this repository, `npm run build:cli` and then `npm run doctor -- <command>` run the same code.

```bash
npm run build:cli
npm run doctor -- probe https://api.example.com/stream --duration 20 --out stream.sse-capture
npm run doctor -- analyze stream.sse-capture
```

## Commands

| Command | What it does |
|---|---|
| `probe <url>` | Connects, watches the stream, prints the findings. `--duration <s>` (default 30), `--max-events <n>`, `--idle-timeout <s>` decide when to stop. `--out <file>` saves the capture. `--follow-redirects` follows a redirect to another origin although credentials are attached (without it that redirect is refused; [details](#redirects-to-another-origin)). |
| `analyze <capture>` | Analyzes a saved capture (`.sse-capture`, or an old `.sse-record`). |
| `report <capture>` | Writes a shareable report: `--format md` (default), `html` (one self-contained file), `json`, or `issue` (a short body for a ticket or pull request comment, see [Team reports](#team-reports)). `--output <file>`. |
| `compare <a> <b>` | Compares two captures: status, headers, timing, heartbeat rhythm, chunk sizes, events. |
| `validate <capture> <url>` | Did the fix work? Reads the fixed stream the way the capture was read and says whether the capture's finding is gone ([details](#checking-a-fix)). |
| `env-diff <urlA> <urlB>` | Reads the same stream through two paths at the same time and says where its behaviour differs ([details](#comparing-two-environments)). |
| `curl <capture\|url>` | Prints a curl command that reproduces the request. Header and query values become environment variables. `--shell posix\|powershell` picks the quoting. For a capture exported from the app that went through its server proxy the address was not recorded, so the command reads `"$STREAM_URL"` and a comment says to set it. |
| `repro <capture>` | Shrinks a capture to the smallest one that still reports a finding (`--finding <key>`, default the most severe), writes it redacted to `--output`, and can also write a matching scenario (`--scenario`, made from the whole capture you gave, not from the shrunken one: the scenario keeps all its events, its response and, for a stall, its silence limit) and a test template (`--test`). Stops after 3000 analyses and says if the result may not be minimal. |
| `redact <capture>` | Writes a copy that is safe to share: `--output <file>`. |
| `test <scenario.json>...` | Runs [scenario files](/guide/cli-ci). |
| `replay <capture>`, `fixtures list|serve` | Serve a capture or the built-in streams locally ([details](/guide/cli-ci)). A capture without payload, such as the app's export, is replayed as a labelled [synthetic replay](#replaying-a-capture-from-the-app-a-synthetic-replay). |
| `selftest` | Checks that this build works: each rule against a stream that should and one that should not trigger it, plus redaction. |

Options for every command: `--format human|json|md|junit`, `--fail-on info|warning|error|critical` (default `error`), `--profile <file.json>`, `--quiet`, `--verbose`.

A full (not redacted) capture served by `replay` is not readable by web pages unless you pass `--allow-origin <page origin>` (the app's proxy and `curl` work without it); a redacted capture keeps the open policy.

### Replaying a capture from the app (a synthetic replay)

A capture that holds the stream's bytes or text (one from `probe --out`, redacted or not) is replayed **exactly** as it was recorded. The **capture to share** that the app exports is different: the app records what happened on the wire (times, sizes, ids, event names, reconnects), not what the events said, so the file has no payload. `sse-doctor replay` replays it anyway, as a **synthetic replay, not a byte-exact one**:

- it builds a copy **in memory** (the same function as the app's **Replay in Mock mode** button), so the file is never changed and nothing is written;
- every event keeps its **id, event name, order and time** from the capture, so a gap, a stall or a resume from the wrong id plays back as it was recorded;
- every body is a **placeholder of the recorded size** (valid JSON, carrying only the numbers your profile reads). An event with no recorded size gets the smallest valid body (`{}`), and the notice says how many;
- comments, heartbeats and how the bytes were split into reads are **not** replayed;
- it says so: a `note: SYNTHETIC replay, not byte-exact...` line on stderr, the same words on the line with the address, and an `X-Mock-Synthetic: placeholder-bodies` response header. A replay of a capture that holds payload has none of these.

A capture with no events, no recorded event sizes, or sizes too large to build bodies from (together more than 16 MB), and a file that is damaged, is refused with exit code 2 and the reason. `replay` prints no JSON, so the output schemas are unchanged. A scenario whose `replay.capture` is such a capture (see [CI](/guide/cli-ci)) is still refused.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | passed |
| 1 | an open finding at or above `--fail-on` |
| 2 | wrong usage, or an input that is not a capture, or a capture whose records are invalid (see below); also `--no-redact` together with a secret option ([why](#no-redact-and-secrets)) |
| 3 | could not run (file unreadable, or the server never answered: a probe that got no response exits 3 whatever `--fail-on` says; or a redirect to another origin was refused because credentials are attached, [see](#redirects-to-another-origin)) |
| 4 | inconclusive: no check failed, but a scenario check could not be decided |
| 130 | interrupted |

### A capture whose records are invalid

`analyze`, `report`, `redact`, `compare`, `repro`, `curl`, `validate` and `replay` refuse a capture that repeats a `seq`, has a `seq` that goes down, or has a `t` that goes backwards (equal times are fine). They exit **2**, write nothing to stdout (so no JSON document, whatever `--format` says: there are no findings to report, and the schema describes findings), and print the problem to stderr, with the seq and the line of the first offending records:

```
"capture.sse-capture": Invalid capture: 1 problem in its records.
  - seq 12 is used twice: line 15 repeats the seq of line 14.
A capture needs a distinct, increasing seq on every record ... It was not analysed, so nothing can be said about the stream from it. Fix or re-record the capture.
```

Five problems are listed, then "and N more". The same words appear when the Doctor refuses to open the file. The rules are in [Capture format](/technical/capture-format).

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
- `probe --out` writes a **redacted** capture, so secrets never reach the disk. `--no-redact` is the exception, and it is refused when you gave the command any secret (see [`--no-redact`](#no-redact-and-secrets)).
- `report` and `curl` accept only a redacted capture. Give them one made by `redact`, or add `--redact`.
- `--redact-policy <file.json>` adds your own rules to the built-in ones for `redact`, `report`, `curl`, `repro` and `probe --out`: more payload key names, more patterns, and request headers whose value may stay. See [Redaction policy](/guide/redaction-policy). A policy with any problem stops the command with exit code 2 and a list of every problem, and nothing is written.

### What counts as a secret option

Two rules below depend on it, and it is one list: every way a command can be given a secret, which is also everything the scrub is fed from.

- `--auth-env`, `--cookie-env`, `--header-env Name=VAR`, `--query-env param=VAR`, and a literal `--header "Name: value"` (the value of every `--header` is registered, whatever its name);
- for `env-diff`, the per-side forms (`--auth-env-a`, `--header-env-b`, ...);
- credentials in the URL (`user:password@host`);
- a query value in the URL whose parameter name says it is a secret (`token`, `api_key`, `password`, `secret`, ...) or whose shape does (12 characters or more, letters and digits mixed, not a date). `?scale=0.05` or `?debug=true` is not a secret and changes nothing.

Messages name these options (and the header or parameter name you typed after them), never a value, and never a query parameter typed in the URL, because a name can itself be the token. `${ENV:NAME}` values in a scenario file for `sse-doctor test` are registered and scrubbed the same way, but the two rules below do not apply to `test` yet (see the last point of [Redirects](#redirects-to-another-origin)).

### What the scrub covers, and what it does not

Every secret from the list above is registered once, and everything the command line prints or writes (screen, errors, files) is scrubbed of it by value, wherever it appears. **Exactly** these forms of a registered value are replaced:

- as given (raw);
- percent-encoded with `encodeURIComponent` (upper-case hex, a space as `%20`), and the same with lower-case hex (`%2f`);
- base64, with and without `=` padding, and base64url (`-` and `_`, no padding);
- as it is written inside a JSON string (`JSON.stringify`: `"` and `\` and control characters escaped; non-ASCII characters and `/` are **not** escaped, so they stay as they are);
- the value behind a scheme: when the registered value is `Bearer TOKEN` (also `Basic`, `Token`, `Digest`, `ApiKey`), `TOKEN` alone is a secret too.

How values get in: an environment variable's value as a whole; a literal `--header` value; the URL's user name and password (percent-decoded first); each query value of the URL that is secret by name or shape (above). Values shorter than 4 characters are not registered (replacing two characters would damage unrelated text); the command warns and cannot scrub them. A value that contains another is replaced whole; the longest goes first.

**Known unsupported encodings.** A registered secret that comes back in one of these forms is **not** removed (each is pinned in `src/cli/__tests__/security.encodings.test.ts`, with a test of what we would want, expected to fail until the form is supported):

- hexadecimal, lower or upper case;
- form encoding: a space written as `+` (`URLSearchParams`, HTML forms, Python `urlencode`), and `! ' ( ) * ~` written as `%XX`;
- JSON with `\uXXXX` escapes for non-ASCII characters (Python `json.dumps` default) or for an astral character as a surrogate pair; PHP's escaped slash `\/`; Go's `< > &` for `< > &`;
- HTML entities (`&amp;`, `&quot;`, `&lt;`);
- percent-encoded twice (a gateway that re-encodes the target it forwards);
- the secret inside a larger base64 value at an offset that is not a multiple of 3, such as base64 of `user:secret` (a Basic header built by hand);
- a secret split over two writes (each write is scrubbed on its own), and two secrets that overlap without one containing the other (the part outside the overlap of the shorter stays).

**Detection is not complete, and this page does not claim it is.** The scrub knows the values it was given and these encodings; it does not know a secret that was not given to it, and it cannot recognise a transformation it was not told about. So: do not paste a secret into a place the tool does not know about (a literal in a URL path, a scenario file, a `--header` you are about to share), give secrets only through the options above, and read a capture before you share it. A redacted capture also applies the built-in redaction rules (by field name and by shape) and `--redact-policy`, and reports a token-like value it kept; that is a second layer, not a guarantee either. Event ids that look like a random token are reported on stderr as **one** line with a count and the first event (`warning: 50 event ids look like random tokens ... (first: event id #1)`), never one line per event and never the id itself; an id with structure (a JSON array or object, as the Wikimedia stream sends) is not reported. See [Redaction policy](/guide/redaction-policy#event-ids-that-look-like-tokens).

### `--no-redact` and secrets

`--no-redact` writes the capture as it was recorded, wire bytes included, so that `replay` can reproduce the stream byte for byte. A server can echo a credential back into its own stream, and the scrub cannot work on those bytes (a scrub of base64 leaves a file that cannot be read back). So:

- **With any secret option (the list above) it is refused**, for `probe` and `env-diff`: exit **2**, nothing is connected to, nothing is written. The message names the options and gives the two ways out: run without `--no-redact` (the capture is redacted and safe to share), or without the secret options.
- **With none** it works as before: a byte-exact local capture, and the warning `--no-redact writes a capture that may contain secrets. Do not share it.` stays (a stream can still carry something sensitive in its own data).

### Redirects to another origin

Credentials are never sent to another origin (scheme, host and port). The tool follows redirects itself, so a key sent in a custom header, which the platform's own `fetch` would forward, stays behind too. What happens when a server redirects to another origin:

- **No secret option:** the redirect is followed, as it always was (a CDN hop is normal).
- **With a secret option:** the redirect is **refused**. The probe stops with exit **3** (could not run), before the other origin is contacted, and the message names the options that carry secrets and the origin it redirected to. The first request, to the address you gave, was sent as you asked.
- **`--follow-redirects`** (for `probe`, `env-diff` and `validate`) is the explicit opt-in. The redirect is followed, the credentials are **still not sent** to the other origin (only headers that describe the request, such as `Accept` and `Last-Event-ID`, are), and a warning on stderr, once per origin, names the options that were not forwarded. Expect the other origin to answer without them, usually with a 401.
- **A redirect inside the same origin** (a path, a trailing slash) is followed with the credentials, with or without the flag. A request that has left an origin and come back does not get its credentials back.
- Redirects are followed for at most 5 hops, and only to `http` or `https`.
- `sse-doctor test` (scenario files) fetches through the same code but does not have `--follow-redirects` yet: a scenario's cross-origin redirect is followed without its credentials, silently, as before.

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
