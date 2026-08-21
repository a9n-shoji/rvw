import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rvwSkill = readFileSync("skills/rvw/SKILL.md", "utf8");
const watchSkill = readFileSync("skills/rvw-watch-comments/SKILL.md", "utf8");

describe("bundled Skill code-reference guidance", () => {
  it("makes exact code evidence the default for concrete review outcomes", () => {
    expect(rvwSkill).toContain(
      "Use typed references by default whenever a post makes a concrete claim",
    );
    expect(rvwSkill).toContain("Apply the same code-evidence default to synchronized replies");
    expect(watchSkill).toContain("For every concrete claim about code behavior");
    expect(watchSkill).toMatch(
      /follow the code\s+evidence defaults above even though no commit was pushed/,
    );
  });

  it("carries typed references through the watcher worker result", () => {
    const outcomeExample = watchSkill.match(/"outcomes": \[[\s\S]*?\n {2}\]\n}/)?.[0];

    expect(outcomeExample).toBeDefined();
    expect(outcomeExample).toContain('"relatedCommitOid"');
    expect(outcomeExample).toContain('"references"');
    expect(outcomeExample).toContain('"pushStatus"');
    expect(outcomeExample).not.toContain('"commitOid"');
  });
});
