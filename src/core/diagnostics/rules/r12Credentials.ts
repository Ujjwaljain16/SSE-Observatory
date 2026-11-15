import type { Evidence } from '../finding'
import type { Rule } from '../rule'
import { ev, plural } from './util'

/**
 * R12 security.credentials-in-metadata: credential-looking query PARAMETER NAMES in the request URL.
 *
 * The recorder already replaced every query value with a placeholder, so this rule only sees names, and it only ever
 * prints names. It cannot recognise a secret by the shape of its value. Request and response header values are not
 * recorded at all, so Authorization, Cookie, X-API-Key and Set-Cookie are not evaluated; the limits say so.
 */

const normalise = (name: string): string => name.toLowerCase().replace(/[-_]/g, '')

function paramNames(url: string): string[] {
    const query = url.split('?')[1] ?? ''
    const names: string[] = []
    for (const pair of query.split('&')) {
        const raw = pair.split('=')[0]
        if (!raw) continue
        try { names.push(decodeURIComponent(raw)) } catch { names.push(raw) }
    }
    return names
}

export const credentialsInMetadata: Rule = {
    id: 'security.credentials-in-metadata',
    version: 1,
    title: 'Credentials in request metadata',
    requires: ['connect'],
    create({ thresholds }) {
        const wanted = new Set(thresholds.credentialParamNames.map(normalise))
        const found = new Set<string>()
        const evidence: Evidence[] = []
        let count = 0
        let firstSeenT = 0
        return {
            onObservation(o) {
                if (o.kind !== 'connect') return
                const hits = [...new Set(paramNames(o.url))].filter((n) => wanted.has(normalise(n)))
                if (hits.length === 0) return
                if (count === 0) firstSeenT = o.t
                count++
                hits.forEach((n) => found.add(n))
                if (evidence.length < 5) evidence.push(ev(o.seq, o.t, 'request URL'))
                const names = [...found].sort()
                return [{
                    key: 'security.credentials-in-metadata:url',
                    severity: 'warning',
                    title: 'Credential in the request URL',
                    summary: `The request URL carries ${plural(names.length, 'credential-like parameter')} (${names.join(', ')}). URLs end up in logs, proxies and browser history.`,
                    facts: [{ text: `The request URL has the query ${names.length === 1 ? 'parameter' : 'parameters'}: ${names.join(', ')}. Values are not shown.`, evidence: [...evidence] }],
                    deductions: [{ statement: 'Likely: a secret is passed in the URL; it can leak into server and proxy logs, referrers and history.', confidence: 'medium', basis: evidence.map((e) => e.seq), alternatives: ['The parameter is a public identifier rather than a secret.', 'A short-lived single-use ticket, which limits the damage.'] }],
                    nextCheck: { description: 'Send the credential in an Authorization header (fetch-based client) or exchange it for a short-lived, single-use ticket.' },
                    limits: [
                        'Only parameter names are checked; query values are redacted when recorded, so a secret cannot be recognised by the shape of its value.',
                        'Request and response header values (Authorization, Cookie, X-API-Key, Set-Cookie) are not recorded and are not evaluated.',
                        'Event payloads are not scanned by this rule.',
                    ],
                    status: 'open', firstSeenT, lastSeenT: o.t, occurrences: count,
                }]
            },
            coverage() {
                return { evaluated: true, notes: ['Request and response header values are not recorded, so Authorization, Cookie, X-API-Key and Set-Cookie are not evaluated.'] }
            },
        }
    },
}
