import { defineConfig } from "@playwright/test";
import path from "node:path";
import { e2eShardPatterns } from "./scripts/e2e-shards.ts";

const port = Number(process.env.RVW_E2E_PORT ?? 43117);
const baseURL = `http://127.0.0.1:${port}`;
const realisticPort = Number(process.env.RVW_REALISTIC_E2E_PORT ?? port + 1);
const realisticBaseURL = `http://127.0.0.1:${realisticPort}`;

const shardPatterns = e2eShardPatterns(
  path.resolve(import.meta.dirname, "test/e2e"),
  process.env.RVW_E2E_SHARD,
);
if (shardPatterns && process.argv.some((arg) => /^--shard(?:=|$)/u.test(arg)))
  throw new Error("Use RVW_E2E_SHARD or Playwright --shard, not both.");

export default defineConfig({
  testDir: "./test/e2e",
  ...(shardPatterns ? { testMatch: shardPatterns } : {}),
  timeout: 30_000,
  expect: { timeout: 8_000 },
  // Tests mutate shared fixture state. CI shards whole files onto separate runners;
  // keep each shard serial instead of sharing a server across parallel workers.
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
      url: realisticBaseURL,
      env: {
        RVW_E2E_PORT: String(realisticPort),
        RVW_FIXTURE_SCENARIO: "realistic",
      },
      timeout: 15_000,
      reuseExistingServer: false,
    },
  ],
});
