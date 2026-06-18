import { devices, defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['line']],
  webServer: false,
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'chrome-debug',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
})
