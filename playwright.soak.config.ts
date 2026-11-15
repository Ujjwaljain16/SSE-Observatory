import base from './playwright.config'
import { defineConfig } from '@playwright/test'

// The soak spec is left out of the normal run (it takes minutes). `npm run test:soak` uses this config, which is the normal one
// without that exclusion; asking for the file by name under the normal config finds no tests.
export default defineConfig({ ...base, testIgnore: [], projects: base.projects?.filter((p) => p.name === 'chromium') })
