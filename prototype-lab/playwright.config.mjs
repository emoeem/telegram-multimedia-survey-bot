import { defineConfig } from "@playwright/test";

// Prototype Lab 专用 Playwright 配置（独立于主工程 qa/visual，端口 4174）。
export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 4,
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "off",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node server.cjs",
    port: 4174,
    cwd: new URL(".", import.meta.url).pathname,
    reuseExistingServer: true,
  },
});
