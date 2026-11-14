// What the CLI needs from its host, injected so every command can be tested in-process.

export interface CliIo {
    out(text: string): void
    err(text: string): void
    /** Read a file as UTF-8 text. */
    readText?(path: string): Promise<string>
    writeText?(path: string, text: string): Promise<void>
    /**
     * Writes a file exactly as given, without the scrub of known secrets that every other sink gets. Only the capture that `--no-redact` asks for
     * uses it, after scrubbing it field by field itself: a scrub of the finished text would cut into the base64 of the wire bytes and leave a file
     * that cannot be read.
     */
    writeRawText?(path: string, text: string): Promise<void>
    /** Replaces the secrets the command line knows about in a piece of text. Present on the io the commands get. */
    scrub?(text: string): string
    /** File names in a directory, for expanding `dir/*.json` where the shell does not (Windows). */
    listDir?(dir: string): Promise<string[]>
    /** Environment variables, by name. Secrets are passed this way, never on the command line. */
    env?: Record<string, string | undefined>
    /** Aborted when the user interrupts (Ctrl+C). */
    signal?: AbortSignal
}

/** Exit codes shared by every command. */
export const EXIT = {
    ok: 0,
    gateFailed: 1,
    usage: 2,
    couldNotRun: 3,
    inconclusive: 4,
    interrupted: 130,
} as const

/** A failure that ends the command with a message and an exit code. */
export class CliError extends Error {
    constructor(message: string, readonly exit: number = EXIT.usage) {
        super(message)
        this.name = 'CliError'
    }
}

export function requireFiles(io: CliIo): { readText(path: string): Promise<string>; writeText(path: string, text: string): Promise<void> } {
    if (!io.readText || !io.writeText) throw new CliError('File access is not available in this environment.', EXIT.couldNotRun)
    return { readText: io.readText, writeText: io.writeText }
}
