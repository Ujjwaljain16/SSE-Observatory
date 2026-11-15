# sse-doctor

Find out why a Server-Sent Events (SSE) stream is stuck, late or losing events, with the evidence, and turn the diagnosis into a repeatable test. The command line of [SSE Observatory](https://github.com/Ujjwaljain16/SSE-Observatory); the same checks run in its browser app (the Stream Doctor).

Requires Node.js 20 or newer. No dependencies.

## Try it

```sh
npx sse-doctor probe https://example.com/stream --duration 30 --out incident.sse-capture
npx sse-doctor analyze incident.sse-capture
npx sse-doctor report incident.sse-capture --format md
```

`probe` records what a stream really did (status, headers, every chunk and event, reconnects) into a `.sse-capture` file; `analyze` runs fifteen checks over it and prints findings. A finding separates what was **observed** from what is only **inferred** ("Likely: ...", with the other explanations and a command to check next). `npx sse-doctor --help` lists every command:

| Command | What it does |
|---|---|
| `probe` | records a stream into a capture |
| `analyze`, `report` | findings from a capture, as text, JSON, Markdown or JUnit |
| `compare` | what differs between two captures |
| `curl`, `redact`, `repro` | a curl command, a redacted shareable copy, the smallest capture that still shows a finding |
| `test` | runs a scenario file (a captured failure turned into a CI check) |
| `replay` | serves a capture as a local SSE endpoint |
| `fixtures`, `selftest` | built-in faulty streams and their healthy twins, and a check of every rule against them |
| `validate`, `env-diff` | checks that a fix removed a finding; compares one stream in two environments |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | passed |
| 1 | an open finding at or above `--fail-on` |
| 2 | wrong usage, an input that is not a valid capture, or an option combination that is refused (for example `--no-redact` with a secret option) |
| 3 | could not run (file unreadable, the server never answered, or a redirect to another origin was refused while credentials are attached; `--follow-redirects` opts in) |
| 4 | inconclusive: no check failed, but a scenario check could not be decided |
| 130 | interrupted |

## What it cannot tell you

- A client sees that bytes stopped arriving, not which hop stopped them. Findings say *likely* and list the alternatives.
- **No findings is not proof the stream is healthy.** Checks that had nothing to look at are listed as *not evaluated*.
- Gaps and duplicates are judged only when you declare which numbers count.
- The scrub applied to the command line's own output recognises the secrets you give it (`--auth-env`, `--cookie-env`, ...) in several encodings, not all of them: detection is not complete, so do not paste secrets where the tool does not know them. A capture is redacted before it is shared.

## Documentation

Guides, the exit codes in full, scenarios for CI, the capture format and the known limitations: <https://sse-observatory.vercel.app/docs/> (start with the [command line guide](https://sse-observatory.vercel.app/docs/guide/cli)). Source and issues: <https://github.com/Ujjwaljain16/SSE-Observatory>.

MIT licence.
