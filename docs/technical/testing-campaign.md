# Testing campaign

What has been tested beyond the ordinary unit and end-to-end tests, what it found, what is still open, and what has not been done. This page is kept up to date as the campaign goes on; every claim here can be checked with the command or the file named next to it.

The campaign's idea: more tests of the same shape find few bugs, so it uses **independent oracles** (the WHATWG algorithm written out literally, the fixture server's own log, a strict XML parser, the specification's own examples), **real processes** (the built command line), and **tables that pin every threshold at its edge**. Each defect gets a failing test before its fix.

## Where it stands

| Slice | What | Status |
|---|---|---|
| B | Parser and framing: the parser against the specification (random streams, raw bytes, every 2- and 3-way split of the specification's examples), the proxy's framer against the parser, hostile input, observer on/off identity | done |
| C | Rules and engine: every threshold at T-1, T and T+1, finding lifecycle, odd threshold values, evidence pointers, rule/fixture/twin coverage, odd sequence ids | done |
| D3 | A scenario made from a capture, run against the faulty stream and its healthy twin | done, two gaps recorded (below) |
| E3 | Hostile text from a stream through every command and format, with a strict XML parser for JUnit | done |
| F | The built command line as a process: exit codes, clean stdout, no stack traces, always stops, expands its own globs (`npm run doctor:contract`) | done |
| A1, A5 | The fixture server's own log, and the four-way comparison (server, transport, parser, findings) on ten routes | done |
| E1 | A sweep of every export path for planted secrets (the plan treats a survivor as a release blocker): the Doctor's exports and the whole command line, searched for each planted value in five encodings | done for the Doctor and the CLI, **2 defects**; the browser end-to-end part and the encodings of E2 are not |
| A2, A3, A4, A6 | Stepped server clock, new fixtures, fixture contract test, the proxy in the loop | not started |
| D1, D2, D6 | Capture, replay and re-analysis round trip; damaged and truncated files; real v1 recordings | not started |
| E2, E4, E5, E7 | Secret encodings, redirect policy, URL validation, build safety | not started |
| G, H, I, J | Browser parity and lifecycle, performance and soak, an end-to-end journey, nightly and release-candidate workflows | not started |

## Defects found and fixed

| # | Where | What was wrong | Commit |
|---|---|---|---|
| 1 | Proxy frame tracker | An empty first chunk made it say "not at an event boundary" | `f8ac4014` |
| 2 | Proxy frame tracker | It refused to write after a complete comment or `retry:` line, so the proxy withheld an error event or keep-alive it could safely write; it also misread a byte order mark | `f28fde72` |
| 3 | SSE parser | A character that was only half received counted as "nothing pending", so a stream cut inside one ended with no unterminated-frame warning | `f28fde72` |
| 4 | R05 stall rule | After a clock jump it said "after the last byte at t=T" where T was the jump, not a byte | `f28fde72` |
| 5 | Reports | `report` md/html/issue/json let raw control characters and escape sequences from the server's text into the file | `e2e0cfdb` |
| 6 | Engine thresholds | NaN, negative or infinite thresholds printed as "The threshold was NaN s" | `608dda6c` |
| 7 | Observation batcher | A throwing observer escaped as an uncaught exception from a timer, which ends a Node process | `e00cf989` |
| 8 | Redaction | A secret key (`password`, `token`, `api_key`...) inside an object or list under a harmless name (`{"user":{"password":"x"}}`, `{"items":[{"token":"x"}]}`) was **kept** in every shared capture and report, because the scan for `"name": value` pairs matched the whole inner object as the value of `user` and went on after it | the commit that adds `artifacts.canary.test.ts` |
| 10 | CLI | Every value in the URL's query was registered as a secret, so a harmless `?scale=0.05`, `?limit=1000` or `?debug=true` made each `0.05`, `1000` or `true` in the output a placeholder, including inside JSON numbers: `--format json` output and the saved capture could be invalid (found as a flake in the canary sweep). A value is now a secret when its name says so or its shape does (12+ characters mixing letters and digits) | same commit |
| 9 | CLI | `probe --no-redact --out` wrote a capture that could not be read back, redacted or replayed: the scrub of the secrets you gave the command replaced part of the base64 of an echoed secret inside the wire bytes. The capture is now scrubbed field by field before it is written, leaving only the base64 of the wire bytes as recorded | same commit |

## Open decisions

None of these is fixed. Each is pinned by a test so the behaviour is visible, and each needs a decision.

### Q4a. A scenario made from a stall capture does not catch the stall

A scenario collects the events the capture had and stops, so the silence that followed is never judged: it passes against the stalled stream. Test: `src/cli/__tests__/scenarioRoundTrip.test.ts` (`it.fails`, with a set-up test beside it).

- **Option 1 (recommended):** an optional `expect.max_silence_ms` in the scenario schema (an additive, backward-compatible change), generated from stall findings, with the runner observing for that long after the last step.
- **Option 2:** leave it, and say in the generated scenario's notes that a stall is not checked.

### Q4b. A scenario made from a bad-response capture expects the bad response

It expects the captured status and content type, so it passes on the fault and fails on the fix. The generated note tells the user to edit `expect`; a regression scenario that has to be edited to mean what it says is not one.

- **Option 1 (recommended):** when the captured response was not a healthy event stream, expect a healthy one (200, `text/event-stream`) and say so in the notes.
- **Option 2:** keep it and emit a failing check that states the choice.

### Q12. A stall that ended with a closed connection stays open after a healthy reconnect

The stall finding is `resolved` only when data resumes on the same connection. A silence that ended because the connection closed stays `open`, even after the client reconnects and the new connection is healthy. Exit-code gates and the health strip read `open`. Test: `src/core/diagnostics/__tests__/lifecycle.test.ts`.

- **Option 1:** resolve it when a later connection delivers data. A capture analysed after the fact would then stop failing a gate for a stall that was followed by recovery.
- **Option 2 (current):** keep it open: the problem happened and was not proven fixed by this capture. Say so in the finding.

### Q13. An early stall becomes part of the rhythm the next one is judged by

The limit is three times the 95th-percentile gap of the stream's own history. With about a dozen gaps of history, one 8 s stall becomes that percentile, so the same stall again (limit 24 s) is not reported; with about forty gaps it does not move. Test: `lifecycle.test.ts` ("KNOWN LIMIT").

- **Option 1 (recommended):** keep a gap that was itself reported as a stall out of the baseline it is judged by.
- **Option 2:** document it in the known limitations.

### Q14. A `--no-redact` capture keeps the wire bytes as recorded, so the secrets you gave may be in them

The command line scrubs every value you give it (`--auth-env`, `--cookie-env`, ...) from everything it writes. For `--no-redact` that corrupted the file (defect 9). The capture is now scrubbed field by field, except the base64 of the wire bytes, which is the point of a byte-exact local capture. The flag already says "may contain secrets, do not share". Test: `src/cli/__tests__/security.canary.test.ts`, and `security.url.test.ts` for the URL's own secrets.

- **Option 1 (current):** as above, documented in `docs/guide/cli.md`.
- **Option 2:** refuse `--no-redact` when any secret option was given, and say why.
- **Option 3:** also scrub the decoded wire bytes and re-encode them, which is redaction under another name and defeats a byte-exact capture.

## Not covered

- A real screen reader, Safari and mobile; a real CDN or reverse proxy buffering; the Vercel runtime; long soak runs; real network faults; CPU overhead on a quiet machine (the "under 2% CPU at 500 events/s" target is still **not demonstrated**, see the README).
- Six of fifteen rules have no fixture stream that makes them fire (R03, R04, R09, R10, R13, R15); the reasons are in `src/core/diagnostics/__tests__/ruleCoverage.test.ts`.
- R07's coefficient-of-variation edge of exactly 0.03 cannot be built from whole-millisecond lifetimes, so `<` against `<=` there is untestable; it is pinned to within 1 ms.
- E1 covers the Doctor's exports (each shareable kind, both curl shells) and every command and format of the command line, with the planted secrets in these places: Authorization, Cookie, API-key and Proxy-Authorization headers, a Set-Cookie response header, URL userinfo, `?token=` and `?api_key=` query values, a JWT in a payload and in an event id, a nested `password` key, a `token` inside a list, an `api_key=` in a comment, and a JWT split across two chunks. It does **not** yet cover the browser (the export dialog and clipboard in a real page), the v1 app's own JSON/CSV exports (never redacted, plan question Q2), or secrets that no rule can recognise: a random token in free text is flagged and kept, and a low-entropy secret sentence is neither removed nor flagged (both pinned by tests).

## Reproduce

```sh
npx vitest run --coverage --maxWorkers=3   # the unit, integration and property suites (default parallelism runs out of heap on some machines)
npm run build:cli && npm run doctor:contract   # the built command line as a process
npx playwright test                            # the browser tests
```
