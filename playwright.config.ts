import { defineConfig } from "@playwright/test";

const port = Number(process.env.RVW_E2E_PORT ?? 43117);
const baseURL = `http://127.0.0.1:${port}`;
const demoPort = Number(process.env.RVW_DEMO_E2E_PORT ?? port + 1);
const demoBaseURL = `http://127.0.0.1:${demoPort}`;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node test/e2e/fixture-server.mjs",
      url: baseURL,
      env: { RVW_E2E_PORT: String(port) },
      timeout: 15_000,
      reuseExistingServer: false,
    },
    {
      command: "pnpm exec tsx test/e2e/fixture-server.mjs",
      url: demoBaseURL,
      env: { RVW_E2E_PORT: String(demoPort), RVW_FIXTURE_MODE: "repository-demo" },
      timeout: 15_000,
      reuseExistingServer: false,
    },
  ],
});
