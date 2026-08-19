import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SkillInstaller } from "../../src/infrastructure/skills/skill-installer.js";

const expectedSkillNames = ["rvw", "rvw-walkthrough"];

describe("SkillInstaller", () => {
  it("installs both skills idempotently and requires force for divergent content", () => {
    const target = mkdtempSync(path.join(os.tmpdir(), "rvw-skills-"));
    const sentinel = path.join(target, "keep.txt");
    writeFileSync(sentinel, "keep");
    const installer = new SkillInstaller(process.cwd());

    const first = installer.install("codex", { targetRoot: target });
    expect(first.map((status) => status.name)).toEqual(expectedSkillNames);
    expect(first.every((status) => status.matchesBundled)).toBe(true);
    expect(installer.install("codex", { targetRoot: target })).toEqual(first);

    const reviewSkill = first.find((status) => status.name === "rvw")!;
    writeFileSync(path.join(reviewSkill.path, "SKILL.md"), "locally changed");
    expect(installer.statuses("codex", target)).toMatchObject([
      {
        name: "rvw",
        installed: true,
        matchesBundled: false,
        locallyModified: true,
        updateAvailable: false,
        updateRequired: false,
        state: "locally-modified",
      },
      {
        name: "rvw-walkthrough",
        installed: true,
        matchesBundled: true,
        locallyModified: false,
        updateAvailable: false,
        updateRequired: false,
        state: "current",
      },
    ]);
    expect(() => installer.install("codex", { targetRoot: target })).toThrow(/--force/);
    expect(installer.install("codex", { targetRoot: target, force: true })).toEqual(first);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("distinguishes a managed bundled update from local customization", () => {
    const packageRoot = mkdtempSync(path.join(os.tmpdir(), "rvw-skill-package-"));
    cpSync(path.join(process.cwd(), "skills"), path.join(packageRoot, "skills"), {
      recursive: true,
    });
    const target = mkdtempSync(path.join(os.tmpdir(), "rvw-skills-update-"));
    const installer = new SkillInstaller(packageRoot);
    const installed = installer.install("codex", { targetRoot: target });
    const reviewSkill = installed.find((status) => status.name === "rvw")!;

    const bundledSkillPath = path.join(packageRoot, "skills", "rvw", "SKILL.md");
    writeFileSync(bundledSkillPath, `${readFileSync(bundledSkillPath, "utf8")}\nBundled update.\n`);
    expect(installer.status("codex", "rvw", target)).toMatchObject({
      managed: true,
      locallyModified: false,
      updateAvailable: true,
      updateRequired: true,
      state: "update-available",
    });

    writeFileSync(path.join(reviewSkill.path, "SKILL.md"), "local customization");
    expect(installer.status("codex", "rvw", target)).toMatchObject({
      managed: true,
      locallyModified: true,
      updateAvailable: true,
      updateRequired: false,
      state: "locally-modified",
    });
  });

  it("uses the same capability names and content for Codex and Claude", () => {
    const codexTarget = mkdtempSync(path.join(os.tmpdir(), "rvw-codex-skills-"));
    const claudeTarget = mkdtempSync(path.join(os.tmpdir(), "rvw-claude-skills-"));
    const installer = new SkillInstaller(process.cwd());

    const codex = installer.install("codex", { targetRoot: codexTarget });
    const claude = installer.install("claude", { targetRoot: claudeTarget });

    expect(codex.map((status) => status.name)).toEqual(expectedSkillNames);
    expect(claude.map((status) => status.name)).toEqual(expectedSkillNames);
    for (const name of expectedSkillNames) {
      expect(readFileSync(path.join(codexTarget, name, "SKILL.md"), "utf8")).toBe(
        readFileSync(path.join(claudeTarget, name, "SKILL.md"), "utf8"),
      );
    }
    const authoringGuide = path.join("rvw-walkthrough", "references", "walkthrough-authoring.md");
    expect(readFileSync(path.join(codexTarget, authoringGuide), "utf8")).toBe(
      readFileSync(path.join(claudeTarget, authoringGuide), "utf8"),
    );
  });

  it("requires a platform when checking a custom skill root", () => {
    const target = mkdtempSync(path.join(os.tmpdir(), "rvw-skills-status-"));
    const installer = new SkillInstaller(process.cwd());

    expect(() => installer.statuses(undefined, target)).toThrow(
      "--targetを使う場合はcodexまたはclaudeを指定してください。",
    );
    expect(installer.statuses("codex", target)).toHaveLength(expectedSkillNames.length);
  });

  it("never loads bundled skills from the directory being reviewed", () => {
    const untrustedDirectory = mkdtempSync(path.join(os.tmpdir(), "rvw-untrusted-cwd-"));
    for (const name of expectedSkillNames) {
      const fakeSkill = path.join(untrustedDirectory, "skills", name);
      mkdirSync(fakeSkill, { recursive: true });
      writeFileSync(path.join(fakeSkill, "SKILL.md"), "untrusted skill");
    }
    const target = mkdtempSync(path.join(os.tmpdir(), "rvw-skills-"));
    const originalCwd = process.cwd();
    try {
      process.chdir(untrustedDirectory);
      const installed = new SkillInstaller().install("codex", { targetRoot: target });
      for (const status of installed) {
        expect(readFileSync(path.join(status.path, "SKILL.md"), "utf8")).not.toBe(
          "untrusted skill",
        );
      }
    } finally {
      process.chdir(originalCwd);
    }
  });
});
