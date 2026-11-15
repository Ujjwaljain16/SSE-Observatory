import type { Evidence, FindingDraft } from '../finding'
import type { Rule, RuleContext } from '../rule'
import { ev, plural } from './util'

/**
 * R08 resume.last-event-id: what happened to the stream's cursor across each reconnect.
 *
 * Without a sequence contract it reports only what can be seen: whether Last-Event-ID was sent, whether the server
 * seems to have ignored it (the stream started over), how many events were replayed, and ids that look regenerated per
 * connection. It never claims events were missed. With a declared contract, a jump on the first event after a reconnect
 * is reported as skipped events (the jump belongs here, not to the gap check of R09, because the resume caused it).
 */

const ID_WINDOW = 4096
const TAIL = 5

interface Conn {
    sentId: string
    connect?: Evidence | undefined
    first?: { id: string; ref: Evidence; seq: number | undefined; partition: string } | undefined
    replayed: number
    replaying: boolean
    /** The last few (payload, id) pairs of the connections before this one, when this connection began. */
    tail: Array<{ hash: string; id: string }>
    events: number
}

export const resumeLastEventId: Rule = {
    id: 'resume.last-event-id',
    version: 1,
    title: 'Resume with Last-Event-ID',
    requires: ['events', 'reconnects'],
    create({ profile }: RuleContext) {
        const contract = profile.sequence && (profile.sequence.field || profile.sequence.useSseId) ? profile.sequence : undefined
        const conns = new Map<number, Conn>()
        const idsSeen = new Set<string>()
        // The newest events across connections, to compare a new connection's first events against.
        const recent: Array<{ hash: string; id: string }> = []
        const lastSeqBefore = new Map<string, { value: number; ref: Evidence }>()
        let streamFirstId: string | undefined
        let anyId = false
        let lastConn = -1
        let reconnects = 0

        const notSent: Evidence[] = []
        const ignored: Evidence[] = []
        const skipped: Array<{ from: number; to: number; before: Evidence; after: Evidence }> = []
        let replayedTotal = 0
        const replayEvidence: Evidence[] = []
        let syntheticTotal = 0
        const syntheticEvidence: Evidence[] = []

        const connOf = (i: number): Conn => {
            let c = conns.get(i)
            if (!c) { c = { sentId: '', replayed: 0, replaying: i > 0, tail: recent.slice(), events: 0 }; conns.set(i, c) }
            return c
        }

        const base = (t: number, count: number) => ({ status: 'open' as const, firstSeenT: t, lastSeenT: t, occurrences: count })

        const drafts = (t: number): FindingDraft[] => {
            const out: FindingDraft[] = []
            if (notSent.length > 0) {
                const text = `${plural(notSent.length, 'reconnect')} did not send Last-Event-ID although earlier events carried ids.`
                out.push({
                    key: 'resume.last-event-id:not-sent', severity: 'warning', title: 'Last-Event-ID not sent', summary: text, facts: [{ text, evidence: notSent }],
                    deductions: [{ statement: 'Likely: the client does not track the last id, so every reconnect starts from the server\'s default position.', confidence: 'medium', basis: notSent.map((e) => e.seq), alternatives: ['The client reset its cursor on purpose.'] }],
                    limits: ['A browser EventSource sends the header by itself; custom clients must do it.'], ...base(t, notSent.length),
                })
            }
            if (ignored.length > 0) {
                const text = `After ${plural(ignored.length, 'reconnect')} that sent a Last-Event-ID, the stream began again from its first id.`
                out.push({
                    key: 'resume.last-event-id:ignored', severity: 'warning', title: 'Server seems to ignore Last-Event-ID', summary: text, facts: [{ text, evidence: ignored }],
                    deductions: [{ statement: 'Likely: the server ignored Last-Event-ID and restarted the stream.', confidence: 'medium', basis: ignored.map((e) => e.seq), alternatives: ['The producer\'s history was reset (a restart) and numbering began again.', 'The id sent was older than the history the server keeps.'] }],
                    nextCheck: { description: 'Send the request with a Last-Event-ID of a recent id and see whether the first event is the next one.' },
                    limits: ['Rests on the first id after the reconnect equalling the first id of the stream.'], ...base(t, ignored.length),
                })
            }
            if (replayedTotal > 0) {
                const text = `${plural(replayedTotal, 'event')} were sent again after reconnects (ids already seen).`
                out.push({
                    key: 'resume.last-event-id:overlap', severity: 'info', title: 'Events replayed after reconnect', summary: text, facts: [{ text, evidence: replayEvidence }],
                    deductions: [], limits: ['Normal when a server resumes slightly before the cursor (at-least-once delivery). Consumers should tolerate repeats.'], ...base(t, replayedTotal),
                })
            }
            if (syntheticTotal >= 2) {
                const text = `${plural(syntheticTotal, 'event')} came again with identical data but a new id on a later connection.`
                out.push({
                    key: 'resume.last-event-id:synthetic-ids', severity: 'warning', title: 'Ids change on every connection', summary: text, facts: [{ text, evidence: syntheticEvidence }],
                    deductions: [{ statement: 'Likely: the server assigns ids per connection (a counter or a random value), so Last-Event-ID cannot identify a position.', confidence: 'medium', basis: syntheticEvidence.map((e) => e.seq), alternatives: ['The same data was legitimately produced twice.'] }],
                    limits: ['Payload hashes show equal data, not that it is the same event.'], ...base(t, syntheticTotal),
                })
            }
            if (skipped.length > 0) {
                const lost = skipped.reduce((n, s) => n + (s.to - s.from + 1), 0)
                const text = `The stream resumed ${plural(skipped.length, 'time')} past events: ${plural(lost, 'number')} between the last event before a reconnect and the first after it never arrived (${skipped.slice(0, 5).map((s) => (s.from === s.to ? `${s.from}` : `${s.from}-${s.to}`)).join(', ')}).`
                const evidence = skipped.flatMap((s) => [s.before, s.after]).slice(0, 10)
                out.push({
                    key: 'resume.last-event-id:skipped', severity: 'error', title: 'Reconnect skipped events', summary: text,
                    data: { ranges: skipped.slice(0, 1000).map((s) => ({ from: s.from, to: s.to })), truncated: skipped.length > 1000 },
                    facts: [{ text, evidence }, { text: `The stream declares its numbering as ${contract?.policy} (${contract?.useSseId ? 'the SSE id' : contract?.field}).`, evidence: [] }],
                    deductions: [{ statement: 'Likely: the server\'s resume history was shorter than the time offline, or the resume started after the cursor.', confidence: 'medium', basis: evidence.map((e) => e.seq), alternatives: ['The numbers were never produced (the producer skipped them).', 'Events were dropped between the producer and the server while the client was away.'] }],
                    nextCheck: { description: 'Ask the server for the same Last-Event-ID again, or compare with the producer log for those numbers.' },
                    limits: ['Only a declared sequence contract lets a jump count as loss.'], ...base(t, skipped.length),
                })
            }
            return out
        }

        return {
            onObservation(o) {
                if (o.kind === 'connect' && o.conn > 0) {
                    const c = connOf(o.conn)
                    c.sentId = o.sentLastEventId
                    c.connect = ev(o.seq, o.t, 'reconnect request')
                    if (o.sentLastEventId === '' && anyId) { notSent.push(c.connect); reconnects++; return drafts(o.t) }
                    reconnects++
                    return
                }
                if (o.kind !== 'event') return
                const c = connOf(o.conn)
                let changed = false
                const id = o.sseId
                const ref = ev(o.seq, o.t)

                if (o.conn !== lastConn) lastConn = o.conn
                if (c.first === undefined) {
                    const raw = o.extracted?.seq
                    const seqValue = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d{1,15}$/.test(raw) ? Number(raw) : undefined
                    c.first = { id, ref, seq: seqValue, partition: o.extracted?.partition ?? '' }
                    if (o.conn === 0) streamFirstId = id !== '' ? id : undefined
                    else if (c.sentId !== '' && streamFirstId !== undefined && id === streamFirstId && id !== c.sentId) { ignored.push(ref); changed = true; c.replaying = false }
                }

                if (o.conn > 0 && c.replaying && id !== '') {
                    if (idsSeen.has(id)) { c.replayed++; replayedTotal++; if (replayEvidence.length < 10) replayEvidence.push(ref); changed = true } else c.replaying = false
                }

                // Ids regenerated per connection: the first events of a new connection repeat the data of the old tail under new ids.
                // Streams whose payloads are all identical (a constant tick) prove nothing, so the tail must contain different data.
                if (o.conn > 0 && c.events < TAIL && o.dataHash && id !== '' && new Set(c.tail.map((x) => x.hash)).size >= 2) {
                    if (c.tail.some((x) => x.hash === o.dataHash && x.id !== id) && !idsSeen.has(id)) { syntheticTotal++; if (syntheticEvidence.length < 10) syntheticEvidence.push(ref); changed = true }
                }
                c.events++

                if (contract?.policy === 'consecutive' && o.conn > 0 && c.first.ref.seq === o.seq && c.first.seq !== undefined) {
                    const prev = lastSeqBefore.get(c.first.partition)
                    if (prev && c.first.seq > prev.value + 1) { skipped.push({ from: prev.value + 1, to: c.first.seq - 1, before: prev.ref, after: ref }); changed = true }
                }

                // Remember this event for the next reconnect. The cursor memory is updated after the checks above.
                if (id !== '') {
                    anyId = true
                    idsSeen.add(id)
                    if (idsSeen.size > ID_WINDOW) idsSeen.delete(idsSeen.values().next().value as string)
                }
                if (o.dataHash && id !== '') { recent.push({ hash: o.dataHash, id }); if (recent.length > TAIL) recent.shift() }
                const raw = o.extracted?.seq
                const seqNow = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d{1,15}$/.test(raw) ? Number(raw) : undefined
                if (seqNow !== undefined) {
                    const key = o.extracted?.partition ?? ''
                    const prev = lastSeqBefore.get(key)
                    // The cursor to compare against is the highest number from earlier connections, so a replayed lower number does not move it back.
                    if (!prev || o.conn === lastConn) lastSeqBefore.set(key, { value: prev ? Math.max(prev.value, seqNow) : seqNow, ref })
                }
                return changed ? drafts(o.t) : undefined
            },
            coverage() {
                if (reconnects === 0) return { evaluated: true, notes: ['The stream did not reconnect, so there was no resume to judge.'] }
                return { evaluated: true, notes: contract ? [] : ['Skipped events cannot be judged: no sequence contract is declared. Only what the reconnects themselves show is reported.'] }
            },
        }
    },
}
