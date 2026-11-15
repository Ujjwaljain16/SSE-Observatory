import { test, expect } from '@playwright/test';

test.describe('SSE-Tester E2E', () => {
    test('connects to SSE stream and receives events', async ({ page }) => {
        await page.goto('/');

        await page.getByTestId('url-input').fill('http://localhost:4000/chaos-stream');
        await page.getByTestId('connect-button').click();

        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 });
        await expect(page.locator('text=Event Stream')).toBeVisible({ timeout: 10000 });
        await page.waitForTimeout(2000);

        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 });
        const eventRows = await page.getByTestId('event-row').count();
        expect(eventRows).toBeGreaterThan(4);
    });

    test('connects with auth token', async ({ page }) => {
        await page.goto('/');

        await page.getByTestId('url-input').fill('http://localhost:4000/chaos-stream');
        await page.getByTestId('token-input').fill('Bearer TEST123');

        await page.getByTestId('connect-button').click();

        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 });
    });

    test('UI remains stable under rapid interaction', async ({ page }) => {
        await page.goto('/');

        await page.getByTestId('url-input').fill('http://localhost:4000/chaos-stream');
        await page.getByTestId('connect-button').click();
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 });

        await page.waitForTimeout(1000);
        const pauseResumeButton = page.locator('button[title="Pause Stream"], button[title="Resume Stream"]').first();

        for (let i = 0; i < 20; i++) {
            await pauseResumeButton.click();
            await page.waitForTimeout(50);
        }

        await expect(page.locator('text=Event Stream')).toBeVisible({ timeout: 10000 });
    });

    test('handles high event throughput (stress test)', async ({ page }) => {
        test.setTimeout(30000);
        await page.goto('/');

        await page.getByTestId('url-input').fill('http://localhost:4000/load-stream');
        await page.getByTestId('connect-button').click();

        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 });

        // Poll instead of sleeping: on a cold dev server the filter worker takes a few seconds to compile, and the
        // count only reflects events once it is up, so a fixed 5 s sleep read 0 on slow runners.
        const count = async () => Number((await page.getByTestId('event-count').innerText()).match(/(\d+)/)?.[1] ?? 0);
        await expect.poll(count, { timeout: 20000, intervals: [500] }).toBeGreaterThan(100);
    });

    test('handles 1MB+ massive payloads gracefully without crashing', async ({ page }) => {
        test.setTimeout(30000);
        await page.goto('/');

        await page.getByTestId('url-input').fill('http://localhost:4000/massive-payload');
        await page.getByTestId('connect-button').click();

        await expect(page.getByTestId('connection-status')).toContainText('Connected', { timeout: 15000 });
        await page.waitForTimeout(2000);

        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 15000 });
        const rowCount = await page.getByTestId('event-row').count();
        expect(rowCount).toBeGreaterThan(0);

        // Force click for large rows
        await page.getByTestId('event-row').first().click({ force: true });
        await expect(page.locator('text=massive').first()).toBeVisible();

        await page.waitForTimeout(2000);
        await page.getByTestId('event-row').first().click({ force: true });

        const diffButtons = await page.locator('button:has-text("Compare")').count();
        if (diffButtons > 0) {
            await page.locator('button:has-text("Compare")').first().click();
            await expect(page.getByTestId('connection-status')).toContainText('Connected');
        }
    });

    test('maintains search filter performance during rapid event insertion', async ({ page }) => {
        test.setTimeout(35000);
        await page.goto('/');

        // Wait for previous test worker congestion to clear
        await page.waitForTimeout(2000);

        await page.getByTestId('url-input').fill('http://localhost:4000/api/stream?freq=2000');
        await page.getByTestId('connect-button').click();
        await expect(page.getByTestId('connection-status')).toContainText('Connected', { timeout: 15000 });

        await page.waitForTimeout(2000);
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 15000 });

        const searchInput = page.getByTestId('search-input');
        await expect(searchInput).toBeVisible();
        await searchInput.fill('stream');
        await page.waitForTimeout(3000);

        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 15000 });
        const eventRows = await page.getByTestId('event-row').count();
        expect(eventRows).toBeGreaterThan(0);

        await searchInput.fill('');
        await page.waitForTimeout(1000);
        await expect(page.locator('text=Event Stream')).toBeVisible({ timeout: 15000 });
    });

    test('recovers gracefully from background tab throttling', async ({ page }) => {
        test.setTimeout(30000);
        await page.goto('/');

        await page.getByTestId('url-input').fill('http://localhost:4000/chaos-stream');
        await page.getByTestId('connect-button').click();
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 });

        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 });
        await page.waitForTimeout(1000);

        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: true });
            document.dispatchEvent(new Event('visibilitychange'));
        });

        await page.waitForTimeout(3000);

        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
            document.dispatchEvent(new Event('visibilitychange'));
        });

        await page.waitForTimeout(2000);

        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 });
        const eventRows = await page.getByTestId('event-row').count();
        expect(eventRows).toBeGreaterThan(0);

        await expect(page.locator('text=Event Stream')).toBeVisible({ timeout: 10000 });
    });
});
