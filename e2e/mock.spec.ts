import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

test.describe('Mock Server / VCR Replay E2E', () => {
    test('can upload a recording and connect to its own mock stream', async ({ page }) => {
        page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
        await page.goto('/');

        // 1. Switch to Mock Server Mode
        await page.getByRole('button', { name: /Mock Server Mode/i }).click();
        await expect(page.locator('text=Mock Server Engine')).toBeVisible();

        // 2. Prepare a mock recording file
        const mockRecording = {
            version: '1.0',
            createdAt: new Date().toISOString(),
            totalEvents: 2,
            durationMs: 100,
            events: [
                { id: 'm1', type: 'MOCK_EVENT', data: '{"ok":true}', timestamp: '12:00:00.000', deltaMs: 0 },
                { id: 'm2', type: 'MOCK_EVENT', data: '{"ok":true}', timestamp: '12:00:00.100', deltaMs: 100 }
            ]
        };
        const filePath = path.join(process.cwd(), 'temp-recording.sse-record');
        fs.writeFileSync(filePath, JSON.stringify(mockRecording));

        // 3. Upload the file
        // Note: We target the hidden input[type="file"]
        await page.setInputFiles('input[type="file"]', filePath);
        await expect(page.locator('text=temp-recording.sse-record')).toBeVisible();

        // 4. Start Mock Server
        console.log('E2E: Clicking Start Mock Server...');
        await page.getByRole('button', { name: /Start Mock Server/i }).click();

        // Wait for the button to toggle to "Stop"
        await expect(page.locator('button:has-text("Stop Mock Server")')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('text=Broadcasting locally on port 3001')).toBeVisible({ timeout: 15000 });

        // 5. Switch back to Monitor Mode to "test itself"
        console.log('E2E: Switching to Monitor Mode...');
        await page.getByRole('button', { name: /Monitor Mode/i }).click();

        // 6. Connect to the Mock Server URL (which is local)
        const mockUrl = 'http://localhost:3001/api/mock/stream?speed=1&loop=false';
        await page.fill('input[placeholder*="https://api.example.com/sse"]', mockUrl);
        await page.getByRole('button', { name: 'Connect', exact: true }).click();

        // 7. Verify events arrive in the UI
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 });
        await expect(page.locator('text=MOCK_EVENT').first()).toBeVisible({ timeout: 10000 });

        // Clean up
        fs.unlinkSync(filePath);
    });
});
