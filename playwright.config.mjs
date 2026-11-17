import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests run against the real file on disk:
 *   file://   — the archival case, and what a recipient actually opens
 *   http://    — the served case, where fetch/module semantics differ
 *
 * The webServer exists for the http:// specs and for anything that fetches;
 * start it yourself with `npm run dev` and it will be reused.
 */
export default defineConfig({
  testDir: "./test/browser",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8080",
    trace: "on-first-retry",
    acceptDownloads: true,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: {
    command: "node build.mjs dev",
    url: "http://127.0.0.1:8080/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
    stdout: "ignore",
  },
});
