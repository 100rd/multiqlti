import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3099",
    trace: "on-first-retry",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "PORT=3099 NODE_ENV=test tsx server/index.ts",
    url: "http://localhost:3099",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      PORT: "3099",
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      JWT_SECRET: process.env.JWT_SECRET ?? "local-dev-secret-minimum-32-chars-long",
    },
  },
});
