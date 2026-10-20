import type { Rule } from '../rule'
import { contentTypeAndStatus } from './r01ContentTypeStatus'
import { framing } from './r02Framing'
import { headersHints } from './r03HeadersHints'
import { firstEvent } from './r04FirstEvent'
import { stallSilent } from './r05StallSilent'
import { heartbeat } from './r10Heartbeat'
import { credentialsInMetadata } from './r12Credentials'
import { clockDiscontinuity } from './r15ClockDiscontinuity'
import { deliveryBursty } from './r06DeliveryBursty'
import { reconnectLoop } from './r07ReconnectLoop'
import { resumeLastEventId } from './r08ResumeLastEventId'
import { sequenceIntegrity } from './r09SequenceIntegrity'
import { consumerSlow } from './r11ConsumerSlow'
import { proxyMasking } from './r13ProxyMasking'

export { contentTypeAndStatus, framing, headersHints, firstEvent, stallSilent, heartbeat, credentialsInMetadata, clockDiscontinuity, deliveryBursty, reconnectLoop, resumeLastEventId, sequenceIntegrity, consumerSlow, proxyMasking }

/** Every rule shipped: R01-R13 and R15 (R14, comparing two captures, is `compareCaptures`). */
export const defaultRules: Rule[] = [
    contentTypeAndStatus, framing, headersHints, firstEvent, stallSilent, deliveryBursty, reconnectLoop, resumeLastEventId, sequenceIntegrity,
    heartbeat, consumerSlow, credentialsInMetadata, proxyMasking, clockDiscontinuity,
]
