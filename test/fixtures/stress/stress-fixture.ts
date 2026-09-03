import type { CommentTarget, Structure } from "../../../src/domain/models.js";

export interface StressCommentInput {
  target: CommentTarget;
  body: string;
  authorLabel: string;
}

export function createStressCommentInputs(
  count: number,
  options: {
    pullRequestId: string;
    sourceOid: string;
    path: string;
    line?: number;
  },
): StressCommentInput[] {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("stress comment count is invalid");
  const line = options.line ?? 1;
  return Array.from({ length: count }, (_, index) => ({
    target: {
      kind: "document",
      documentKind: "repository-file",
      sourceOid: options.sourceOid,
      path: options.path,
      startLine: line,
      endLine: line,
    },
    body: `Performance fixture ${index + 1}`,
    authorLabel: "Performance fixture",
  }));
}

export type StressGraphShape = "linear" | "fan-out" | "fan-in" | "dense" | "disconnected" | "cycle";

export function createStructureStressFixture(options: {
  nodeCount: 20 | 100 | 500;
  shape: StressGraphShape;
  longLabels?: boolean;
}): Structure {
  const { nodeCount, shape, longLabels = false } = options;
  const sourceOid = "e".repeat(40);
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `node-${index}`,
    label: longLabels
      ? `Stress node ${index} with a deliberately long responsibility label for wrapping and viewport coverage`
      : `Stress node ${index}`,
    description: index % 5 === 0 ? `Synthetic responsibility ${index}` : null,
    kind: index === 0 ? "entrypoint" : "component",
    notation: index % 3 === 0 ? ("component" as const) : ("concept" as const),
    anchor:
      index % 3 === 0
        ? { path: `src/stress/group-${index % 10}.ts`, startLine: index + 1, endLine: index + 1 }
        : null,
  }));
  const edge = (from: number, to: number, suffix = "") => ({
    id: `edge-${from}-${to}${suffix}`,
    from: `node-${from}`,
    to: `node-${to}`,
    label: longLabels
      ? `relates stress responsibility ${from} to ${to} through a deliberately long processing contract`
      : `relates ${from} to ${to}`,
    directed: true,
    anchors:
      (from + to) % 4 === 0
        ? [{ path: `src/stress/group-${from % 10}.ts`, startLine: from + 1, endLine: from + 2 }]
        : [],
  });
  const edges: Structure["edges"] = [];
  if (shape === "linear" || shape === "cycle" || shape === "disconnected") {
    const connectedCount = shape === "disconnected" ? Math.max(1, nodeCount - 3) : nodeCount;
    for (let index = 0; index < connectedCount - 1; index += 1) {
      edges.push(edge(index, index + 1));
    }
    if (shape === "cycle") edges.push(edge(nodeCount - 1, 0, "-cycle"));
  }
  if (shape === "fan-out") {
    for (let index = 1; index < nodeCount; index += 1) edges.push(edge(0, index));
  }
  if (shape === "fan-in") {
    for (let index = 0; index < nodeCount - 1; index += 1) {
      edges.push(edge(index, nodeCount - 1));
    }
  }
  if (shape === "dense") {
    for (let index = 0; index < nodeCount; index += 1) {
      for (let offset = 1; offset <= Math.min(3, nodeCount - 1); offset += 1) {
        const target = (index + offset) % nodeCount;
        edges.push(edge(index, target, `-${offset}`));
      }
    }
  }
  return {
    id: `76000000-0000-4000-8000-${String(nodeCount).padStart(12, "0")}`,
    ref: `rvw://structure/76000000-0000-4000-8000-${String(nodeCount).padStart(12, "0")}`,
    pullRequestId: "11111111-1111-4111-8111-111111111111",
    sourceOid,
    title: `${shape} ${nodeCount}-node stress graph`,
    scope: "Synthetic graph-shape and rendering-pressure coverage without a product narrative.",
    originNodeId: shape === "fan-in" ? `node-${nodeCount - 1}` : "node-0",
    nodes,
    edges,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}

export function createLongStressDocument(lineCount = 10_000): string {
  if (!Number.isSafeInteger(lineCount) || lineCount < 1) {
    throw new Error("stress document line count is invalid");
  }
  return `${Array.from(
    { length: lineCount },
    (_, index) => `stress line ${index + 1}: ${"payload ".repeat((index % 8) + 1).trimEnd()}`,
  ).join("\n")}\n`;
}
