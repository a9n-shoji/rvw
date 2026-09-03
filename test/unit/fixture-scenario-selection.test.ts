import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("fixture scenario selection", () => {
  it("fails explicitly for an unknown scenario instead of falling back to contract", () => {
    const repositoryRoot = path.resolve(import.meta.dirname, "../..");
    const result = spawnSync(process.execPath, ["test/e2e/fixture-server.mjs"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        RVW_E2E_PORT: "43199",
        RVW_FIXTURE_SCENARIO: "typo",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'unknown RVW_FIXTURE_SCENARIO "typo"; expected contract, realistic, or dogfood',
    );
  });
});
