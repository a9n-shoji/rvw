import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rvwSkill = readFileSync("skills/rvw/SKILL.md", "utf8");
const watchSkill = readFileSync("skills/rvw-watch-comments/SKILL.md", "utf8");
const walkthroughSkill = readFileSync("skills/rvw-walkthrough/SKILL.md", "utf8");
const structureSkill = readFileSync("skills/rvw-structure/SKILL.md", "utf8");
const structureAuthoring = readFileSync(
  "skills/rvw-structure/references/structure-authoring.md",
  "utf8",
);
const walkthroughAuthoring = readFileSync(
  "skills/rvw-walkthrough/references/walkthrough-authoring.md",
  "utf8",
);

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

  it("gates HTML preview authoring on capability and keeps visuals static", () => {
    expect(walkthroughSkill).toContain("Require `walkthrough.htmlPreview`");
    expect(walkthroughSkill).toContain("Markdown or HTML `rvw-ref:` link");
    expect(walkthroughSkill).toContain(
      'use Markdown links in prose and `<a href="rvw-ref:<referenceId>">` links inside HTML previews',
    );
    expect(walkthroughAuthoring).toContain("```html-preview");
    expect(walkthroughAuthoring).toContain("Never add JavaScript");
    expect(walkthroughAuthoring).toContain("Author an HTML fragment only");
    expect(walkthroughAuthoring).toContain("Put `<style>` directly inside");
    expect(walkthroughAuthoring).toContain("data-rvw-commentable");
    expect(walkthroughAuthoring).toContain("meaningful `aria-label`");
    expect(walkthroughAuthoring).toContain("repository root");
  });

  it("keeps Structure authoring code-centered, source-exact, and identity-stable", () => {
    expect(structureSkill).toContain("A Structure is a space; a Walkthrough is a path");
    expect(structureSkill).toContain("Require `protocolVersion` 4");
    expect(structureSkill).toContain("structure.publish");
    expect(structureSkill).toContain("Never access SQLite directly");
    expect(structureSkill).toContain("Preserve IDs");
    expect(structureAuthoring).toContain("Explicit directions from the user");
    expect(structureAuthoring).toContain("one exact `sourceOid`");
    expect(structureAuthoring).toContain("Never recycle an ID");
    expect(structureAuthoring).toMatch(/Stop and recommend a\s+Walkthrough/);
    expect(structureAuthoring).toContain("Do not create giant graphs");
    expect(structureAuthoring).toContain("factual code entrypoint");
    expect(structureAuthoring).toContain("static inventory");
    expect(structureAuthoring).toContain("Do not publish");
  });
});
