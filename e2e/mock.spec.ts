import { test } from '@playwright/test'

// NOTE: This spec was written for a "Mock Server / VCR Replay" feature
// that does not exist in the current version of this application.
// The feature would require:
//   - A "Mock Server Mode" button in the UI
//   - A "Mock Server Engine" panel with file upload
//   - A backend endpoint (/api/mock/stream) that replays uploaded recordings
//
// Until this feature is implemented, this entire describe block is skipped.

test.describe.skip('Mock Server / VCR Replay E2E', () => {
    test('can upload a recording and connect to its own mock stream', async ({ page }) => {
        // Implementation pending — see NOTE above
        void page
    })
})
