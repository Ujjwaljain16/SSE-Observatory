# What's new in 2.0

SSE Observatory 2.0.0 (released 2026-11-15) keeps everything v1 did (the live viewer, the query language, multi-stream, interceptors, patterns, the mock server) and adds the part that answers the harder question: **why is this stream stuck, late or losing events?** The loop it is built around is **Inspect, Diagnose, Reproduce, Test, Monitor**, in the app and on the command line.

## New

- **[Stream Doctor](/guide/stream-doctor)** in the app: a live health strip and findings that keep what was *observed* apart from what is only *inferred* ("Likely: ...", with the other explanations and a command to check next). Fifteen rules cover status and content type, framing, first-event timing, silences, bursts, reconnect loops, resume with `Last-Event-ID`, sequence gaps and duplicates, heartbeats, slow consumers, credentials in the request, proxy masking, clock jumps and payload format changes. "No findings" is never presented as proof of health, and a check that could not be judged says so.
- **[The `sse-doctor` command line](/guide/cli)** (Node 20 or newer): `probe`, `analyze`, `report`, `compare`, `curl`, `redact`, `repro`, `test`, `replay`, `fixtures`, `validate`, `selftest` and `env-diff`, with exit codes for CI, JSON output that has [published schemas](https://sse-observatory.vercel.app/docs/schemas/sse-cli-output-1.json), and JUnit and Markdown output.
- **[Scenarios and CI](/guide/cli-ci)**: a captured failure becomes a regression test. A scenario can carry `expect.max_silence_ms` to catch a stall, a scenario made from a bad response expects the healthy one (and says it verifies the fix), and an explicit `reconnect` step controls the reconnect (its delay, and whether the cursor is sent).
- **[The capture format](/technical/capture-format)** (`.sse-capture`, version 2) with an integrity hash, [redaction](/guide/redaction-policy) before anything leaves your machine, and import of v1 recordings.
- **[Proxy diagnostics](/technical/proxy-diagnostics)**: the server proxy tags its own output so the Doctor can tell the upstream from the proxy, rewrites an upstream's look-alike tags so an upstream cannot pass as the proxy, and with `PROXY_DIAGNOSTICS=0` writes no `sse-proxy` text and no `X-SSE-*` header at all.
- **A fixture server** with a ground-truth log of every byte it wrote, dozens of faulty streams and their healthy twins, used by the project's own tests and by `sse-doctor fixtures`.

## Behaviour you may notice

- A stall that a later connection recovered from is shown as resolved and kept as history. A stream whose rhythm genuinely changes (three consistent slow gaps in a row) is recognised, with an informational "cadence changed" note, unless a declared `expected.maxSilenceMs` forbids it.
- The proxy's own error notice is an SSE comment, not an `error` event, so the application never sees an event the upstream did not send.
- The command line **refuses** a redirect to another origin while credentials are attached (`--follow-redirects` opts in, and the credentials still never go to the other origin), refuses `--no-redact` together with secret options, and refuses a capture whose `seq` repeats or goes down or whose `t` goes backwards. [Why](/guide/cli).
- `sse-doctor replay` replays a capture exported from the app as a labelled **synthetic** replay (placeholder bodies of the recorded size), never as byte-exact. A v1 recording replays with its original SSE id and event name, never its internal storage id.
- The Timeline numbers rows by connection and shows the retry counter in its own column. The live views are labelled "Raw values — as received, not redacted." and copying a raw event value asks first.
- The command line is **published to npm** as [`sse-doctor@2.0.0`](https://www.npmjs.com/package/sse-doctor): `npx sse-doctor --help` (Node 20 or newer, no dependencies, 79 files, about 250 KB). From a checkout, `npm run build:cli` builds the same code. [How it is published](/technical/publishing).

## How it was tested

A testing campaign ran before the release: independent oracles (the WHATWG parsing algorithm written out literally, the fixture server's own log), the real proxy in the loop, the built command line as a process, a browser sweep that plants secrets and searches every export, boundary tables for every threshold, and a journey test from the browser to the command line. It found and fixed about twenty defects and recorded every decision, with the commit that fixed it. The account, what it did **not** cover, and how to reproduce each check are in [the testing campaign](/technical/testing-campaign).

After the release, the deployed site is checked end to end with `npm run smoke:live` (a real browser against the hosted demo: connect through the proxy, open the Doctor, export a report, check the documentation).

## Known limits

- The command-line scrub does not detect every encoding of a secret. The [CLI guide](/guide/cli) lists what it covers and what it does not. Detection is not complete.
- The "under 2% CPU at 500 events/s" target is not demonstrated; see the [measurements](https://github.com/Ujjwaljain16/SSE-Observatory#10-performance).
- Not covered: a real screen reader, Safari and mobile, a real CDN or reverse proxy that buffers, the Vercel runtime beyond a smoke test, long soak runs and real network faults. See [Known limitations](/technical/limitations).
