import { defineConfig, devices } from "@playwright/test";

const port = 5173;
const webServerCommand = process.env.CI
  ? `pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --port ${port}`
  : `pnpm dev --host 127.0.0.1 --port ${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: process.env.CI ? "off" : "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.CI ? { channel: "chrome" as const } : {}),
      },
    },
  ],
  webServer: {
    command: webServerCommand,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
