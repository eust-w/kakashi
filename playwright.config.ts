import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:49379",
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: [
    {
      command: "pnpm --filter @kakashi/server exec tsx src/index.ts --port=49327",
      url: "http://127.0.0.1:49327/health",
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: "KAKASHI_API_URL=http://127.0.0.1:49327 pnpm --filter @kakashi/web exec vite --host 127.0.0.1 --port 49379",
      url: "http://127.0.0.1:49379",
      reuseExistingServer: false,
      timeout: 30_000
    }
  ]
});
