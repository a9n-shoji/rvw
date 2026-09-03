import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDogfoodFixture,
  readDogfoodChangedFiles,
  readDogfoodDocument,
  readDogfoodTree,
} from "../../scripts/dogfood-fixture.js";

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

describe("dogfood Git object reader", () => {
  it("reads trees, text, binary files, and renames from a temporary repository", () => {
    const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "rvw-dogfood-reader-"));
    try {
      git(repositoryRoot, ["init", "--object-format=sha1", "--initial-branch=main"]);
      git(repositoryRoot, ["config", "user.name", "Reader Test"]);
      git(repositoryRoot, ["config", "user.email", "reader@example.test"]);
      git(repositoryRoot, ["config", "core.autocrlf", "false"]);
      writeFileSync(path.join(repositoryRoot, "old.ts"), "export const value = 1;\r\n", "utf8");
      writeFileSync(path.join(repositoryRoot, "binary.bin"), Buffer.from([0, 1, 2, 3]));
      git(repositoryRoot, ["add", "-A"]);
      git(repositoryRoot, ["commit", "--no-verify", "-m", "base"]);
      const baseOid = git(repositoryRoot, ["rev-parse", "HEAD"]);

      renameSync(path.join(repositoryRoot, "old.ts"), path.join(repositoryRoot, "new.ts"));
      git(repositoryRoot, ["add", "-A"]);
      git(repositoryRoot, ["commit", "--no-verify", "-m", "rename source"]);
      const headOid = git(repositoryRoot, ["rev-parse", "HEAD"]);

      expect(
        readDogfoodTree(repositoryRoot, headOid).map(({ path: filePath }) => filePath),
      ).toEqual(["binary.bin", "new.ts"]);
      expect(readDogfoodDocument(repositoryRoot, baseOid, "old.ts")).toMatchObject({
        availability: "available",
        text: "export const value = 1;\n",
        normalizedLineEndings: true,
      });
      expect(readDogfoodDocument(repositoryRoot, headOid, "binary.bin").availability).toBe(
        "binary",
      );
      expect(readDogfoodDocument(repositoryRoot, headOid, "missing.ts").availability).toBe(
        "missing",
      );
      expect(readDogfoodChangedFiles(repositoryRoot, baseOid, headOid)).toContainEqual(
        expect.objectContaining({ kind: "renamed", oldPath: "old.ts", newPath: "new.ts" }),
      );
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("builds a dogfood fixture from the current rvw checkout", () => {
    const fixture = createDogfoodFixture(process.cwd());
    expect(fixture.scenario).toBe("dogfood");
    expect(fixture.commits.length).toBeGreaterThan(1);
    expect(fixture.repositoryEntriesAt(fixture.headOid).length).toBeGreaterThan(0);
    expect(fixture.walkthroughs.length).toBeGreaterThan(0);
    expect(fixture.comments.length).toBeGreaterThan(0);
    fixture.cleanup();
  });
});
