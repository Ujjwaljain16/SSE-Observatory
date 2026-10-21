/**
 * Text from a stream or a file is untrusted. Before it reaches a terminal, a log or an XML report it has its control
 * characters replaced with a visible `\uXXXX`: an escape sequence from a server could otherwise move the cursor, set the
 * window title or write to the clipboard of whoever runs the tool, and a NUL or other C0 character makes a JUnit file
 * invalid XML so the CI step that reads it fails.
 *
 * Tab, line feed and carriage return are kept (they are text); everything else below U+0020, DEL and the C1 range, the
 * two noncharacters XML forbids, and an unpaired surrogate are replaced.
 */

// eslint-disable-next-line no-control-regex -- matching the control characters is the point
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export function sanitizeText(text: string): string {
    return text.replace(UNSAFE, (ch) => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
}
