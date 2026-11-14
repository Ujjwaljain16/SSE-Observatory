/**
 * Fixture families beyond the base set. Each family is its own file; add it here.
 */
import type { FixtureFamily } from './kit'
import { networkFamily } from './familyNetwork'
import { sequenceFamily } from './familySequence'
import { compareFamily } from './familyCompare'
import { driftFamily } from './familyDrift'
import { echoFamily } from './familyEcho'
import { moreFamily } from './familyMore'

export const FAMILIES: FixtureFamily[] = [networkFamily, sequenceFamily, compareFamily, driftFamily, echoFamily, moreFamily]
