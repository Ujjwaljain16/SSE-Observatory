import type { CliIo } from './io'
import { encodedForms } from './secretForms'

/**
 * Every secret the CLI resolves (from an environment variable or a header flag) is registered here, and every output
 * goes through `scrub()`: stdout, stderr, files, error messages and the text of failures that embed a URL. A value is
 * recognised by what it is, not by where it appears, so a secret that leaks into an unexpected place is still caught.
 *
 * Values shorter than MIN_LENGTH are not registered: replacing a 2-character value would damage unrelated text. The
 * caller is told, so it can warn the user.
 *
 * A text is scanned once for every form of every secret, the matches that overlap are joined, and each joined
 * span becomes one mask. So two secrets that overlap without one containing the other are both gone, and a mask is never
 * scanned again (a secret that happens to be a piece of the mask cannot cut into it).
 */

export const MIN_SECRET_LENGTH = 4
const MASK = '[REDACTED]'

export class SecretRegistry {
    private forms = new Set<string>()
    private index: { maxLength: number; byFirst: Map<string, string[]> } | null = null

    /** Returns false when the value is too short to scrub safely. */
    register(value: string | undefined): boolean {
        if (value === undefined || value === '') return true
        if (value.length < MIN_SECRET_LENGTH) return false
        const forms = new Set<string>([value, ...encodedForms(value)])
        // Basic auth sends user:password in Base64; a credential pair is registered both ways by the caller.
        // `Scheme value` (Bearer T, Token T): the value alone is the secret too, wherever it is echoed.
        const scheme = /^(?:Bearer|Basic|Token|Digest|ApiKey)\s+(\S{4,})$/i.exec(value)
        if (scheme) forms.add(scheme[1]!)
        for (const form of forms) if (form.length >= MIN_SECRET_LENGTH) this.forms.add(form)
        this.index = null
        return true
    }

    /** The [start, end) spans of `text` that hold a form, overlapping or touching ones joined, as a flat list: start, end, start, end... */
    private spans(text: string): number[] {
        const found: Array<[number, number]> = []
        for (const form of this.forms) {
            let from = text.indexOf(form)
            if (from < 0) continue
            let start = from
            let end = from + form.length
            for (from = text.indexOf(form, from + 1); from >= 0; from = text.indexOf(form, from + 1)) {
                if (from < end) end = from + form.length // the same form again, overlapping its own last match
                else { found.push([start, end]); start = from; end = from + form.length }
            }
            found.push([start, end])
        }
        if (found.length === 0) return []
        found.sort((a, b) => a[0] - b[0])
        const spans: number[] = []
        let [start, end] = found[0]!
        for (let i = 1; i < found.length; i++) {
            const [s, e] = found[i]!
            if (s < end) { if (e > end) end = e } else { spans.push(start, end); start = s; end = e }
        }
        spans.push(start, end)
        return spans
    }

    private render(text: string, spans: number[], upTo: number): string {
        let out = ''
        let at = 0
        for (let i = 0; i < spans.length && spans[i]! < upTo; i += 2) {
            out += text.slice(at, spans[i]!) + MASK
            at = spans[i + 1]!
        }
        return out + text.slice(at, upTo)
    }

    scrub(text: string): string {
        const spans = this.spans(text)
        return spans.length === 0 ? text : this.render(text, spans, text.length)
    }

    /**
     * For an output that is written in pieces. Returns what is safe to write now and what must wait for the next piece: the end of `text` when it
     * is the beginning of a form that the next piece could complete (a secret split over two writes), or a match that could still grow into one.
     * `scrub(hold)` is what remains to write when no piece follows.
     */
    scrubPiece(text: string): { emit: string; hold: string } {
        if (this.forms.size === 0) return { emit: text, hold: '' }
        const spans = this.spans(text)
        let hold = this.pendingFrom(text)
        for (let i = 0; i < spans.length; i += 2) if (spans[i]! < hold && spans[i + 1]! > hold) hold = spans[i]! // a match that reaches into the pending end is held whole
        if (hold >= text.length) return { emit: spans.length === 0 ? text : this.render(text, spans, text.length), hold: '' }
        return { emit: this.render(text, spans, hold), hold: text.slice(hold) }
    }

    /** Where the longest end of `text` that is a proper beginning of a form starts, or text.length when there is none. */
    private pendingFrom(text: string): number {
        if (!this.index) {
            const byFirst = new Map<string, string[]>()
            let maxLength = 0
            for (const form of this.forms) {
                maxLength = Math.max(maxLength, form.length)
                const list = byFirst.get(form[0]!)
                if (list) list.push(form); else byFirst.set(form[0]!, [form])
            }
            this.index = { maxLength, byFirst }
        }
        const { maxLength, byFirst } = this.index
        for (let at = Math.max(0, text.length - (maxLength - 1)); at < text.length; at++) {
            const candidates = byFirst.get(text[at]!)
            if (!candidates) continue
            const tail = text.slice(at)
            if (candidates.some((form) => form.length > tail.length && form.startsWith(tail))) return at
        }
        return text.length
    }

    get size(): number { return this.forms.size }
}

/** An io whose every sink is scrubbed. Commands receive this and cannot reach the raw one. */
export type ScrubbedIo = CliIo & {
    /** Writes what an output is still holding back (the end of a write that could have been the start of a secret). Call it when the command is done. */
    flush(): void
}

/**
 * What a sink writes is scrubbed together with what the previous write left that could be the start of a secret, so a value written in two pieces is
 * caught. A write that does not end in the beginning of a secret goes out at once, as before; one that does is delayed until the next write or flush().
 */
export function scrubbedIo(io: CliIo, secrets: SecretRegistry): ScrubbedIo {
    const sink = (write: (text: string) => void) => {
        let held = ''
        return {
            write(text: string) {
                const { emit, hold } = secrets.scrubPiece(held + text)
                held = hold
                if (emit !== '' || (hold === '' && text === '')) write(emit)
            },
            flush() {
                if (held === '') return
                const rest = secrets.scrub(held)
                held = ''
                write(rest)
            },
        }
    }
    const out = sink((text) => io.out(text))
    const err = sink((text) => io.err(text))
    return {
        ...io,
        scrub: (text) => secrets.scrub(text),
        out: (text) => out.write(text),
        err: (text) => err.write(text),
        flush: () => { out.flush(); err.flush() },
        ...(io.writeText ? { writeText: (path: string, text: string) => io.writeText!(path, secrets.scrub(text)), writeRawText: (path: string, text: string) => io.writeText!(path, text) } : {}),
    }
}
