// Public surface of the shared core: this is what the generated sse-doctor package exports and what its type
// declarations are built from (tsconfig.dts.json). Everything here must run without a DOM.

export { SSEParser, SSEParserError } from './sse/sseParser'
export type { SSEMessage, SSEParserHandlers, SSEViolation } from './sse/sseParser'
export { SSEClient } from './sse/sseClient'
export type { SSEClientOptions, SSEPhase, SSEPhaseInfo, SSERequestInit } from './sse/sseClient'
export { VIOLATIONS, violationSeverity } from './sse/violations'
export type { ViolationCode, ViolationSeverity, ParserViolationCode } from './sse/violations'

export { performanceClock } from './clock'
export type { Clock } from './clock'
export { Recorder } from './observe/recorder'
export type { RecorderOptions } from './observe/recorder'
export { redactUrl } from './observe/redactUrl'
export { DIAGNOSTIC_RESPONSE_HEADERS } from './observe/observation'
export type { Observation, ObservationBody, ObservationDraft, ObservationKind, Mono, Stamp } from './observe/observation'
