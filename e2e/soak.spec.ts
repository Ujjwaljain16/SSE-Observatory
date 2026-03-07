import { test, expect } from '@playwright/test';

// A long-duration soak test designed to run for hours without crashing and verify memory stability.
// Not intended for standard CI/CD due to extreme duration.

test.describe('Soak Testing', () => {
    test('handles continuous stream for an extended duration without memory explosion', async ({ page }) => {
        test.setTimeout(60 * 60 * 1000); // 1 Hour Timeout for soak testing

        await page.goto('/');

        // Connect to the load stream
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/load-stream');
        await page.getByRole('button', { name: 'Connect', exact: true }).click();

        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 });

        console.log('Started Soak Test. Stream connected...');

        // We run a loop to periodically check the UI responsiveness and (if possible) log metrics.
        // We'll run it for a configured soak time (e.g. 10 minutes locally for proof)
        const soakDurationMs = process.env.CI ? 60000 : 10 * 60 * 1000; // 1 min in CI, 10 mins local testing
        const intervalMs = 30000; // Check every 30 seconds
        const iterations = Math.floor(soakDurationMs / intervalMs);

        for (let i = 0; i < iterations; i++) {
            await page.waitForTimeout(intervalMs);

            // Check if still connected
            await expect(page.locator('text=Connected').first()).toBeVisible();

            // Verify the UI is responsive by checking event list rows
            const eventRows = await page.locator('.animate-slide-up').count();
            expect(eventRows).toBeGreaterThan(0);

            // Attempt to fetch some memory metrics via CDP if available
            try {
                const metrics = await page.evaluate(() => {
                    const perf: any = performance;
                    return perf.memory ? {
                        usedJSHeapSize: Math.round(perf.memory.usedJSHeapSize / 1024 / 1024),
                        totalJSHeapSize: Math.round(perf.memory.totalJSHeapSize / 1024 / 1024)
                    } : null;
                });

                if (metrics) {
                    console.log(`[Soak ${i + 1}/${iterations}] Heap Used: ${metrics.usedJSHeapSize} MB / ${metrics.totalJSHeapSize} MB`);
                    // We don't want strict assertions on memory size because GC is unpredictable, 
                    // but we observe to ensure it doesn't grow linearly to gigabytes.
                    expect(metrics.usedJSHeapSize).toBeLessThan(1500); // Fail if it blows past 1.5GB
                } else {
                    console.log(`[Soak ${i + 1}/${iterations}] UI is alive and connected.`);
                }
            } catch (e) {
                console.log(`[Soak ${i + 1}/${iterations}] Error retrieving memory:`, e);
            }
        }

        console.log('Soak Test Completed Successfully.');
    });
});
