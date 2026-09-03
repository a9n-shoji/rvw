import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readDogfoodChangedFiles,
  readDogfoodDocument,
  readDogfoodTree,
} from "../../scripts/dogfood-fixture.js";

function git(repositoryRoot: string, environmentRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(environmentRoot, "global.gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TEMPLATE_DIR: path.join(environmentRoot, "template"),
      HOME: path.join(environmentRoot, "home"),
      XDG_CONFIG_HOME: path.join(environmentRoot, "xdg"),
    },
  }).trim();
}

describe("dogfood Git object reader", () => {
  it("reads trees, text, binary files, and renames from a temporary repository", () => {
    const environmentRoot = mkdtempSync(path.join(os.tmpdir(), "rvw-dogfood-reader-"));
    const repositoryRoot = path.join(environmentRoot, "repository");
    for (const directory of [repositoryRoot, "home", "xdg", "template"]) {
      mkdirSync(path.isAbsolute(directory) ? directory : path.join(environmentRoot, directory));
    }
    writeFileSync(path.join(environmentRoot, "global.gitconfig"), "", "utf8");
    try {
      git(repositoryRoot, environmentRoot, [
        "init",
        "--object-format=sha1",
        "--initial-branch=main",
      ]);
      git(repositoryRoot, environmentRoot, ["config", "user.name", "Reader Test"]);
      git(repositoryRoot, environmentRoot, ["config", "user.email", "reader@example.test"]);
      git(repositoryRoot, environmentRoot, ["config", "core.autocrlf", "false"]);
      writeFileSync(path.join(repositoryRoot, "old.ts"), "export const value = 1;\r\n", "utf8");
      writeFileSync(path.join(repositoryRoot, "binary.bin"), Buffer.from([0, 1, 2, 3]));
      git(repositoryRoot, environmentRoot, ["add", "-A"]);
      git(repositoryRoot, environmentRoot, [
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "-m",
        "base",
      ]);
      const baseOid = git(repositoryRoot, environmentRoot, ["rev-parse", "HEAD"]);

      renameSync(path.join(repositoryRoot, "old.ts"), path.join(repositoryRoot, "new.ts"));
      git(repositoryRoot, environmentRoot, ["add", "-A"]);
      git(repositoryRoot, environmentRoot, [
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "-m",
        "rename source",
      ]);
      const headOid = git(repositoryRoot, environmentRoot, ["rev-parse", "HEAD"]);

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
      rmSync(environmentRoot, { recursive: true, force: true });
    }
  });
});
