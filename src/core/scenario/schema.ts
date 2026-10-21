/**
 * The JSON Schemas for scenario files and capture lines, written as TypeScript objects so the shared core can use them
 * without reading files. The same documents are published at docs/public/schemas/*.json for editors; a test keeps the
 * two in step, so this file is the single source of truth.
 *
 * Only the keywords listed in `Schema` are used. The built-in validator implements exactly these, and a test checks
 * the schemas against that list.
 */

/** The keyword subset the built-in validator understands. */
export interface Schema {
    $schema?: string
    $id?: string
    title?: string
    description?: string
    type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
    required?: readonly string[]
    enum?: readonly unknown[]
    const?: unknown
    properties?: { readonly [name: string]: Schema }
    /** `false` forbids unknown keys; a schema applies to every key that `properties` does not name. */
    additionalProperties?: boolean | Schema
    items?: Schema
    minimum?: number
    maximum?: number
    minLength?: number
    pattern?: string
    minProperties?: number
    maxProperties?: number
    oneOf?: readonly Schema[]
}

export const SCENARIO_SCHEMA_URL = 'https://sse-observatory.vercel.app/docs/schemas/sse-scenario-1.json'
export const CAPTURE_SCHEMA_URL = 'https://sse-observatory.vercel.app/docs/schemas/sse-capture-2.json'

const DRAFT = 'https://json-schema.org/draft/2020-12/schema'

/** `${ENV:NAME}`: where a secret or an environment-specific value goes. */
const PLACEHOLDER = '\\$\\{ENV:[A-Za-z_][A-Za-z0-9_]*\\}'

const severity: Schema = { type: 'string', enum: ['info', 'warning', 'error', 'critical'] }

const sequenceField: Schema = { type: 'string', pattern: '^\\$\\.\\S+$', description: 'JSON path into the event payload, starting with "$.".' }
const sequenceSseId: Schema = { type: 'boolean', const: true, description: 'Use the SSE id field as the sequence number.' }

const targetCommon = {
    headers: {
        type: 'object',
        description: 'Request headers. Secrets only as ${ENV:NAME} placeholders, for example "Bearer ${ENV:STREAM_TOKEN}".',
        additionalProperties: { type: 'string' },
    },
    sequence: {
        type: 'object',
        description: 'Where the stream numbers its events. Give either a JSON path into the payload or use_sse_id.',
        properties: {
            field: sequenceField,
            use_sse_id: sequenceSseId,
            policy: { type: 'string', enum: ['consecutive', 'monotonic'] },
        },
        required: ['policy'],
        additionalProperties: false,
        // Exactly one of the two. The branches repeat the property so that strict validators know the names.
        oneOf: [
            { properties: { field: sequenceField }, required: ['field'] },
            { properties: { use_sse_id: sequenceSseId }, required: ['use_sse_id'] },
        ],
    },
    delivery: { type: 'string', enum: ['at_least_once', 'exactly_once', 'at_most_once'] },
} satisfies Record<string, Schema>

const replay: Schema = {
    type: 'object',
    description: 'Replay a recorded capture instead of calling a live stream.',
    properties: {
        capture: { type: 'string', minLength: 1, description: 'Path of an .sse-capture file.' },
        honor_last_event_id: { type: 'boolean' },
        test_aids: {
            type: 'object',
            description: 'Faults the replay server injects so a resume can be tested.',
            properties: {
                drop_after: { type: 'integer', minimum: 1 },
                skip_ids: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
        },
    },
    required: ['capture'],
    additionalProperties: false,
}

const step = (key: string, value: Schema, extra: { readonly [name: string]: Schema } = {}): Schema => ({
    type: 'object',
    properties: { [key]: value, ...extra },
    required: [key],
    additionalProperties: false,
})

export const SCENARIO_SCHEMA: Schema = {
    $schema: DRAFT,
    $id: SCENARIO_SCHEMA_URL,
    title: 'SSE Observatory scenario',
    description: 'A repeatable check of an SSE stream: what to connect to, what to do, and what must hold afterwards.',
    type: 'object',
    properties: {
        $schema: { type: 'string' },
        version: { const: 1, description: 'Scenario format version.' },
        name: { type: 'string', minLength: 1 },
        target: {
            type: 'object',
            description: 'Either a url (live stream, fixture://ID, or ${ENV:NAME}) or a replay of a capture, not both.',
            oneOf: [
                {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            pattern: `^(?:${PLACEHOLDER}\\S*|https?://\\S+|fixture://[A-Za-z0-9_-]+(?:\\?[A-Za-z0-9_=&.%-]*)?)$`,
                            description: 'http(s) URL, fixture://ID (optionally ?scale=0.05 and the like), or ${ENV:NAME} (optionally followed by a path). No secrets in the query.',
                        },
                        ...targetCommon,
                    },
                    required: ['url'],
                    additionalProperties: false,
                },
                {
                    type: 'object',
                    properties: { replay, ...targetCommon },
                    required: ['replay'],
                    additionalProperties: false,
                },
            ],
        },
        expect: {
            type: 'object',
            properties: {
                status: { type: 'integer', minimum: 100, maximum: 599 },
                content_type: { type: 'string', minLength: 1 },
                first_event_within_ms: { type: 'integer', minimum: 1 },
            },
            additionalProperties: false,
        },
        steps: {
            type: 'array',
            description: 'Run in order. Each step is an object with one action key (collect_events may carry timeout_ms).',
            items: {
                type: 'object',
                oneOf: [
                    step('collect_events', { type: 'integer', minimum: 1 }, { timeout_ms: { type: 'integer', minimum: 1 } }),
                    step('disconnect', {
                        type: 'object',
                        properties: { mode: { type: 'string', enum: ['client', 'server'] } },
                        required: ['mode'],
                        additionalProperties: false,
                    }),
                    step('reconnect', {
                        type: 'object',
                        properties: {
                            after_ms: { type: 'integer', minimum: 0 },
                            resume_from_last_event_id: { type: 'boolean' },
                        },
                        additionalProperties: false,
                    }),
                    step('wait', {
                        type: 'object',
                        properties: { ms: { type: 'integer', minimum: 0 } },
                        required: ['ms'],
                        additionalProperties: false,
                    }),
                ],
            },
        },
        verify: {
            type: 'array',
            items: {
                description: 'A check name, or { "no_findings_at_or_above": "<severity>" }.',
                oneOf: [
                    { type: 'string', enum: ['no_unexplained_sequence_gaps', 'no_unexpected_duplicates', 'preserve_event_order'] },
                    {
                        type: 'object',
                        properties: { no_findings_at_or_above: severity },
                        required: ['no_findings_at_or_above'],
                        additionalProperties: false,
                        minProperties: 1,
                        maxProperties: 1,
                    },
                ],
            },
        },
        fail_on_severity: severity,
        allow_gaps: {
            type: 'array',
            description: 'Sequence ranges that may be missing without failing the check.',
            items: {
                type: 'object',
                properties: { from: { type: 'integer' }, to: { type: 'integer' } },
                required: ['from', 'to'],
                additionalProperties: false,
            },
        },
        meta: { type: 'object', description: 'Free-form notes. Ignored by the runner.' },
    },
    required: ['version', 'name', 'target', 'steps'],
    additionalProperties: false,
}

const nonNegInt: Schema = { type: 'integer', minimum: 0 }
const num: Schema = { type: 'number' }
const str: Schema = { type: 'string' }

/**
 * The size and payload fields of chunk and event records, including the ones only a local-full (b64) or sanitized (text)
 * capture has. Other fields differ per kind and a future kind may reuse a name with another type, so they are not
 * typed here: a record with kind, seq, t and conn is valid.
 */
const recordFields: { readonly [name: string]: Schema } = {
    bytes: nonNegInt, b64: str, text: str, dataBytes: nonNegInt, dataHash: str, data: str, payloadTruncated: { type: 'boolean' },
}

export const CAPTURE_SCHEMA: Schema = {
    $schema: DRAFT,
    $id: CAPTURE_SCHEMA_URL,
    title: 'SSE Observatory capture line',
    description:
        'One line of an .sse-capture v2 file (newline-delimited JSON). Line 1 is the header, the last line is the footer, ' +
        'every line between is a record. Validate each line on its own against this schema. Readers ignore header fields ' +
        'and record kinds they do not know, so extra properties are allowed and any record with kind, seq, t and conn is valid.',
    type: 'object',
    oneOf: [
        {
            type: 'object',
            description: 'Header line.',
            properties: {
                format: { const: 'sse-capture' },
                version: { type: 'string', pattern: '^2\\.\\d+$' },
                createdAt: { type: 'string', minLength: 1 },
                kind: { type: 'string', enum: ['local-full', 'sanitized'] },
                tool: { type: 'object', properties: { name: str, version: str }, required: ['name', 'version'] },
                analyzer: { type: 'object', properties: { version: str, rules: { type: 'object', additionalProperties: num } }, required: ['version', 'rules'] },
                source: {
                    type: 'object',
                    properties: { kind: { type: 'string', enum: ['browser-app', 'cli', 'fixture', 'import-v1'] }, client: str, synthetic: { type: 'boolean' } },
                    required: ['kind'],
                },
                clock: { type: 'object', properties: { origin: { const: 'monotonic' }, startedAtEpochMs: num }, required: ['origin'] },
                capabilities: { type: 'array', items: str },
                request: {
                    type: 'object',
                    properties: { url: str, method: str, headers: { type: 'object', additionalProperties: str }, viaProxy: { type: 'boolean' } },
                    required: ['url', 'method', 'headers'],
                },
                profile: { type: 'object' },
                redaction: {
                    type: 'object',
                    properties: { policy: str, version: nonNegInt, applied: { type: 'array', items: str }, placeholders: nonNegInt },
                    required: ['policy', 'version', 'applied', 'placeholders'],
                },
                limits: { type: 'object', properties: { capBytes: num, truncated: { type: 'boolean' } } },
                group: { type: 'object', properties: { groupId: str, laneIndex: nonNegInt }, required: ['groupId', 'laneIndex'] },
                captureId: str,
            },
            required: ['format', 'version', 'createdAt', 'kind', 'tool', 'source', 'clock', 'capabilities'],
        },
        {
            type: 'object',
            description: 'Record line: one observation. Unknown kinds are valid.',
            properties: {
                kind: { type: 'string', minLength: 1 },
                seq: nonNegInt,
                t: { type: 'number', minimum: 0 },
                conn: nonNegInt,
                domain: { type: 'string', enum: ['transport', 'page'] },
                ...recordFields,
            },
            required: ['kind', 'seq', 't', 'conn'],
        },
        {
            type: 'object',
            description: 'Footer line. Missing in a capture that crashed.',
            properties: {
                footer: {
                    type: 'object',
                    properties: {
                        endReason: { type: 'string', minLength: 1 },
                        counts: { type: 'object', additionalProperties: nonNegInt },
                        endT: { type: 'number', minimum: 0, description: 'When the recording stopped, in the clock of the records. Absent, the capture ends at its last record.' },
                        overhead: { type: 'object', additionalProperties: num },
                        integrity: {
                            type: 'object',
                            properties: { algorithm: { const: 'sha256' }, value: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
                            required: ['algorithm', 'value'],
                        },
                    },
                    required: ['endReason', 'counts'],
                },
            },
            required: ['footer'],
            additionalProperties: false,
        },
    ],
}
