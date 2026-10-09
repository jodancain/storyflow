import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.STORYFLOW_UI_BASE_URL || "http://127.0.0.1:18297",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : process.env.STORYFLOW_BROWSER_CHANNEL
        ? { channel: process.env.STORYFLOW_BROWSER_CHANNEL }
        : {},
  },
  webServer: {
    command: "npm run build && npm run dev:ui",
    url: "http://127.0.0.1:18297",
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
  },
});
