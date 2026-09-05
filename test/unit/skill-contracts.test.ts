import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rvwSkill = readFileSync("skills/rvw/SKILL.md", "utf8");
const watchSkill = readFileSync("skills/rvw-watch-comments/SKILL.md", "utf8");
const reviewComposeSkill = readFileSync("skills/rvw-review-compose/SKILL.md", "utf8");
const reviewComposeDescription = reviewComposeSkill.match(/^description: (.+)$/mu)?.[1] ?? "";
const walkthroughSkill = readFileSync("skills/rvw-walkthrough/SKILL.md", "utf8");
const structureSkill = readFileSync("skills/rvw-structure/SKILL.md", "utf8");
const reviewComposition = readFileSync(
  "skills/rvw-review-compose/references/review-composition.md",
  "utf8",
);
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
    expect(structureSkill).toContain("`structure.preview`");
    expect(structureSkill).toContain("rvw structure preview --stdin --json");
    expect(structureSkill).toContain("nonForwardDirectionalLinkRatio >= 0.25");
    expect(structureSkill).toContain(
      "Do not implement or invoke a separate Skill-side layout preview",
    );
    expect(structureSkill).toContain("Never access SQLite directly");
    expect(structureSkill).toContain("Preserve IDs");
    expect(structureAuthoring).toContain("Explicit directions from the user");
    expect(structureAuthoring).toContain("one exact `sourceOid`");
    expect(structureAuthoring).toContain("Never recycle an ID");
    expect(structureAuthoring).toMatch(/Stop and recommend a\s+Walkthrough/);
    expect(structureAuthoring).toContain("Do not create giant graphs");
    expect(structureAuthoring).toContain("factual code entrypoint");
    expect(structureAuthoring).toContain("terminal or intermediate origin is still valid");
    expect(structureAuthoring).toContain("around 20 full-width characters or fewer");
    expect(structureAuthoring).toContain("overlapping or nested Node anchors");
    expect(structureAuthoring).toContain("static inventory");
    expect(structureAuthoring).toContain("deprecated compatibility field");
    expect(structureAuthoring).toContain("Do not set it in new");
    expect(structureAuthoring).toContain("Do not publish");
  });
});

describe("rvw review composition contract", () => {
  it("owns adaptive PR-wide composition and prefers the minimum useful surface", () => {
    expect(reviewComposeDescription).toContain("Pull Request or explicit review subject");
    expect(reviewComposeDescription).toContain("direct code reading");
    expect(reviewComposeDescription).toContain("overall review composition");
    expect(reviewComposeSkill).toContain("This Skill owns PR-wide composition");
    expect(reviewComposeSkill).toContain("smallest useful set of rvw reading surfaces");
    expect(reviewComposeSkill).toContain(
      "Direct the reviewer to code without creating an Artifact",
    );
    expect(reviewComposeSkill).toContain("Never require a Walkthrough and Structure as a pair");
    expect(reviewComposeSkill).toContain("Never require an overview Artifact");
    expect(reviewComposition).toContain("Never default to Walkthrough then Structure then code");
    expect(reviewComposition).toMatch(
      /Never instantiate Overview, State, Flow, Error, Test, and\s+Structure as fixed slots/,
    );
  });

  it("rechecks the complete composition instead of maximizing Artifact count", () => {
    expect(reviewComposeSkill).toMatch(/Artifact count is not a quality\s+measure/);
    expect(reviewComposeSkill).toContain("detailed overlap, terminology drift");
    expect(reviewComposeSkill).toMatch(/missing\s+important boundaries/);
    expect(reviewComposeSkill).toContain("over-fragmentation");
    expect(reviewComposeSkill).toContain("cross-boundary risk");
    expect(reviewComposeSkill).toMatch(
      /Never delete any published Artifact,[\s\S]*normal deletion preview[\s\S]*explicit authorization/,
    );
    expect(reviewComposition).toContain("Count the joins between surfaces");
    expect(reviewComposition).toContain("state authority, lifecycle, async behavior");
    expect(reviewComposition).toContain("output or state produced on one side");
  });

  it("keeps understanding units and briefs internal without a persistent Set model", () => {
    expect(reviewComposeSkill).toContain(
      "Candidate bounded understanding units are internal reasoning",
    );
    expect(reviewComposeSkill).toMatch(
      /The brief is\s+authoring context, not public JSON or rvw schema/,
    );
    expect(reviewComposition).toContain("Use a flexible note, not a fixed form");
    expect(reviewComposition).toContain("prompts rather than required slots");
    expect(reviewComposition).toMatch(
      /mustEstablish[\s\S]*rather than using it as a\s+coverage checklist/,
    );
    expect(reviewComposeSkill).toContain("Do not create a Review Set");
    expect(reviewComposeSkill).toContain("database row, migration, CLI");
    expect(reviewComposeSkill).toContain("Do not publish a duplicate");
    expect(reviewComposeSkill).toMatch(/There is no general Walkthrough\s+discovery contract/);
    expect(reviewComposition).toContain('"Slice" may be used as private shorthand');
  });
});

describe("single-Artifact producer composition boundary", () => {
  it("treats an upstream bounded brief as authority without expanding to the Pull Request", () => {
    for (const producer of [walkthroughSkill, structureSkill]) {
      expect(producer).toContain("at most one");
      expect(producer).toMatch(/subject,\s+review\s+question/);
      expect(producer).toContain("inclusions, exclusions");
      expect(producer).toContain("must-establish facts");
      expect(producer).toContain("emphasis");
      expect(producer).toMatch(/Inspect broader Pull\s+Request context only/);
      expect(producer).toMatch(/Pull Request's Artifact count\s+or Walkthrough \/ Structure\s+mix/);
      expect(producer).toMatch(/publish companion\s+Artifacts/);
      expect(producer).toContain("Standalone");
    }
    expect(walkthroughSkill).toMatch(
      /Do not broaden the Walkthrough\s+to cover the whole Pull Request/,
    );
    expect(structureSkill).toMatch(/do not publish separate Structures\s+autonomously/);
    expect(structureAuthoring).not.toContain("yields separate Structures");
    expect(structureAuthoring).not.toContain("author that behavior as a separate Structure");
  });

  it("retains each producer's local representation rejection boundary", () => {
    expect(walkthroughSkill).toMatch(
      /no useful ordered reading path[\s\S]*stop without publishing[\s\S]*recommend `rvw-structure`/,
    );
    expect(structureSkill).toMatch(
      /required reading[\s\S]*stop without publishing[\s\S]*recommend `rvw-walkthrough`/,
    );
    expect(structureSkill).toMatch(
      /no defensible[\s\S]*generic static architecture[\s\S]*do not publish a Structure/,
    );
    expect(walkthroughAuthoring).toContain(
      "The subject is genuinely clearer as an ordered path; otherwise no Walkthrough was published",
    );
  });
});
