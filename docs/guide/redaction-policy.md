# Redaction policy

Redaction has built-in rules: JWTs, bearer credentials, cloud and API key formats, credentials in URLs, and the values of keys named like `password`, `token` or `secret`. A **redaction policy** adds your own on top, for what only you know is sensitive (a customer reference, an internal ticket number, a field called `ssn`).

The same file works in the [command line](/guide/cli) (`--redact-policy <file>`) and in the app (**Export** → **Redaction rules**, kept in the browser).

## The file

```json
{
  "version": 1,
  "extraKeys": ["ssn", "internalNote"],
  "extraPatterns": [{ "name": "ticket", "pattern": "ACME-\\d{6}", "flags": "i" }],
  "keepHeaders": ["x-request-id"],
  "redactPartitions": true
}
```

| Field | What it does |
|---|---|
| `extraKeys` | Payload key names to treat as secret, as the built-in names are: `"ssn": "123-45-6789"` and `ssn=123-45-6789` are replaced. Case, dashes and underscores do not matter. |
| `extraPatterns` | Regular expressions to replace. The whole match is replaced, or the first capture group if there is one. `name` labels the rule in the redaction summary, so you can see how often it fired. `flags` may use `i`, `m`, `s` and `u`. |
| `keepHeaders` | Request header names whose value may stay in a shared capture, beside the built-in safe list (`accept`, `user-agent`, ...). |
| `redactPartitions` | `false` keeps the values of a sequence's partition key (for example `$.shard`) readable. Default `true`. |

## What a policy cannot do

- **Only add.** It cannot switch a built-in rule off. The one thing it can loosen is a kept header, and a header that carries credentials (`Cookie`, `Authorization`, anything named like a token or secret) is refused.
- **Take long to run.** A pattern may be at most 200 characters, there may be at most 20, a pattern that matches the empty string is refused, and so is one that repeats a group that itself repeats, like `(a+)+`, which can take exponential time on a long stream. The check looks for that shape; it does not prove every pattern is fast, so test a new pattern on a large capture.
- **Be half used.** A policy with any problem is not used at all, and every problem is listed at once: the command line exits with code 2 and writes nothing, and the app keeps the rules it had.

## Event ids that look like tokens

An event id that is a credential by a known format is replaced. An id that only *looks* like a random token (24 or more characters of base64, url-safe base64 or hex, with no format to prove it) is kept, because replacing it would break the ids that `Last-Event-ID` and the sequence checks rely on, and it is reported **once**, not once per event: `warning: 50 event ids look like random tokens but match no known secret format, so they were kept; check them before sharing (first: event id #1)`. The line counts events and names the first one; it never shows an id. A value with structure is not a token: an id that is a JSON object or array (the public Wikimedia stream sends one), or that holds whitespace, quotes, braces, brackets or commas, is not reported, and a token inside such a value is still found by the scan for what still looks secret.

## Reading the result

A capture redacted with a policy says `"policy": "custom"` in its header, and the rule names you gave appear in the redaction summary (`ticket: 3`). The scan for anything that still looks secret runs with your rules too. As always, redaction recognises shapes, not meaning: a policy narrows that gap for what you know about, and the preview is still the thing to read before you share.
