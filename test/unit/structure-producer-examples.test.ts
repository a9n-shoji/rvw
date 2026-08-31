import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { structureContentInputSchema } from "../../src/application/agent-command-schemas.js";

const examples = [
  "docs/examples/structures/agent-transport-boundary.json",
  "docs/examples/structures/markdown-source-mapping.json",
  "docs/examples/structures/skill-distribution-boundary.json",
];

describe("Structure producer examples", () => {
  it.each(examples)("keeps %s valid and exact at its declared commit", (filePath) => {
    const structure = structureContentInputSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
    const anchors = [
      ...structure.nodes.flatMap((node) => (node.anchor ? [node.anchor] : [])),
      ...structure.edges.flatMap((edge) => edge.anchors),
    ];

    expect(structure.nodes.length).toBeGreaterThanOrEqual(4);
    expect(structure.edges.length).toBeGreaterThanOrEqual(4);
    for (const anchor of anchors) {
      const source = execFileSync("git", ["show", `${structure.sourceOid}:${anchor.path}`], {
        encoding: "utf8",
      });
      const lineCount = source.endsWith("\n")
        ? source.split("\n").length - 1
        : source.split("\n").length;
      if (anchor.startLine !== null && anchor.endLine !== null) {
        expect(anchor.startLine).toBeGreaterThanOrEqual(1);
        expect(anchor.endLine).toBeLessThanOrEqual(lineCount);
      }
    }
  });
});
