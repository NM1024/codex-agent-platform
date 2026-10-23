import { defineConfig } from "@playwright/test";
const port = Number(process.env.CONSOLE_TEST_PORT ?? 4317);
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 20000,
  expect: { timeout: 5000 },
  outputDir: ".tmp/browser-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: ".tmp/browser-report", open: "never" }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: {
    command: "node tests/browser/fixture.mjs",
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
