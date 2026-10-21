# Security review

Before the v2 release the Stream Doctor was reviewed by an independent pass that read the code adversarially (redaction,
the command line, the mock server, the proxy, browser storage, the report output) and tried to break it with small
programs. It found 24 problems; the ones that mattered most were found by running something, not by reading. This page says
what was found, what was done, and what is still true.

## What was found and fixed

| Area | Problem | Now |
|---|---|---|
| Redaction | `token=` inside any URL in stream text, comments, a `Location` header or an error message was never replaced: the redactor read `https:` as a `name: value` pair and skipped the whole URL | URLs in text are searched inside; a table test covers the shapes |
| Redaction | A pattern for `scheme://user:password@` was quadratic: 78 KB of `a-a-a-…` took 46 s and froze the export dialog and the command line | the scheme is bounded; 200 KB now takes well under a second (tested) |
| Redaction | A list, an object or double-encoded JSON under a sensitive name, a Python-style `{'password': '…'}`, `Authorization: Token x`, a user name alone in a URL (`https://KEY@host`), plural names (`tokens`) and names such as `secretAccessKey`, `sessionKey`, `sid`, `connect.sid` were kept | all are replaced; ordinary text stays readable |
| Redaction | A token in a URL **path** or as a bare query name, and the userinfo of a URL the platform cannot parse, were kept; a long hex token was not flagged by the scan | path segments and names that look like tokens are replaced, userinfo is never kept, long hex is flagged |
| Command line | `report`, `curl`, `probe --out` and `repro` did not print the residual-scan and id warnings, only `redact` did | all of them do, and never print a value |
| Reports | A hostile capture file could put text into the HTML report's `class` attribute, and a `<meta refresh>` got past the report's policy | a finding carries only one of four severity words; the policy adds `form-action 'none'` and `base-uri 'none'` |
| Mock server | A capture with thousands of connections made a resumed replay take minutes of event-loop time (26 s for a 5 MB upload) | grouped once, and at most 1000 connections per capture |
| Mock server | A gzip upload was charged by its compressed size, so it bypassed the hourly budget | the stored size is charged |
| Mock server | No cap on open or looping streams | 50 at once and 300 s each by default; both configurable |
| Parser, store | One event that never ends (many short lines, no blank line) grew without limit; the store kept every distinct comment text forever | an event over 16 M characters stops the stream with a violation; the store forgets what it no longer holds |
| Parser | An empty chunk between CR and LF made a different event than the same bytes without it | fixed, with a regression test |
| Command line | A custom secret header (`--header-env X-Api-Key=…`) followed a redirect to another origin; only `Authorization` and `Cookie` were dropped by the platform | redirects are followed by hand, and once the origin changes only headers that hold nothing secret are sent |
| Command line | Text from a stream reached the terminal and the JUnit file with control characters (escape sequences; illegal XML) | shown as `\uXXXX` |
| Command line | A target URL the platform cannot parse was quoted whole, with its user name, password and query, in the output and the "redacted" capture; a secret echoed in JSON-escaped, lower-case-percent or base64url form escaped the scrubber | such a URL is refused with a message that does not quote it; the scrubber knows those forms and the secret behind `Bearer …` |
| Command line | `--duration 0` (or very large) ended a probe at once with exit 0; a refused connection could pass a gate set above its findings; `--timeout` was accepted and ignored; a fast server could fill the memory | `--duration` is validated; a probe that never got an answer exits 3 whatever `--fail-on` says; `--timeout` waits for the first response; `--max-mb` stops a probe that is filling memory |
| Scenarios | A scenario could read any environment variable with `${ENV:NAME}` and send it to a URL it controlled | only `STREAM_*` and `SSE_*` unless the person running it passes `--allow-env NAME` |
| Analysis | A capture record with a missing field threw out of the analysis (the app showed its error screen) | a check that cannot read a record stops, is reported as *not evaluated* with the reason, and the rest carry on; a file's size is checked before it is read |
| Browser | A shared connection ignored a changed profile, so the recorder read the old field | recording, proxy and profile are part of a connection's identity |
| Development | Same-origin requests were trusted whatever the host name, so a page reaching the dev server under a rebound name could use the open dev proxy | the host must be loopback or a configured origin |
| `replay` | A full capture was served with `Access-Control-Allow-Origin: *` | not readable by pages unless `--allow-origin` names one; a redacted capture keeps the open policy |
| Exports | CSV cells were not quoted and could start a spreadsheet formula; an event named `__proto__` was counted wrongly | quoted, formula starts neutralised, a `Map` |
| Tests | `npm run test:soak` found no tests; the self test covered 4 of 14 rules | a config that runs it; the self test covers all 14 |

Each fix has a test that fails without it.

## What is still true

- **Redaction recognises shapes, not meaning.** A secret in free text that matches no known format and looks like ordinary words
  cannot be found. The scan is a check, not a guarantee; read what you are about to send.
- A key name longer than 64 characters, and response header values in a capture loaded from a file, are not redacted by name.
- The scenario runner still keeps every record of a run in memory (the probe is bounded); scenario runs are short.
- A capture with a record that makes redaction itself fail (invalid Base64) is refused with a message rather than redacted.
- Real browsers, PowerShell, Vercel with a KV store and live DNS rebinding were not part of the review.

## Reporting

Please report security problems privately to the repository owner before opening a public issue.
