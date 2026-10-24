import { defineConfig, devices } from '@playwright/test'

// End-to-end tests (#23) run against the real stack (`make up`): the built frontend, the API
// and Postgres. CI sets PLAYWRIGHT_BASE_URL; locally it defaults to the Compose app port.
// Time-dependent flows use Playwright's fake clock (`page.clock`), never real waiting.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
