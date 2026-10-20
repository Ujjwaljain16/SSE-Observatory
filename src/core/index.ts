// Public surface of the shared core: this is what the generated sse-doctor package exports and what its type
// declarations are built from (tsconfig.dts.json). Everything here must run without a DOM.

export { SSEParser, SSEParserError } from './sse/sseParser'
export type { SSEMessage, SSEParserHandlers } from './sse/sseParser'
export { SSEClient } from './sse/sseClient'
export type { SSEClientOptions, SSEPhase, SSEPhaseInfo, SSERequestInit } from './sse/sseClient'
