# Changelog

All notable changes are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/). The command line, the capture format (`2.x`) and the scenario schema (`1`) are versioned separately; the release notes of each [GitHub release](https://github.com/Ujjwaljain16/SSE-Observatory/releases) say which changed.

## [Unreleased]

### Fixed

- `report`, `redact` and `probe --out` printed one stderr warning per event whose id "looks like a random token" (462 lines for a 468-event capture of the public Wikimedia stream, whose ids are JSON arrays). An id with structure (JSON, or whitespace, quotes, braces, brackets, commas) is no longer taken for a token, and the ids that still are reported once, with a count and the first event.

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
