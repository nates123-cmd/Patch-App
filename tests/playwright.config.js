// Playwright config for the Patch QA harness.
// Serves the app (single-file PWA) over http and drives REAL window globals.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8216',
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // Served from the worktree root (one level up from tests/), where index.html lives.
    command: 'python3 -m http.server 8216 --directory ..',
    url: 'http://localhost:8216/index.html',
    reuseExistingServer: true,
    timeout: 20000,
  },
});
