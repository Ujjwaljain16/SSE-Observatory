# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 2.x (the latest release) | yes |
| 1.x | no: please upgrade |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting: on the repository page choose **Security**, then **Report a vulnerability**. If that option is not shown, open an issue that says only that you have a security report and asks for a private way to send it; do not put details in it.

Helpful in a report: what you did, what you expected, what happened, the version (`sse-doctor --version`, or the footer of the app), and a minimal way to reproduce it. You will get an answer, and a fix or a clear explanation, as fast as one person can manage; there is no bounty.

## What is in scope

The areas where a flaw matters most, and where the project already tests hardest:

- **The server proxy** (`/api/sse`): server-side request forgery (private, loopback, link-local and cloud-metadata addresses are blocked after DNS resolution and the connection is pinned to the validated address), header and token handling, resource limits.
- **The mock replay API**: request size and rate limits, session isolation.
- **Redaction and the secret scrub**: a secret that survives into an exported capture, a report, a scenario, or the command line's own output. The scrub does **not** recognise every encoding of a secret (the [CLI guide](docs/guide/cli.md) lists what it covers and what it does not), so a form it does not claim to cover is a known limit, not a vulnerability; a form it **does** claim to cover is.
- **The interceptor sandbox**: an escape from the locked-down Worker.
- **The command line**: credentials sent to another origin, files written outside what was asked.

Out of scope: findings that need a malicious local user with access to your machine, and denial of service by running the tool against a server you do not own.

More on how the project thinks about this: [Security review](docs/technical/security.md) and [Known limitations](docs/technical/limitations.md).
