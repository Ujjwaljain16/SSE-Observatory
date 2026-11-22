import base from './playwright.config'
import { defineConfig } from '@playwright/test'

// The soak spec is left out of the normal run (it takes minutes). `npm run test:soak` uses this config, which is the normal one
// without that exclusion; asking for the file by name under the normal config finds no tests. The Chromium project has its own
// testIgnore (which replaces the top-level one), so it is cleared here as well.
export default defineConfig({ ...base, testIgnore: [], projects: base.projects?.filter((p) => p.name === 'chromium').map((p) => ({ ...p, testIgnore: [] })) })
