// Public surface of the diagnostics engine. Pure functions over observation records: no DOM, no sockets, no clock.

export { createEngine, analyze } from './engine'
export type { Engine, EngineOptions, AnalyzeOptions, Analysis, RuleCoverage } from './engine'
export { SEVERITY_RANK, maxSeverity } from './finding'
export type { Finding, FindingDraft, Fact, Deduction, Evidence, NextCheck, Severity, Confidence } from './finding'
export { DEFAULT_THRESHOLDS, resolveThresholds } from './thresholds'
export type { Thresholds, StreamProfile } from './thresholds'
export { StreamModel } from './streamModel'
export type { ClockDiscontinuityRecord, ConnectionState, EngineInput, GapInfo, HeartbeatSource, Mark } from './streamModel'
export { CAPABILITY_EVIDENCE } from './rule'
export type { Capability, Rule, RuleContext, RuleInstance } from './rule'
export { defaultRules, contentTypeAndStatus, framing, headersHints, firstEvent, stallSilent, heartbeat, credentialsInMetadata, clockDiscontinuity } from './rules'
