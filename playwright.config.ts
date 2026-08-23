import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./qa",
  timeout: 60_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "off",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/visual-qa-server.mjs",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
