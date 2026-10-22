import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { packageManager: string; engines: { pnpm: string } };

describe("package manager pin", () => {
  it("uses a Corepack-compatible SHA-512 hex digest for the required pnpm version", () => {
    // npm's dist.integrity uses Base64; Corepack's packageManager suffix uses hex.
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
    expect(manifest.packageManager.split("+")[0]).toBe(`pnpm@${manifest.engines.pnpm}`);
  });
});
