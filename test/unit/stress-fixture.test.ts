import { describe, expect, it } from "vitest";
import {
  createLongStressDocument,
  createStressCommentInputs,
  createStructureStressFixture,
  type StressGraphShape,
} from "../fixtures/stress/stress-fixture.js";

describe("stress fixture generators", () => {
  it("creates the 100-comment workload used by viewer performance coverage", () => {
    const comments = createStressCommentInputs(100, {
      pullRequestId: "pr",
      sourceOid: "a".repeat(40),
      path: "src/deep.ts",
      line: 7_500,
    });
    expect(comments).toHaveLength(100);
    expect(comments[0]).toMatchObject({ body: "Performance fixture 1" });
    expect(comments.at(-1)).toMatchObject({
      body: "Performance fixture 100",
      target: { startLine: 7_500, endLine: 7_500 },
    });
  });

  it.each([20, 100, 500] as const)("creates mixed source/concept %i-node graphs", (nodeCount) => {
    const graph = createStructureStressFixture({ nodeCount, shape: "linear" });
    expect(graph.nodes).toHaveLength(nodeCount);
    expect(graph.edges).toHaveLength(nodeCount - 1);
    expect(graph.nodes.some(({ anchor }) => anchor !== null)).toBe(true);
    expect(graph.nodes.some(({ anchor }) => anchor === null)).toBe(true);
  });

  it.each<StressGraphShape>(["fan-out", "fan-in", "dense", "disconnected", "cycle"])(
    "creates the %s graph shape",
    (shape) => {
      const graph = createStructureStressFixture({ nodeCount: 20, shape, longLabels: true });
      expect(graph.nodes).toHaveLength(20);
      expect(graph.nodes[0]?.label.length).toBeGreaterThan(60);
      expect(graph.edges[0]?.label.length).toBeGreaterThan(60);
      if (shape === "fan-out")
        expect(graph.edges.filter(({ from }) => from === "node-0")).toHaveLength(19);
      if (shape === "fan-in")
        expect(graph.edges.filter(({ to }) => to === "node-19")).toHaveLength(19);
      if (shape === "dense") expect(graph.edges.length).toBeGreaterThan(40);
      if (shape === "disconnected") expect(graph.edges).toHaveLength(16);
      if (shape === "cycle")
        expect(graph.edges.at(-1)).toMatchObject({ from: "node-19", to: "node-0" });
    },
  );

  it("creates a long document with stable deep lines", () => {
    const document = createLongStressDocument();
    expect(document.split("\n")).toHaveLength(10_001);
    expect(document.split("\n")[7_499]).toContain("stress line 7500");
  });
});
