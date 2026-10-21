import type { CliIo } from './io'

/**
 * Every secret the CLI resolves (from an environment variable or a header flag) is registered here, and every output
 * goes through `scrub()`: stdout, stderr, files, error messages and the text of failures that embed a URL. A value is
 * recognised by what it is, not by where it appears, so a secret that leaks into an unexpected place is still caught.
 *
 * Values shorter than MIN_LENGTH are not registered: replacing a 2-character value would damage unrelated text. The
 * caller is told, so it can warn the user.
 */

export const MIN_SECRET_LENGTH = 4
const MASK = '[REDACTED]'

export class SecretRegistry {
    private forms: string[] = []

    /** Returns false when the value is too short to scrub safely. */
    register(value: string | undefined): boolean {
        if (value === undefined || value === '') return true
        if (value.length < MIN_SECRET_LENGTH) return false
        const b64 = Buffer.from(value, 'utf8').toString('base64')
        const forms = new Set<string>([
            value, encodeURIComponent(value), b64,
            // the ways a server echoing the value back may have written it: inside a JSON string, percent-encoded in lower case, base64url
            JSON.stringify(value).slice(1, -1),
            encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
            b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
            b64.replace(/=+$/, ''),
        ])
        // Basic auth sends user:password in Base64; a credential pair is registered both ways by the caller.
        // `Scheme value` (Bearer T, Token T): the value alone is the secret too, wherever it is echoed.
        const scheme = /^(?:Bearer|Basic|Token|Digest|ApiKey)\s+(\S{4,})$/i.exec(value)
        if (scheme) forms.add(scheme[1]!)
        for (const form of forms) if (form.length >= MIN_SECRET_LENGTH && !this.forms.includes(form)) this.forms.push(form)
        this.forms.sort((a, b) => b.length - a.length) // longest first, so a value that contains another is replaced whole
        return true
    }

    scrub(text: string): string {
        let out = text
        for (const form of this.forms) if (out.includes(form)) out = out.split(form).join(MASK)
        return out
    }

    get size(): number { return this.forms.length }
}

/** An io whose every sink is scrubbed. Commands receive this and cannot reach the raw one. */
export function scrubbedIo(io: CliIo, secrets: SecretRegistry): CliIo {
    return {
        ...io,
        out: (text) => io.out(secrets.scrub(text)),
        err: (text) => io.err(secrets.scrub(text)),
        ...(io.writeText ? { writeText: (path: string, text: string) => io.writeText!(path, secrets.scrub(text)) } : {}),
    }
}
