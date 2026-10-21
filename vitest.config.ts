import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Two projects: the React app runs under jsdom, while src/core, src/cli and src/fixtures run in plain Node. Core must
// work without a DOM (it is shared with the CLI), so its tests must not be able to pass by accident because jsdom
// happened to supply `window`.
const NODE_DIRS = ['src/core/**', 'src/cli/**', 'src/fixtures/**']
const TEST_FILES = '*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'

export default defineConfig({
    plugins: [react() as never],
    test: {
        globals: true,
        coverage: {
            provider: 'v8',
            reporter: ['text-summary', 'html', 'lcov'],
            // Measure everything we ship, not only the files tests happen to import.
            include: ['src/**/*.{ts,tsx}', 'lib/**/*.js'],
            exclude: ['src/**/*.test.*', 'src/**/__tests__/**', 'src/test/**', 'src/perf/**', 'src/tests/**', 'src/types/**', 'src/core/testing/**', 'src/cli/bin.ts', 'src/fixtures/**'],
            // Ratchet: set just under the current level (80.9% statements, 66.9% branches, 71.6% functions, 82.7% lines) so coverage can only go up.
            // The Doctor's React components are covered by the Playwright specs, not by unit tests, which is why these are not higher.
            thresholds: { lines: 82, statements: 80, functions: 71, branches: 66 },
        },
        projects: [
            {
                extends: true,
                test: {
                    name: 'dom',
                    environment: 'jsdom',
                    setupFiles: ['./src/test/setup.ts'],
                    include: [`src/**/${TEST_FILES}`],
                    exclude: ['e2e/**/*', 'node_modules/**/*', ...NODE_DIRS],
                },
            },
            {
                extends: true,
                test: {
                    name: 'node',
                    environment: 'node',
                    include: NODE_DIRS.map((dir) => `${dir}/${TEST_FILES}`),
                    exclude: ['e2e/**/*', 'node_modules/**/*'],
                },
            },
        ],
    },
})
