# Publishing `sse-doctor`

`sse-doctor` is built so that it **can** be published to npm, and it is **not** published. The repository's root package stays
`private`; nothing in the normal build or in CI can publish. This page is the checklist for the day that changes.

## What the build produces

`npm run build:cli` writes `dist-cli/`: the bundled CLI (`bin/sse-doctor.mjs`, with a shebang), a small library entry
(`index.mjs` and `types/`), a README and the licence (the JSON Schemas are published with the documentation site, not in the package), and a **generated** `package.json` with
`engines.node >= 20`, a `bin`, an allow-listed `files` and **no dependencies**. Its `prepublishOnly` script refuses to run
unless `SSE_DOCTOR_PUBLISH=1` is set, so an accidental `npm publish` there does nothing.

`npm run cli:check` packs that directory, installs the tarball into an empty folder, runs the real binary against a stream
carrying canary secrets, and checks the file list, the size budget (about 400 KB), the shebang, the absence of
dependencies, and that no canary appears in any output. CI runs it on Ubuntu and Windows.

## Before the first publish

- [ ] **Choose and check the public name.** It is not claimed or checked yet. Look it up on the registry, consider a scope, and
  change `PACKAGE_NAME` in `scripts/build-cli.mjs`.
- [ ] **Decide the version policy.** The CLI, the capture format (`2.x`) and the scenario schema (`1`) version separately. A
  breaking change to a format is a major version of that format; the analyzer version is written into every capture.
- [ ] **Read the package README** (`dist-cli/README.md`) as a stranger would: what it is, one command that works, the exit
  codes, what it cannot tell you.
- [ ] **Run the whole release gate** from a clean checkout: `npm ci`, `npm run verify`, the Playwright suite, `npm run cli:check`,
  `npm run doctor:selftest`, `npm run doctor:scenarios`, and the soak and benchmark runs on a quiet machine.
- [ ] **Check the tarball by hand** with `npm pack --dry-run --json` in `dist-cli`: only the files you expect, no source
  maps, no absolute paths from this machine, no tokens.
- [ ] **Install it from the tarball on a machine that never saw the repository** (Windows and Linux) and run `probe`,
  `analyze`, `report` and `test` against a real stream.
- [ ] **Decide on provenance.** Publishing from CI with `npm publish --provenance` ties the package to the commit that built it.
- [ ] **Two-factor authentication** on the npm account, and a token with the narrowest scope that can publish this one package.
- [ ] **A security contact** in the README and a note on how reports are handled.
- [ ] **Licence**: MIT, as the repository.

## Publishing

```bash
npm run build:cli
cd dist-cli
npm pack --dry-run          # read the list
SSE_DOCTOR_PUBLISH=1 npm publish --access public   # only when every box above is ticked
```

## After

Tag the release, record the version and the checks that were run, and keep the sanitized captures and fixture seeds that
reproduce any failure found, so a regression has a test before it has a fix.
