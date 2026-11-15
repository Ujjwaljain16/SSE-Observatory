// Is a capture's list of records what a recorder writes? One implementation, in plain JavaScript because the mock server (which does not run
// TypeScript) and the TypeScript core (the command line, the Doctor) must reach the same verdict on the same file. Types: integrity.d.ts.
//
// The rules (owner decision: a duplicate `seq` or a backwards `t` must not pass as healthy):
//   record.invalid   a record has no text `kind`, or its `seq` or `t` is not a finite number
//   seq.duplicate    a `seq` that an earlier record already has (anywhere before it)
//   seq.order        a `seq` lower than the previous record's, that is not a repeat (a repeat is reported as a duplicate)
//   t.backwards      a `t` lower than the previous record's. Equal is legal: several reads and events arrive in the same millisecond.
//
// A recorder cannot produce any of these: it numbers records from one counter and clamps `t` so it never decreases. A seq that skips numbers
// or does not start at 0 is legal (a trimmed window, records dropped by the memory cap), so those are not checked. An invalid record is
// reported and skipped for the comparisons, so it does not make its neighbours look wrong.

/** The list stops here: a hostile file must not make the answer as large as the file. */
export const MAX_CAPTURE_PROBLEMS = 1000

const isRecord = (r) => typeof r === 'object' && r !== null && !Array.isArray(r)

/** What a record needs to be one: the same test the file reader applies to every line. Returns a reason, or undefined when the record is fine. */
export function recordShapeProblem(r) {
    if (!isRecord(r) || typeof r.kind !== 'string' || typeof r.seq !== 'number' || typeof r.t !== 'number' || !Number.isFinite(r.seq) || !Number.isFinite(r.t)) {
        return 'a record needs "kind", "seq" and "t" (a text and two finite numbers)'
    }
    return undefined
}

/**
 * Checks the records in file order.
 * @param {ReadonlyArray<unknown>} records
 * @param {{ lines?: ReadonlyArray<number | undefined> }} [options] `lines[i]` is the line of `records[i]` in the file, when it came from one
 * @returns {Array<{ code: string, message: string, seq?: number, index: number, line?: number }>}
 */
export function validateCaptureIntegrity(records, options = {}) {
    const lines = options.lines
    const problems = []
    const where = (i) => (lines?.[i] !== undefined ? `line ${lines[i]}` : `record #${i + 1}`)
    const add = (code, message, index, seq) => {
        problems.push({ code, message, index, ...(seq !== undefined ? { seq } : {}), ...(lines?.[index] !== undefined ? { line: lines[index] } : {}) })
    }
    // A seq above every earlier one cannot be a repeat, so while the capture is healthy nothing is kept per record (a table of every seq held 1.2 million
    // entries and broke the documented 384 MB limit). Only once a seq does not rise is the table built, from the records before it, and kept from there on.
    let firstAt
    let maxSeq = -Infinity
    let prev
    let prevIndex = -1
    for (let i = 0; i < records.length && problems.length < MAX_CAPTURE_PROBLEMS; i++) {
        const r = records[i]
        const bad = recordShapeProblem(r)
        if (bad !== undefined) { add('record.invalid', `${where(i)}: ${bad}.`, i); continue }
        if (r.seq > maxSeq) {
            if (firstAt) firstAt.set(r.seq, i)
        } else {
            if (!firstAt) {
                firstAt = new Map()
                for (let j = 0; j < i; j++) if (recordShapeProblem(records[j]) === undefined && !firstAt.has(records[j].seq)) firstAt.set(records[j].seq, j)
            }
            const seen = firstAt.get(r.seq)
            if (seen !== undefined) add('seq.duplicate', `seq ${r.seq} is used twice: ${where(i)} repeats the seq of ${where(seen)}.`, i, r.seq)
            else {
                firstAt.set(r.seq, i)
                if (prev && r.seq < prev.seq) add('seq.order', `seq goes backwards at ${where(i)}: seq ${r.seq} follows seq ${prev.seq}.`, i, r.seq)
            }
        }
        if (r.seq > maxSeq) maxSeq = r.seq
        if (prev && r.t < prev.t && problems.length < MAX_CAPTURE_PROBLEMS) {
            add('t.backwards', `time goes backwards at seq ${r.seq} (${where(i)}): t=${r.t} ms follows t=${prev.t} ms (seq ${prev.seq}${lines?.[prevIndex] !== undefined ? `, line ${lines[prevIndex]}` : ''}).`, i, r.seq)
        }
        prev = r
        prevIndex = i
    }
    return problems
}

/** What a person is told about an invalid capture: what is wrong, where, and that nothing was concluded from it. Empty string when there is no problem. */
export function describeCaptureProblems(problems, shown = 5) {
    if (problems.length === 0) return ''
    const more = problems.length >= MAX_CAPTURE_PROBLEMS ? `${MAX_CAPTURE_PROBLEMS} or more` : String(problems.length)
    const head = `Invalid capture: ${more} problem${problems.length === 1 ? '' : 's'} in its records.`
    const list = problems.slice(0, shown).map((p) => `  - ${p.message}`)
    if (problems.length > shown) list.push(`  - and ${problems.length >= MAX_CAPTURE_PROBLEMS ? 'more' : `${problems.length - shown} more`}.`)
    return [
        head,
        ...list,
        'A capture needs a distinct, increasing seq on every record and a t that never goes backwards; a recorder cannot write anything else, so this file was edited, merged or written by something else. It was not analysed, so nothing can be said about the stream from it. Fix or re-record the capture.',
    ].join('\n')
}
