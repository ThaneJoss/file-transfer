import { defineConfig, devices } from "@playwright/test";

// Separate from the mocked frontend suite: every auth request reaches local D1
// and the bundled Worker, including the real WebAuthn verifier.
export default defineConfig({
  testDir: "./tests/worker-browser",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  outputDir: "test-results/worker-browser",
  timeout: 60_000,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    ...(process.env.CI ? { channel: "chrome" } : {}),
    baseURL: "http://localhost:8788",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/test-worker-browser.mjs",
    url: "http://localhost:8788/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
