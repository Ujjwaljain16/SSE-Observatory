/**
 * Fixture families beyond the base set. Each family is its own file; add it here.
 */
import type { FixtureFamily } from './kit'
import { networkFamily } from './familyNetwork'
import { sequenceFamily } from './familySequence'
import { compareFamily } from './familyCompare'
import { driftFamily } from './familyDrift'

export const FAMILIES: FixtureFamily[] = [networkFamily, sequenceFamily, compareFamily, driftFamily]
