# Contributing to SSE Observatory

Thank you for helping. This project debugs other people's streams, so it holds itself to a simple rule: **a claim needs a test that can fail.** The same rule is how contributions are reviewed.

## Set up

Requires Node.js 20 or newer.

```bash
git clone https://github.com/Ujjwaljain16/SSE-Observatory.git
cd SSE-Observatory
npm ci
npm run dev          # the app on http://localhost:3001 and the API server (proxy, mock replay) on :3000
```

`npm run chaos`, `npm run demo` and `npm run simple` start test streams to point the app at. The documentation site is `npm run docs:dev`.

## Before you open a pull request

```bash
npm run verify       # lint (0 warnings allowed), three typechecks, the unit tests with coverage, the app build, the command line build
```

Also run what your change touches:

| If you changed | Run |
|---|---|
| the command line (`src/cli`, `src/core`, `lib`) | `npm run doctor:selftest`, `npm run doctor:buildcheck`, `npm run doctor:contract`, `npm run cli:check`, `npm run doctor:scenarios` |
| anything the browser shows | `npx playwright install chromium` once, then `npm run test:e2e` |
| the proxy or the mock API (`lib/`, `server.js`) | the tests under `src/tests`, and `src/fixtures/__tests__/proxyInTheLoop.test.ts` |
| the docs | `npm run docs:build` (it fails on a dead link) |

CI runs the same on Linux and Windows, on Node 20 and 22, plus the browser tests.

## What a good change looks like

1. **Test first.** For a bug, write the test that fails, then the smallest fix. For a behaviour, write the test that pins it. Test the faulty path **and** the healthy one: every faulty fixture in `src/fixtures` has a healthy twin so a rule that fires on everything is caught.
2. **Do not weaken an assertion to make it pass.** If a test is wrong, say why in the pull request and change it deliberately.
3. **Say what you did not check.** "Not verified" is an acceptable sentence in a pull request; a guess presented as a fact is not. The Doctor follows the same rule: a finding separates what was observed from what is inferred, and "no findings" is never reported as proof of health.
4. **Update the docs** in `docs/` (and the README if it states the behaviour). The published JSON Schemas in `docs/public/schemas` must stay equal to the ones in code; a test enforces it.
5. **No new runtime dependency** without a discussion. The command line ships with none.
6. **Security-sensitive code** (the proxy guard in `lib/proxy`, redaction in `src/core/capture`, the secret scrub in `src/cli`) needs a test that plants a canary secret and searches the output for it. See `src/cli/__tests__/security.*.test.ts` for the pattern.

## Where things are

```text
src/core/        the Doctor's DOM-free core: SSE client and parser, recorder, diagnostics rules, capture format, redaction, scenarios
src/doctor/      the in-app Doctor: store, sessions, export, capture library
src/cli/         the sse-doctor command line
src/fixtures/    deterministic faulty streams, their healthy twins, and the ground-truth log used as an oracle
src/components/  the React app          lib/   proxy and mock API shared by Express and Vercel
e2e/             Playwright specs        docs/  the VitePress site (guide, technical notes, JSON Schemas)
```

[Architecture](docs/technical/architecture.md), [the diagnostics rules](docs/technical/diagnostics.md) and [the testing campaign](docs/technical/testing-campaign.md) (how the project was tested before 2.0, and what it does not cover) explain the design.

## Adding a diagnostic rule

A rule is a pure function over what a client observed. Add it with: a faulty fixture and its healthy twin in `src/fixtures`, a boundary test at the threshold minus one, at it and plus one, a line in the rule table of `docs/technical/diagnostics.md`, and evidence that points at real records (`src/core/diagnostics/__tests__/evidenceIsReal.test.ts` checks it).

## Reporting bugs and asking for features

Use the issue templates. For a stream problem, a **redacted** capture helps most: `sse-doctor probe <url> --out x.sse-capture` (secrets are redacted before the file is written) or the app's Export. Do not post a capture made with `--no-redact`. Security problems: see [SECURITY.md](SECURITY.md).

## Conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). The project is licensed under the [MIT License](LICENSE); your contributions are too.
