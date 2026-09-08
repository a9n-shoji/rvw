import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import mermaid from "mermaid";
import { describe, expect, it } from "vitest";
import {
  structureContentInputSchema,
  walkthroughUpdateInputSchema,
} from "../../src/application/agent-command-schemas.js";
import { analyzeReferenceMarkdown } from "../../src/application/rvw-service.js";

const fileMapPath = "docs/examples/structures/review-composition-file-map.json";
const behaviorStructurePath = "docs/examples/structures/review-composition-authority.json";
const walkthroughPath = "docs/examples/walkthroughs/review-composition-verification-path.json";

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function expectReferenceExact(
  sourceOid: string,
  reference: { path: string; startLine: number | null; endLine: number | null },
): void {
  const source = execFileSync("git", ["show", `${sourceOid}:${reference.path}`], {
    encoding: "utf8",
  });
  const lineCount = source.endsWith("\n")
    ? source.split("\n").length - 1
    : source.split("\n").length;
  if (reference.startLine !== null && reference.endLine !== null) {
    expect(reference.startLine).toBeGreaterThanOrEqual(1);
    expect(reference.endLine).toBeLessThanOrEqual(lineCount);
  }
}

function expectCommittedSource(sourceOid: string): void {
  execFileSync("git", ["cat-file", "-e", `${sourceOid}^{commit}`], {
    stdio: "ignore",
  });
}

describe("review-composition producer trio", () => {
  it("keeps every Walkthrough reference used, exact, and bound only to parsed elements", async () => {
    const walkthrough = walkthroughUpdateInputSchema.parse(readJson(walkthroughPath));
    expectCommittedSource(walkthrough.sourceOid);
    const analysis = analyzeReferenceMarkdown(walkthrough.body);
    const declaredIds = new Set(walkthrough.references.map((reference) => reference.id));
    const usedIds = new Set([
      ...analysis.referenceIds,
      ...Object.values(walkthrough.diagramBindings ?? {}),
    ]);

    expect(usedIds).toEqual(declaredIds);
    for (const [elementId, referenceId] of Object.entries(walkthrough.diagramBindings ?? {})) {
      expect(analysis.mermaidNodeIds.has(elementId)).toBe(true);
      expect(declaredIds.has(referenceId)).toBe(true);
    }
    for (const reference of walkthrough.references) {
      expectReferenceExact(walkthrough.sourceOid, reference);
    }

    const diagrams = [...walkthrough.body.matchAll(/```mermaid\n([\s\S]*?)\n```/gu)].map(
      (match) => match[1]!,
    );
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0]).toMatch(/^sequenceDiagram/mu);
    expect(diagrams[0]!.match(/Composer->>WalkthroughProducer:/gu)).toHaveLength(1);
    expect(diagrams[0]).toContain(
      "WalkthroughProducer->>WalkthroughProducer: compare evidence with the bounded question",
    );
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    await expect(mermaid.parse(diagrams[0]!)).resolves.toMatchObject({ diagramType: "sequence" });
  });

  it("uses the same source coordinate for three genuinely different review questions", () => {
    const fileMap = structureContentInputSchema.parse(readJson(fileMapPath));
    const behaviorStructure = structureContentInputSchema.parse(readJson(behaviorStructurePath));
    const walkthrough = walkthroughUpdateInputSchema.parse(readJson(walkthroughPath));

    expect(
      new Set([fileMap.sourceOid, behaviorStructure.sourceOid, walkthrough.sourceOid]),
    ).toEqual(new Set(["f9416d959dbb79f95dd75d96bafeb6156155f5c8"]));
    expect(fileMap.title).not.toBe(behaviorStructure.title);
    expect(walkthrough.title).not.toBe(fileMap.title);

    expect(fileMap.nodes.every((node) => node.anchor?.startLine === null)).toBe(true);
    expect(
      behaviorStructure.nodes.some(
        (node) => node.anchor?.startLine !== null && node.anchor?.endLine !== null,
      ),
    ).toBe(true);
    expect(walkthrough.body).toContain("sequenceDiagram");
    expect(walkthrough.body).toMatch(/rvw-ref:/u);

    const fileMapPaths = new Set(fileMap.nodes.map((node) => node.anchor!.path));
    expect(fileMapPaths.size).toBe(fileMap.nodes.length);
    expect(
      behaviorStructure.nodes.some(
        (node, index) =>
          behaviorStructure.nodes.findIndex(
            (candidate) => candidate.anchor?.path === node.anchor?.path,
          ) !== index,
      ),
    ).toBe(true);
  });
});
