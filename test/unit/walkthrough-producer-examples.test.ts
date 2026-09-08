import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import mermaid from "mermaid";
import { describe, expect, it } from "vitest";
import { walkthroughUpdateInputSchema } from "../../src/application/agent-command-schemas.js";
import { analyzeReferenceMarkdown } from "../../src/application/rvw-service.js";

interface ExampleCase {
  file: string;
  expectedDiagramTypes: string[];
}

const examples: ExampleCase[] = [
  {
    file: "docs/examples/walkthroughs/review-composition-verification-path.json",
    expectedDiagramTypes: ["sequenceDiagram"],
  },
  {
    file: "docs/examples/walkthroughs/review-bootstrap-lifecycle.json",
    expectedDiagramTypes: ["stateDiagram-v2"],
  },
  {
    file: "docs/examples/walkthroughs/hide-whitespace-decision.json",
    expectedDiagramTypes: ["flowchart"],
  },
  {
    file: "docs/examples/walkthroughs/runtime-handoff-lifecycle.json",
    expectedDiagramTypes: ["sequenceDiagram", "stateDiagram-v2"],
  },
  {
    file: "docs/examples/walkthroughs/markdown-code-fonts.json",
    expectedDiagramTypes: [],
  },
];

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function expectCommittedSource(sourceOid: string): void {
  execFileSync("git", ["cat-file", "-e", `${sourceOid}^{commit}`], {
    stdio: "ignore",
  });
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

function mermaidDiagrams(body: string): string[] {
  return [...body.matchAll(/```mermaid\n([\s\S]*?)\n```/gu)].map((match) => match[1]!);
}

function diagramType(source: string): string {
  return source
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("%%"))!
    .split(/\s+/u)[0]!;
}

describe("Walkthrough producer examples", () => {
  it.each(examples)(
    "keeps $file exact, closed, and role-specific",
    ({ file, expectedDiagramTypes }) => {
      const walkthrough = walkthroughUpdateInputSchema.parse(readJson(file));
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

      const diagrams = mermaidDiagrams(walkthrough.body);
      expect(diagrams.map(diagramType)).toEqual(expectedDiagramTypes);
      if (expectedDiagramTypes.length === 0) {
        expect(walkthrough.diagramBindings ?? {}).toEqual({});
      }
    },
  );

  it("parses the sequence examples that Mermaid supports without a browser DOM", async () => {
    const sources = examples.flatMap(({ file }) => {
      const walkthrough = walkthroughUpdateInputSchema.parse(readJson(file));
      return mermaidDiagrams(walkthrough.body).filter(
        (source) => diagramType(source) === "sequenceDiagram",
      );
    });

    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    for (const source of sources) {
      await expect(mermaid.parse(source)).resolves.toBeTruthy();
    }
  });

  it("keeps the combined example's diagrams on distinct questions", () => {
    const walkthrough = walkthroughUpdateInputSchema.parse(
      readJson("docs/examples/walkthroughs/runtime-handoff-lifecycle.json"),
    );

    expect(walkthrough.body).toContain("どの runtime に届くか");
    expect(walkthrough.body).toContain("reservation を二相にする");
    expect(walkthrough.body).toContain("部分状態図");
    expect(walkthrough.body).toContain("runtime closes before arm");
    expect(walkthrough.body).toContain("cancel 自体は no-op");
  });

  it("keeps the Hide Whitespace guard mutually exclusive in the flowchart", () => {
    const walkthrough = walkthroughUpdateInputSchema.parse(
      readJson("docs/examples/walkthroughs/hide-whitespace-decision.json"),
    );
    const [diagram] = mermaidDiagrams(walkthrough.body);

    expect(diagram).toContain("Compare_mode{ON and two-sided?}");
    expect(diagram).toContain(
      "Compare_mode -->|No: OFF or one-sided| Original_diff_OFF_added_deleted",
    );
    expect(diagram).toContain("Compare_mode -->|Yes| Normalize_two_sided_copies");
    expect(diagram).not.toMatch(/Compare_mode --> (?:Original_diff|Normalize)/u);
  });

  it("keeps the local typography example concise without a ceremonial diagram", () => {
    const walkthrough = walkthroughUpdateInputSchema.parse(
      readJson("docs/examples/walkthroughs/markdown-code-fonts.json"),
    );

    expect(mermaidDiagrams(walkthrough.body)).toEqual([]);
    expect(walkthrough.body).toMatch(/font-size/u);
    expect(walkthrough.body).toMatch(/rvw-ref:/u);
  });
});
