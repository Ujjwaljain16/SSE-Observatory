import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    testIgnore: '**/soak.spec.ts',
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: 1,
    reporter: 'html',
    use: {
        baseURL: 'http://localhost:3001',
        trace: 'on-first-retry',
        viewport: { width: 1280, height: 900 },
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
        // Opt in with E2E_BROWSERS=firefox,webkit (and `npx playwright install firefox webkit`); the default run is Chromium only.
        ...(['firefox', 'webkit'] as const)
            .filter((name) => (process.env['E2E_BROWSERS'] ?? '').split(',').includes(name))
            .map((name) => ({ name, use: { ...devices[name === 'firefox' ? 'Desktop Firefox' : 'Desktop Safari'] } })),
    ],
    webServer: [
        {
            command: 'npm run dev',
            url: 'http://localhost:3001',
            reuseExistingServer: true,
        },
        {
            // Run our chaos server alongside the dev server for testing
            command: 'node test-servers/test-chaos-server.js',
            url: 'http://localhost:4000/chaos-stream',
            reuseExistingServer: true,
        }
    ],
});
