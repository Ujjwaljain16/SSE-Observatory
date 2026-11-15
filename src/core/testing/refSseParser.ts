/**
 * A reference implementation of the server-sent events parsing algorithm, written to be as plainly like the specification as it can be and
 * for nothing else: it takes the whole stream at once, has no chunk handling, no limits and no diagnostics, and shares no code with the
 * incremental parser. Its only job is to be an independent opinion in tests: if the two ever disagree about what a stream means, one of them
 * is wrong, and the specification decides which.
 *
 * The steps quoted are those of https://html.spec.whatwg.org/multipage/server-sent-events.html ("Parsing an event stream" and "Interpreting an
 * event stream"), in the wording of the specification, shortened.
 */

export interface RefEvent {
    /** The event type: "message" unless an `event` field set another. */
    type: string
    data: string
    /** The last event ID string at the time the event was dispatched. */
    lastEventId: string
}

export interface RefResult {
    events: RefEvent[]
    /** Every reconnection time the stream set, in order. */
    retries: number[]
}

/**
 * "The stream must be decoded using UTF-8 decode without BOM" ... "One leading U+FEFF BOM is removed": TextDecoder with its defaults
 * does exactly that, once, for a whole buffer, and replaces invalid bytes with U+FFFD.
 */
export function decodeStream(bytes: Uint8Array): string {
    return new TextDecoder('utf-8').decode(bytes)
}

/**
 * "Lines must be separated by either a U+000D CARRIAGE RETURN U+000A LINE FEED (CRLF) character pair, a single U+000A LINE FEED (LF)
 * character, or a single U+000D CARRIAGE RETURN (CR) character." A last line with no line ending after it is never a line: "Once the end of
 * the file is reached, any pending data must be discarded."
 */
export function splitLines(text: string): string[] {
    const lines: string[] = []
    let current = ''
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!
        if (ch === '\r') {
            lines.push(current)
            current = ''
            if (text[i + 1] === '\n') i++ // CRLF is one line ending
        } else if (ch === '\n') {
            lines.push(current)
            current = ''
        } else current += ch
    }
    return lines // `current` is the unterminated last line, if any: discarded
}

export function parseStream(text: string): RefResult {
    // "Set the data buffer, the event type buffer and the last event ID buffer to the empty string" at the start; the last event ID *string* too.
    let dataBuffer = ''
    let eventTypeBuffer = ''
    let lastEventIdBuffer = ''
    let lastEventIdString = ''
    const events: RefEvent[] = []
    const retries: number[] = []

    const dispatch = (): void => {
        // "1. Set the last event ID string of the event source to the value of the last event ID buffer."
        lastEventIdString = lastEventIdBuffer
        // "2. If the data buffer is an empty string, set the data buffer and the event type buffer to the empty string and return."
        if (dataBuffer === '') { dataBuffer = ''; eventTypeBuffer = ''; return }
        // "3. If the data buffer's last character is a U+000A LINE FEED (LF) character, then remove the last character from the data buffer."
        if (dataBuffer.endsWith('\n')) dataBuffer = dataBuffer.slice(0, -1)
        // "6. If the event type buffer has a value other than the empty string, change the type of the newly created event to its value."
        events.push({ type: eventTypeBuffer !== '' ? eventTypeBuffer : 'message', data: dataBuffer, lastEventId: lastEventIdString })
        // "7. Set the data buffer and the event type buffer to the empty string."
        dataBuffer = ''
        eventTypeBuffer = ''
    }

    for (const line of splitLines(text)) {
        // "If the line is empty (a blank line): Dispatch the event."
        if (line === '') { dispatch(); continue }
        // "If the line starts with a U+003A COLON character (:): Ignore the line."
        if (line.startsWith(':')) continue
        let field: string
        let value: string
        const colon = line.indexOf(':')
        if (colon !== -1) {
            // "Collect the characters on the line before the first U+003A COLON character (:), and let field be that string.
            //  Collect the characters on the line after the first U+003A COLON character (:), and let value be that string.
            //  If value starts with a U+0020 SPACE character, remove it from value."
            field = line.slice(0, colon)
            value = line.slice(colon + 1)
            if (value.startsWith(' ')) value = value.slice(1)
        } else {
            // "Otherwise, the string is not empty but does not contain a U+003A COLON character (:): Process the field using the whole line as the field name, and the empty string as the field value."
            field = line
            value = ''
        }
        switch (field) {
            case 'event':
                eventTypeBuffer = value
                break
            case 'data':
                // "Append the field value to the data buffer, then append a single U+000A LINE FEED (LF) character to the data buffer."
                dataBuffer += value + '\n'
                break
            case 'id':
                // "If the field value does not contain U+0000 NULL, then set the last event ID buffer to the field value. Otherwise, ignore the field."
                if (!value.includes('\u0000')) lastEventIdBuffer = value
                break
            case 'retry':
                // "If the field value consists of only ASCII digits, then interpret the field value as an integer in base ten, and set the event stream's reconnection time to that integer. Otherwise, ignore the field."
                if (/^[0-9]+$/.test(value)) retries.push(Number(value))
                break
            default:
                // "Otherwise: The field is ignored."
                break
        }
    }
    return { events, retries }
}

/** The whole algorithm on a byte stream. */
export function parseBytes(bytes: Uint8Array): RefResult {
    return parseStream(decodeStream(bytes))
}
