import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { structureContentInputSchema } from "../../src/application/agent-command-schemas.js";

const behaviorExamples = [
  "docs/examples/structures/agent-transport-boundary.json",
  "docs/examples/structures/markdown-source-mapping.json",
  "docs/examples/structures/skill-distribution-boundary.json",
  "docs/examples/structures/review-composition-authority.json",
];

const fileMapExamples = [
  "docs/examples/structures/review-composition-file-map.json",
  "docs/examples/structures/single-file-map.json",
];

type ParsedStructure = ReturnType<typeof structureContentInputSchema.parse>;

function parseStructure(filePath: string): {
  raw: Record<string, unknown> & { nodes: Array<Record<string, unknown>> };
  structure: ParsedStructure;
} {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown> & {
    nodes: Array<Record<string, unknown>>;
  };
  return { raw, structure: structureContentInputSchema.parse(raw) };
}

function committedSource(sourceOid: string, filePath: string): string {
  return execFileSync("git", ["show", `${sourceOid}:${filePath}`], { encoding: "utf8" });
}

function expectSourceReachableFromHead(sourceOid: string): void {
  execFileSync("git", ["merge-base", "--is-ancestor", sourceOid, "HEAD"], {
    stdio: "ignore",
  });
}

function expectExactAnchors(structure: ParsedStructure): void {
  expectSourceReachableFromHead(structure.sourceOid);
  const anchors = [
    ...structure.nodes.flatMap((node) => (node.anchor ? [node.anchor] : [])),
    ...structure.edges.flatMap((edge) => edge.anchors),
  ];

  for (const anchor of anchors) {
    const source = committedSource(structure.sourceOid, anchor.path);
    const lineCount = source.endsWith("\n")
      ? source.split("\n").length - 1
      : source.split("\n").length;
    if (anchor.startLine !== null && anchor.endLine !== null) {
      expect(anchor.startLine).toBeGreaterThanOrEqual(1);
      expect(anchor.endLine).toBeLessThanOrEqual(lineCount);
    }
  }
}

describe("Structure producer examples", () => {
  it.each(behaviorExamples)("keeps behavior example %s valid and exact", (filePath) => {
    const { structure } = parseStructure(filePath);

    expect(structure.nodes.length).toBeGreaterThanOrEqual(2);
    expect(structure.edges.length).toBeGreaterThanOrEqual(1);
    expectExactAnchors(structure);
  });

  it.each(fileMapExamples)("keeps file-map example %s one-file-per-node and exact", (filePath) => {
    const { raw, structure } = parseStructure(filePath);
    const nodePaths = structure.nodes.map((node) => node.anchor?.path);

    expect(new Set(nodePaths).size).toBe(structure.nodes.length);
    for (const [index, node] of structure.nodes.entries()) {
      expect(node.anchor).not.toBeNull();
      expect(node.anchor).toMatchObject({ startLine: null, endLine: null });
      expect(node.label).toContain(path.posix.basename(node.anchor!.path));
      expect(raw.nodes[index]).not.toHaveProperty("kind");
      expect(raw.nodes[index]).not.toHaveProperty("notation");
    }
    for (const edge of structure.edges) {
      expect(edge.anchors.length).toBeGreaterThan(0);
      expect(edge.label).not.toMatch(/^(?:related to|same PR|connects?)$/iu);
      for (const anchor of edge.anchors) {
        expect(anchor.startLine).not.toBeNull();
        expect(anchor.endLine).not.toBeNull();
      }
    }
    expectExactAnchors(structure);
  });

  it("keeps the single-file change as one node with no invented relation", () => {
    const { structure } = parseStructure("docs/examples/structures/single-file-map.json");
    const changedPaths = execFileSync(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", structure.sourceOid],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");

    expect(changedPaths).toEqual(["docs/implementation-spec.md"]);
    expect(structure.nodes).toHaveLength(1);
    expect(structure.nodes[0]!.anchor?.path).toBe(changedPaths[0]);
    expect(structure.edges).toEqual([]);
    expect(structure.presentation).toBeNull();
  });

  it("uses unchanged surrounding source when the multi-file map needs it", () => {
    const { structure } = parseStructure(
      "docs/examples/structures/review-composition-file-map.json",
    );
    const changedPaths = new Set(
      execFileSync(
        "git",
        ["diff-tree", "--no-commit-id", "--name-only", "-r", structure.sourceOid],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n"),
    );

    expect(structure.nodes.some((node) => !changedPaths.has(node.anchor!.path))).toBe(true);
    expect(structure.nodes.some((node) => node.anchor!.path === "src/cli/main.ts")).toBe(true);
  });
});
