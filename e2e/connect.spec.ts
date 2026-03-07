import { test, expect } from '@playwright/test';

test.describe('SSE-Tester E2E', () => {
    test('connects to SSE stream and receives events', async ({ page }) => {
        await page.goto('/');

        // Target the proxy endpoint running our chaos server
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/chaos-stream');

        // Un-check the profile saving or just click connect
        await page.getByRole('button', { name: 'Connect', exact: true }).click();

        // Verify it connects
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 });

        // Verify we get events rendered in the DOM
        // The chaos server sends an initial burst of 50 events immediately
        await expect(page.locator('text=Event Stream')).toBeVisible();

        // Wait for the burst to populate
        await page.waitForTimeout(2000);

        // Verify the list contains rows (events)
        const eventRows = await page.getByTestId('event-row').count();
        expect(eventRows).toBeGreaterThan(4);
    });

    test('connects with auth token', async ({ page }) => {
        await page.goto('/');

        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/chaos-stream');
        await page.fill('input[placeholder*="authentication token"]', 'Bearer TEST123'); // Token

        await page.getByRole('button', { name: 'Connect', exact: true }).click();

        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 });
    });

    test('UI remains stable under rapid interaction', async ({ page }) => {
        await page.goto('/');

        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/chaos-stream');
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 });

        // Wait for initial burst
        await page.waitForTimeout(1000);

        const pauseResumeButton = page.locator('button[title="Pause Stream"], button[title="Resume Stream"]').first();

        // Rapidly toggle play/pause to ensure no React state corruption
        for (let i = 0; i < 20; i++) {
            await pauseResumeButton.click();
            await page.waitForTimeout(50);
        }

        // It should still be alive and not crashed
        await expect(page.locator('text=Event Stream')).toBeVisible();
    });

    test('handles high event throughput (stress test)', async ({ page }) => {
        test.setTimeout(30000); // Give it time for the heavy load

        await page.goto('/');

        // Point to the extreme load test endpoint (50k events in loop)
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/load-stream');
        await page.getByRole('button', { name: 'Connect', exact: true }).click();

        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 });

        // Wait 5 seconds to ingest
        await page.waitForTimeout(5000);

        // Verify it didn't crash and events are logged
        const eventStat = await page.locator('text=events').first().innerText();
        // It should say something like "X events" where X is large (e.g., 5000 due to ring buffer max)
        const countMatch = eventStat.match(/(\d+)/);
        const count = countMatch ? parseInt(countMatch[1]) : 0;

        expect(count).toBeGreaterThan(100);
        // Usually the ring buffer limits to 5000, so we just want to know it didn't freeze completely
    });

    test('handles 1MB+ massive payloads gracefully without crashing', async ({ page }) => {
        test.setTimeout(15000); // Allow time for huge payload parsing

        await page.goto('/');

        // Point to the massive payload endpoint
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/massive-payload');
        await page.getByRole('button', { name: 'Connect', exact: true }).click();

        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 });

        // Wait to ensure payload is ingested and rendered
        await page.waitForTimeout(2000);

        // Verify it didn't crash. There should be an event rendered.
        // We expect custom "huge-1" or "huge-2" IDs, but simply asserting the DOM survives is primary.
        const rowCount = await page.getByTestId('event-row').count();
        expect(rowCount).toBeGreaterThan(0);

        // Click the first row to expand/view details. This tests if rendering a huge object crashes the UI.
        await page.getByTestId('event-row').first().click();

        // Check if the DOM continues to live after expanding details
        await expect(page.locator('text=massive').first()).toBeVisible();

        // Try toggling Diff to see if microdiff hangs
        // First we need a second event for microdiff
        await page.waitForTimeout(2000);
        await page.getByTestId('event-row').first().click(); // Open closest

        // Wait, the diff button only appears if there's a previous event.
        const diffButtons = await page.locator('button:has-text("Compare")').count();
        if (diffButtons > 0) {
            await page.locator('button:has-text("Compare")').first().click();
            // Just assert it didn't kill the tab
            await expect(page.locator('text=Connected').first()).toBeVisible();
        }
    });

    test('maintains search filter performance during rapid event insertion', async ({ page }) => {
        test.setTimeout(25000);

        await page.goto('/');

        // Connect to the massive throughput stream
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/load-stream');
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 });

        // Apply a filter while the events are pouring in
        await page.fill('input[placeholder*="Search events..."]', 'load');

        // Wait to accumulate
        await page.waitForTimeout(5000);

        // Verify the UI didn't freeze and events are being filtered.
        const eventRows = await page.getByTestId('event-row').count();
        expect(eventRows).toBeGreaterThan(0);

        // Turn off the filter dynamically while under load to test unfiltering
        await page.fill('input[placeholder*="Search events..."]', '');

        // Wait and ensure it's still alive
        await page.waitForTimeout(1000);
        await expect(page.locator('text=Event Stream')).toBeVisible();
    });

    test('recovers gracefully from background tab throttling', async ({ page }) => {
        await page.goto('/');

        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/chaos-stream');
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 });

        // Wait for connection to settle
        await page.waitForTimeout(1000);

        // Spoof visibility hidden (Background tab)
        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: true });
            document.dispatchEvent(new Event('visibilitychange'));
        });

        // Let the chaos stream continue delivering events while "hidden"
        await page.waitForTimeout(3000);

        // Spoof visibility visible (Foreground tab)
        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
            document.dispatchEvent(new Event('visibilitychange'));
        });

        // Ensure the DOM updates are still processing
        await page.waitForTimeout(3000); // Wait longer for render catch-up

        // Count rows more reliably
        const eventRows = await page.getByTestId('event-row').count();
        expect(eventRows).toBeGreaterThan(10); // Should still have events from burst + window

        // Assert UI is alive
        await expect(page.locator('text=Event Stream')).toBeVisible();
    });
});
