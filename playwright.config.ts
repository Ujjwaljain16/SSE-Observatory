import { defineConfig, devices } from '@playwright/test';

// Load and memory tests: they measure Chromium (heap numbers, CDP) and push 20,000 events a second through the page. On a
// shared CI runner they exhaust a software-rendered Firefox or WebKit, and every test after them then times out on its first
// click (seen in CI: 5 failed and 10 flaky in 42 minutes, while the same suite passes locally). Firefox and WebKit run the
// behavioural suite; the heavy tests stay in Chromium. The reconnect storm (network dropped and restored on several streams) is
// excluded for the same reason: in CI every test after it in Firefox and WebKit failed, while it passes locally in both.
const HEAVY = /simultaneous network reconnects|stress test|high-speed event burst|30 second heavy stream|massive event bursts|burst stream of 20k|1MB\+ massive payloads|rapid event insertion/

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
            .map((name) => ({ name, grepInvert: HEAVY, use: { ...devices[name === 'firefox' ? 'Desktop Firefox' : 'Desktop Safari'] } })),
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
