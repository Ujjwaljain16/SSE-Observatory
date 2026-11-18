# Changelog

All notable changes are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/). The command line, the capture format (`2.x`) and the scenario schema (`1`) are versioned separately; the release notes of each [GitHub release](https://github.com/Ujjwaljain16/SSE-Observatory/releases) say which changed.

## [Unreleased]

### Added

- The command line's secret scrub recognises more encodings of a registered secret: hexadecimal (either case); a space written as `+` and `! ' ( ) * ~` percent-encoded (`URLSearchParams`, Python, PHP, Go, Java dialects); percent-encoded twice; JSON with `\uXXXX` escapes for non-ASCII characters and surrogate pairs, PHP's `\/` and Go's escapes for `<`, `>` and `&`; HTML entities; and base64 of the secret inside a larger base64 value at any alignment (a Basic header built by hand, `user:secret`) for secrets of 7 bytes or more. Text that merely resembles an encoding (a hash, `a+b`, `&amp;`, a JWT) is not altered. What is still not recognised is listed in the [CLI guide](docs/guide/cli.md#what-the-scrub-covers-and-what-it-does-not).
- A secret written in two or more pieces to standard output or standard error is now caught.
- Tests only: a TCP fault-injection proxy for tests (`src/fixtures/faultProxy.ts`, not part of the package) and tests that run the real client, the Doctor and `sse-doctor probe` through it: per-byte and random re-chunking, latency, a bandwidth limit, reset and close in the middle of an event, a blackhole (a half-open connection), a slow loris, a late first byte, a cut gzip body, and a port that refuses after the first success, each with a no-fault control and checked against the fixture server's own log. They pin that the client has no timeouts of its own and what bounds a `probe`.
- A `Performance` workflow (weekly, and on request) that measures, on a hosted runner, what the viewer costs at 500 events/s in the whole browser and on the main thread with the Doctor off, closed and open (`scripts/bench.mjs` now reports whole-browser CPU from the operating system's accounting and writes JSON with `--out`), and runs a 30-minute soak with the page's garbage collected every 30 s. The soak (`e2e/soak.spec.ts`) now fails on a held-heap slope above 0.5 MB/min after a warm-up, or a DOM node or listener count that keeps climbing, instead of only asserting a 1.5 GB ceiling.
- Measured in CI, and written down: at 500 events/s the whole viewer uses about 1.8 cores of a hosted runner (the "under 2% CPU" target is not met; the Doctor adds about 2.6 points with its panel closed), and over a 90-minute soak the DOM and listeners stay flat while the held heap rises about 0.43 MB a minute without levelling off (issue 100). The README, the limitations page and the testing campaign say so; the old "flat for 10 minutes" statement was measured without forcing a garbage collection and is withdrawn.

### Changed

- Two secrets that overlap without one containing the other (`secret-AAAA`, `AAAA-tail99` in `secret-AAAA-tail99`) are now replaced together as one mask; before, a fragment of the second stayed. A mask is no longer scanned again, so a secret that is a piece of the mask cannot cut into it.
- The end of a write to standard output or standard error that could be the start of a secret is held back until the next write or the end of the command (it is delayed, never changed); every other write goes out at once, as before.

### Fixed

- A byte order mark split across the first reads of a stream (cut anywhere by the network) is now reported as `BOM_STRIPPED` like one that arrives whole; it used to be dropped silently, so the note depended on where the stream was cut.

- `reconnect.loop` said "N connections were opened" when some of the attempts were refused and never reached the server. It now says "N connection attempts were made (M answered)" when any got no response; the wording for answered connections is unchanged.

## [2.0.1] - 2026-11-16

A fixes-only release found by a production acceptance test of 2.0.0 (the app, the live site and the published `sse-doctor`). Nine issues, #75 to #83, each fixed test first; the web app already ran these fixes on the hosted demo, 2.0.1 puts them in the npm package and the tag.

### Fixed

- `sse-doctor repro --scenario` built the scenario from the minimal capture, which for a stall has no events, so the scenario passed on the stalled stream it came from (#75). It is built from the original capture now.
- Captures and reports said `tool.version: "dev"` in the app and in the published command line; one `toolVersion()` fed from `package.json` now writes the real version, and the footer reads it too (#79).
- `report`, `redact` and `probe --out` printed one stderr warning per event whose id "looks like a random token" (462 lines for a 468-event capture of the public Wikimedia stream, whose ids are JSON arrays). An id with structure (JSON, or whitespace, quotes, braces, brackets, commas) is no longer taken for a token, and the ids that still are reported once, with a count and the first event.

- A stream connected through the app's server proxy exported a curl command of `POST '/api/sse'`, a report and issue body with the same, and a scenario note that said the URL could not be parsed. These now say that the stream went through the app's proxy, that its address was not recorded because it may carry a secret, and to set `STREAM_URL` to the address given to the app; the curl command is `curl -N -H 'Accept: text/event-stream' "$STREAM_URL"`. Captures with a real URL (the command line's own) are unchanged.

- A target that answers 200 with something that is not an event stream (a web page) is no longer retried for ever through the proxy. The proxy answers HTTP 415 with the target's content type instead of a retryable 502, and the client stops after one attempt with "The address answers with text/html, not text/event-stream, so there is nothing to retry." (#77)

- **App.** The Failure Lab opens from the empty Doctor state, its "not in the lab" reasons are written for users and seven newer fixtures are in the lab, 30 entries (#80). The last URL is remembered across a refresh (never the token, never a URL that carries a secret), the event list says "newest 1,000 of 1,225 events" once it is capped, and the playback bar no longer covers the toolbar (#81). Connection failures are announced as an alert and retries as a polite status without a per-second countdown, and every target is at least 24x24 px at 360 px (#82).
- The flaky multi-stream lanes test in CI clicked the first "Connect" button, which turned into "Disconnect" on lane 1 as it connected; it clicks each lane's own button now (#83). No product change.

## [2.0.0] - 2026-11-15

The Stream Doctor release: the app and a command line that say **why** a stream is stuck, late or losing events, with the evidence, and turn the diagnosis into a repeatable test. Full account: [What's new in 2.0](https://sse-observatory.vercel.app/docs/guide/whats-new). How it was tested, and what was not: [the testing campaign](docs/technical/testing-campaign.md).

### Added

- **Stream Doctor** in the app: a live health strip and findings that keep what was observed apart from what is inferred; fifteen diagnostic rules; a Timeline, Request, Flow, Sequence, Captures and Profile view; export of a report, a redacted capture, a curl command or a test scenario.
- **`sse-doctor` command line**, published to npm (`npx sse-doctor`): `probe`, `analyze`, `report`, `compare`, `curl`, `redact`, `repro`, `test`, `replay`, `fixtures`, `validate`, `selftest`, `env-diff`; exit codes for CI; JSON output with published schemas; JUnit and Markdown output.
- **Scenarios**: a captured failure becomes a regression test, with an optional `expect.max_silence_ms` that catches a stall and an explicit `reconnect` step that controls the reconnect.
- **The `.sse-capture` format** (version 2) with an integrity hash and import of v1 recordings; redaction before anything leaves the machine.
- **Proxy diagnostics**: the proxy tags its own output so the Doctor can tell the upstream from the proxy; `PROXY_DIAGNOSTICS=0` turns every tag and header off.
- **A fixture server** with a ground-truth log of every byte written, dozens of faulty streams and their healthy twins.
- A live smoke test of a deployed site (`npm run smoke:live`), and the nightly and release-candidate workflows.

### Changed

- A stall that a later connection recovered from is resolved and kept as history; a stream whose rhythm changes (three consistent slow gaps) is recognised, with an informational note, unless a declared `expected.maxSilenceMs` forbids it.
- The proxy's own error notice is an SSE comment, not an `error` event. An upstream's look-alike `sse-proxy` comments are rewritten so an upstream cannot pass as the proxy.
- The command line refuses a redirect to another origin while credentials are attached (`--follow-redirects` opts in), refuses `--no-redact` with a secret option, and refuses a capture whose `seq` repeats or goes down or whose `t` goes backwards.
- `sse-doctor replay` replays an app-exported capture as a labelled synthetic replay; a v1 recording replays with its original SSE id and event name, never its internal storage id.
- The Timeline numbers rows by connection and shows the retry counter apart; live views are labelled "Raw values — as received, not redacted." and copying a raw value asks first.
- Documentation links are clean URLs (they returned 404 on the hosted site before).

### Fixed

About twenty defects found by the pre-release testing campaign, each with a failing test first: the proxy's frame tracker, secrets that survived nested JSON and `--no-redact` captures, a Doctor view that flickered a silence out of sight, the scenario runner failing a healthy stream after a server drop, and more. The list, with the commit for each, is in [the campaign page](docs/technical/testing-campaign.md).

### Known limits

The command line's scrub does not recognise every encoding of a secret; the "under 2% CPU at 500 events/s" target is not demonstrated; a real screen reader, Safari, mobile and a buffering CDN were not tested; one multi-stream browser test is occasionally flaky in CI. See [Known limitations](docs/technical/limitations.md).

## [1.0.0]

The original SSE viewer: a live monitor with a query language, multi-stream lanes, interceptors, pattern detection, trace correlation and a mock replay server. See the `v1.0.0` tag.

[2.0.0]: https://github.com/Ujjwaljain16/SSE-Observatory/releases/tag/v2.0.0
[1.0.0]: https://github.com/Ujjwaljain16/SSE-Observatory/releases/tag/v1.0.0
