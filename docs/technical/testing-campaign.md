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
| E1 | A sweep of every export path for planted secrets (the plan treats a survivor as a release blocker): the Doctor's exports and the whole command line, searched for each planted value in five encodings | done for the Doctor, the CLI and the browser (export dialog, downloads, clipboard, local storage), **4 defects** in all (nested secret keys, an unreadable `--no-redact` capture, URL query values registered as secrets, a URL quoted in a browser error); what it does not cover is listed under "Not covered" |
| A4, A6 | A contract for every fixture route checked against the server's own log; the real proxy in the loop (tags, resume, a dying upstream, a killed proxy) | done, **1 defect** |
| F4, F5 | The verify job also runs once on Node 20; the command line's `--format json` output has published schemas (`docs/public/schemas/sse-cli-output-1.json`, `sse-test-output-1.json`) and the tests validate what the real commands print against them, and show the schemas reject damaged output | done; the Node 20 leg has not run on GitHub yet |
| J | The CI workflow's required steps held by a test; a nightly workflow (healthy twins in real time with the default thresholds, a check that each fixture fails without its rule, a flake loop under CPU load, the suite and the command line on Node 20, a results report, an issue on failure); the report generator (`scripts/campaign/report.mjs`) and the flake loop (`scripts/campaign/flake-loop.mjs`) | done; the nightly workflow has **not yet run on GitHub** (its parts were run here once) |
| C5 | Scale invariance: nine routes (faulty and healthy) read at scale 0.1 and 0.25 with the defaults scaled, give the same findings and severities as at scale 1 | done, no difference found (nightly mode; passed in one run) |
| D4, D5 | A replay keeps the timing of the capture at 0.5x, 1x and 2x (median relative error under 15%, 95th percentile under 60 ms; passed in one run on a busy machine); the documented large-capture limits (`scripts/perf/large-capture.mjs`: analyze in a 384 MB heap, redaction of 200,000 chunks, the 20 MB upload refused with 413) | scripts and tests written, in the nightly workflow; the documented 116 MB / 24 s figure has **not** been reproduced at full size yet (only a 60,000-record smoke run) |
| H1 | The per-record cost micro-benchmark (`npm run perf:record-cost`). Measured 2026-11-15, Node 22.19, i5-13450HX (16 CPUs), Windows 11, the machine otherwise idle, 200,000 records, 3 warm-ups, median of 15 runs, twice: recording 0.49 µs per record; `engine.feed` with the 15 shipped rules 0.52 µs; the worker-to-page `structuredClone` of a batch of 10 0.41 µs per record; the Doctor's sync of 100 new records while 50,000 are held 3.96 µs per record (run-to-run spread 40-50%, median stable). Doctor-added cost (engine + hop + sync) **4.9 µs per record**, against 13.3 µs, the budget for 2% of one core at 1,500 records a second | done. **Caveats:** a Node micro-benchmark, not the browser; the synthetic stream is steady and rule-light (no violations, no declared sequence, no page-side samples), so rule-heavy streams cost more; the sync figure is mostly the copy of the held records that every sync makes, so it grows with what is held. The README's "about 13 microseconds" is **not** reproduced: this warm figure is far lower, and the README's was a first-run figure. The "under 2% CPU at 500 events/s" target is still **not demonstrated end to end** |
| H4 (the existing browser benchmark, re-run) | `BROWSER_CHANNEL=chrome node scripts/bench.mjs --doctor all --runs 5 --app http://localhost:3100` against the production build (`NODE_ENV=production PROXY_OPEN=1 ALLOW_PRIVATE_TARGETS=1 PORT=3100 node server.js`, the chaos server on 4000), Chrome 157.0.8103.78, i5-13450HX, Windows 11, otherwise idle, 2026-11-15, medians of 5. **Burst** (Doctor off / closed / open): timer-late p95 13 / 20 / 18 ms, long frames 0 / 5 (357 ms) / 6 (440 ms), worst frame 0 / 97 / 101 ms, heap growth +32 / +50 / +59 MB. **Sustained ~500 events/s** (off / closed / open): p95 4 / 4 / 9 ms, no long frame in the medians, heap +24 / +25 / +21 MB, main thread busy 74 / 64 / **91** % (min-max 80-96 for open). The README's October table (burst p95 16 / 31 / 36 ms, 0 / 7 / 10 long frames, worst frame 0 / 81 / 96 ms; sustained p95 8 / 8 / 9 ms) is **not reproduced exactly**: the burst stalls are about the same or milder, but with the panel open at 500 events/s the main thread was busier (91% against 74% with the Doctor off) and the p95 timer lateness doubled. Different machine and Chrome version, and the runs vary by about ten points, so this is a difference to look at, not a measured regression | measured; the raw output is in `test-plan/bench-2026-11-15.txt` (local); the README tables are **unchanged** and still describe the October run. This is not a CPU-percentage measurement of the SharedWorker, and the "under 2% CPU" target is still **not demonstrated** |
| A2, A3 | A stepped server clock (`startFixtureServer({ clock: 'manual' })`, `server.advance(ms)`); new fixtures `f05-ignores`, `h05-declared-idle`, `h06-comments-only`, `f04-late-heartbeat`, `f11-slow-start`, `f12-gzip-sync`, `f15-malformed`, `f16-rate`, each with a contract and a healthy twin and run with thresholds scaled from the defaults | done, **2 defects**; they make R03, R04, R09 and R10 fire from a fixture |
| D1, D2, D6 | Round trip of every capture through the file, the mock replay and a sanitized export, with a class A/B/C comparison; damaged and truncated files (every byte offset); v1 recordings | done, **3 defects**; real v1 exports are still missing |
| E2, E4, E5, E7 | Secret encodings (12 known gaps pinned), redirects to another origin, URL validation, and what the built CLI holds (`npm run doctor:buildcheck`) | done, **1 defect** |
| G | Browser end-to-end against the fixture server's own log: healthy and stalled streams (three different findings for three kinds of silence), two tabs on one URL (one connection), three lanes, a reconnect diagnosis checked against the log, the shared worker against the in-page fallback (equal reports), lifecycle (20 open/close rounds with no timer or listener left), the browser canary sweep (every export kind, the dialog preview, the clipboard, local storage), and a production-build smoke test | done, **1 defect**; each spec was run at least three times in the agent's run |
| H0, H6 (soak) | The existing soak spec (`npm run test:soak`, here with `SOAK_MINUTES=10` on Chrome 157, i5-13450HX, otherwise idle, 2026-11-15): a stream at 200 events/s for 10 minutes. It passed: connected the whole time, event rows present at all 20 checks, no crash. Heap used by the page, sampled every 30 s without forcing a garbage collection: 35-100 MB, no upward trend that can be told from the noise of uncollected garbage (a fit gives 2 MB/min with samples varying by 60 MB); the total heap went from 126 to 154 MB | smoke only. The plan's gate (heap slope under 0.5 MB/min with a **forced** collection before each sample, plus timers, listeners and the SharedWorker's heap) is **not evaluated**: the spec cannot force a collection. The recording is bounded at 8 MiB by design |
| H4 (overhead harness with arms and CIs), H5 (workloads) | The plan's paired-block harness with an A/A calibration, and the full list of workloads | not started; the existing `scripts/bench.mjs` (above) is what was run |
| I | The end-to-end journey | handed to an agent (see the next row when it reports) |
| G9 | Converting the waits in `e2e/doctor.spec.ts` to signals | not done (it edits an existing spec) |

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
| 11 | SSE parser | The resume cursor (`lastId`) moved when an `id:` line was read, not when the event was dispatched, so a stream cut inside an event made the client resume after an event it never completed, and the server skipped it with no error and no finding. The specification sets a buffer at the `id:` line and commits it at dispatch; a browser's EventSource would send the earlier id | `4228c4f` |
| 12 | CLI | A v1 `.sse-record` that starts with a byte order mark was refused ("not an .sse-capture file"), though the Doctor accepts the same file | `315a078` |
| 13 | v1 import | A non-object event in a v1 recording was a raw TypeError (exit 3 instead of 2), and a `deltaMs` of `1e999` produced a capture with an infinite time that cannot be saved | `315a078` |
| 15 | R10 heartbeat | The "no heartbeats seen" note ignored a declared longest silence: a stream that declared a 60 s idle got the note after a 40 s gap, where R05 and R13 used the declaration | `95a8ab0` |
| 18 | Doctor store | While records kept arriving (a heartbeat every 250 ms), an open silence dropped out of the live view: feeding a record clears the findings that are only true "so far", and the tick that restores them ran once a second, while the store published after every sync (every 250 ms). Found as an intermittent failure of a browser test under load; the store now ticks in the same step | the commit that adds the store test |
| 17 | Browser client | A URL quoted in a browser's network error message (a refused URL with credentials is quoted whole) was stored as the reconnect reason, so its password and query values reached the status text, the Doctor's finding text, the local capture and, for a query name redaction does not know (`sc=`), every shared export | `6f41418` |
| 16 | Redaction | A leading byte order mark was dropped from the text of a sanitized capture (the decoder removed it), so a replay lost the `BOM_STRIPPED` note | `e4ccb34` |
| 14 | CLI | Control characters from argv or a file name (an escape sequence in a URL, an unknown command) reached stderr raw, as S13 closed for streams | `8075ed8` |
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

### Q15. Forged proxy tags

The proxy forwards an upstream's `: sse-proxy hb up_idle=...` comment as it came, and the client labels any comment starting with `sse-proxy` as the proxy's. An upstream behind a proxy running with diagnostics off can make R13 report masking that is really the upstream (the `f04-masked` fixture has this shape). Test: `src/fixtures/__tests__/proxyInTheLoop.test.ts`.

- **Option 1:** the proxy drops or escapes upstream comments that start with `sse-proxy`.
- **Option 2:** the proxy adds a per-connection nonce to its tags and the client checks it.
- **Option 3 (current):** accept it: the proxy is a diagnostic aid and its tags are not authenticated.

### Q16. The proxy's `event: error` frame reaches the application as a message

When the upstream connection is reset between events the proxy writes `event: error` into the stream; the application receives it as an ordinary message named `error`. Keep it (the proxy says why it closed) or send it as a comment so event consumers never see it.

### Q17. `PROXY_DIAGNOSTICS=0` still sends `: sse-proxy-ping`

It is labelled as the proxy's, and the client cannot tell the proxy's plain `keep-alive` from the upstream's. An existing test asserts the ping, so it looks intended. Say so if the switch should mean "no `sse-proxy` text at all".

### Q18. The Timeline's attempt label repeats

After a connection that opened, the client's retry counter restarts, so `f05-drops` rows read `#1, #2, #2, #2`. Pinned in `e2e/doctor.fixtures.spec.ts`. Option 1: number the rows by connection and show the retry counter in its own column. Option 2: rename the column "Retry".

### Q19. The live Doctor shows data as recorded

The Sequence view lists event ids as received, so a JWT used as an event id is on screen, and the raw-record chips are unredacted (a local recording). Every export redacts it. Option 1: redact ids in the views with the same redactor. Option 2: label the views "as received, not redacted". Option 3: accept it, since it is the user's own screen.

### Q20. Cookie and custom-header secrets cannot be sent from the UI

The app has no input for them, so the browser sweep cannot plant them; the unit and command-line sweeps do. Add inputs if the browser should cover them.

### Q6 (plan). A redirect to another origin drops the secrets silently

`probe` follows a cross-origin redirect with the secret headers stripped, exits 0 and says nothing. Pinned in `src/cli/__tests__/security.redirect.test.ts`.

- **Option 1:** refuse the redirect when a secret option is present, with a clear message, and a `--follow-redirects` to opt in.
- **Option 2 (cheapest):** keep following, and print a note saying which headers were withheld from which origin.
- **Option 3 (current):** keep as is.

### Secret encodings the command line's scrub does not cover (E2)

Pinned as known gaps in `src/cli/__tests__/security.encodings.test.ts` (each is a pair: a test that the form survives today and an `it.fails` for the wanted behaviour): hex (either case); a space written as `+`; `! ' ( ) * ~` percent-encoded; JSON unicode escapes of non-ASCII and surrogate pairs; PHP `\/`; Go's escaped angle brackets; HTML entities; double percent-encoding; base64 of `user:secret`; the secret inside a larger base64 value at an unaligned offset; a secret split across two writes; and two secrets that overlap without one containing the other.

### Other open points from the same slices

- Mock replay of a v1 recording emits the recording's internal uuid as the event id and merges the event name into the JSON data's `type` (pinned, "OPEN QUESTION" in `importV1.test.ts`).
- A duplicate `seq` or a backwards `t` in a capture file is accepted without a warning; analysis does not fail.
- Real v1 exports are still needed: the four samples were made by the v1 export code path, not downloaded from the running app.

## Not covered

- A real screen reader, Safari and mobile; a real CDN or reverse proxy buffering; the Vercel runtime; long soak runs; real network faults; CPU overhead on a quiet machine (the "under 2% CPU at 500 events/s" target is still **not demonstrated**, see the README).
- Two of fifteen rules have no fixture stream that makes them fire (R13, which only the proxy-in-the-loop test fires, and R15, a clock jump a server cannot produce); the reasons are in `src/core/diagnostics/__tests__/ruleCoverage.test.ts`.
- R07's coefficient-of-variation edge of exactly 0.03 cannot be built from whole-millisecond lifetimes, so `<` against `<=` there is untestable; it is pinned to within 1 ms.
- E1 covers the Doctor's exports (each shareable kind, both curl shells) and every command and format of the command line, with the planted secrets in these places: Authorization, Cookie, API-key and Proxy-Authorization headers, a Set-Cookie response header, URL userinfo, `?token=` and `?api_key=` query values, a JWT in a payload and in an event id, a nested `password` key, a `token` inside a list, an `api_key=` in a comment, and a JWT split across two chunks. It does **not** cover the v1 app's own JSON/CSV exports (never redacted, plan question Q2), or secrets that no rule can recognise: a random token in free text is flagged and kept, and a low-entropy secret sentence is neither removed nor flagged (both pinned by tests).

## Manual checks (what automation cannot judge)

None of these has been done yet. Record the outcome of each in the results report under "manual".

1. Start `sse-doctor fixtures serve` and the app, and connect to `f04-silent?scale=0.25&n=12`. Without opening any help, can you say what is wrong in one sentence from the finding card alone? Which part of the card is observation, which is guess? Is the confidence word believable? Does the "check next" help you tell the origin from a proxy?
2. Repeat with `f04-heartbeats`, `f04-masked` and `f03-buffered`. The cards must read differently from one another and must not name a vendor.
3. Keyboard only: reach the Doctor toggle, open it, expand a finding, open its evidence, export, and leave with Escape. With a screen reader (NVDA on Windows or VoiceOver): does the live region announce state changes only? Are severities read as words?
4. Export a report from a stream that echoed a secret into a free-text field (`f08-echo`). Do you understand from the dialog what was and was not replaced? Would you paste the report into a ticket?
5. Bookmark an event, export, import the capture in the Captures tab and compare it with a healthy capture.
6. Resize to 360 px and 200% zoom; try reduced motion, and the dark and light themes.

## Reproduce

```sh
npx vitest run --coverage --maxWorkers=3   # the unit, integration and property suites (default parallelism runs out of heap on some machines)
npm run build:cli && npm run doctor:contract   # the built command line as a process
npx playwright test                            # the browser tests
```
