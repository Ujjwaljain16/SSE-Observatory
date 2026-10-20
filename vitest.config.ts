import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react() as never],
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: './src/test/setup.ts',
        include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
        exclude: ['e2e/**/*', 'node_modules/**/*'],
        coverage: {
            provider: 'v8',
            reporter: ['text-summary', 'html', 'lcov'],
            // Measure everything we ship, not only the files tests happen to import.
            include: ['src/**/*.{ts,tsx}', 'lib/**/*.js'],
            exclude: ['src/**/*.test.*', 'src/**/__tests__/**', 'src/test/**', 'src/perf/**', 'src/tests/**', 'src/types/**'],
            // Ratchet: set just under the current level (66.6% statements, 49.1% branches) so coverage can only go up.
            thresholds: { lines: 65, statements: 64, functions: 50, branches: 47 },
        },
    },
})
