import type { Rule } from '../rule'
import { contentTypeAndStatus } from './r01ContentTypeStatus'
import { framing } from './r02Framing'
import { headersHints } from './r03HeadersHints'
import { firstEvent } from './r04FirstEvent'
import { stallSilent } from './r05StallSilent'
import { heartbeat } from './r10Heartbeat'
import { credentialsInMetadata } from './r12Credentials'
import { clockDiscontinuity } from './r15ClockDiscontinuity'

export { contentTypeAndStatus, framing, headersHints, firstEvent, stallSilent, heartbeat, credentialsInMetadata, clockDiscontinuity }

/** The rules shipped so far (R01-R05, R10, R12, R15). */
export const defaultRules: Rule[] = [contentTypeAndStatus, framing, headersHints, firstEvent, stallSilent, heartbeat, credentialsInMetadata, clockDiscontinuity]
