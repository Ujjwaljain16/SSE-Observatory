/**
 * What the SSE parser and client notice about a stream, and how serious it is.
 *
 * Severity follows the WHATWG spec (https://html.spec.whatwg.org/multipage/server-sent-events.html), not our taste:
 *  - `error`   a conforming EventSource would fail the connection, so the stream cannot work as served.
 *  - `warning` the spec defines how to handle it, but data is lost or the cause is probably a producer mistake.
 *  - `info`    the spec says to ignore or normalise it. Worth seeing, never called an error.
 */

export type ViolationSeverity = 'info' | 'warning' | 'error'

export const VIOLATIONS = {
    // error: a conforming client fails the connection
    BAD_CONTENT_TYPE: { severity: 'error', note: 'The response is not text/event-stream, so a conforming EventSource fails the connection.' },
    HTTP_STATUS_NOT_200: { severity: 'error', note: 'The response status is not 200, so a conforming EventSource fails the connection (204 means stop reconnecting).' },
    EVENT_TOO_LONG: { severity: 'error', note: 'One event grew past this client\'s safety limit without ending (many short lines and no blank line), so the stream was abandoned. This is the client\'s limit, not a spec rule.' },
    LINE_TOO_LONG: { severity: 'error', note: 'A single line exceeded this client\'s safety limit, so the stream was abandoned. This is the client\'s limit, not a spec rule.' },

    // warning: handled by the spec, but data is lost or a producer mistake is likely
    UNTERMINATED_FRAME: { severity: 'warning', note: 'The connection ended in the middle of an event. The spec discards an incomplete event, so its data was dropped.' },
    NUL_IN_ID: { severity: 'warning', note: 'An id field contained a NUL character. The spec ignores that id, so the last event id did not advance.' },
    WRONG_CASE_FIELD: { severity: 'warning', note: 'A field name matches a known field except for its case (for example "Data:"). Field names are case-sensitive, so the spec ignores the line; this is usually a producer bug.' },

    // info: ignored or normalised by the spec
    UNKNOWN_FIELD: { severity: 'info', note: 'An unknown field name. The spec ignores it.' },
    INVALID_RETRY: { severity: 'info', note: 'A retry field that is not a plain number of milliseconds. The spec ignores it.' },
    ID_ONLY_FRAME: { severity: 'info', note: 'An event with an id but no data. It moves the last event id but dispatches nothing.' },
    FRAME_WITHOUT_DATA: { severity: 'info', note: 'An event with fields but no data. The spec dispatches nothing for it.' },
    LINE_NO_COLON: { severity: 'info', note: 'A line with no colon. The spec treats the whole line as a field name with an empty value.' },
    MIXED_LINE_ENDINGS: { severity: 'info', note: 'The stream mixes line ending styles (LF, CRLF, CR). All three are valid.' },
    BOM_STRIPPED: { severity: 'info', note: 'A UTF-8 byte order mark at the start of the stream, which the spec strips.' },
    BOM_MIDSTREAM: { severity: 'info', note: 'A byte order mark at the start of a line after the stream began. It is only stripped at the very start, so this line is treated as an unknown field.' },
} as const satisfies Record<string, { severity: ViolationSeverity; note: string }>

export type ViolationCode = keyof typeof VIOLATIONS

/** The codes the parser itself can raise (the others come from the HTTP layer in the client). */
export type ParserViolationCode = Exclude<ViolationCode, 'BAD_CONTENT_TYPE' | 'HTTP_STATUS_NOT_200'>

export const violationSeverity = (code: ViolationCode): ViolationSeverity => VIOLATIONS[code].severity
