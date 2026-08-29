import { describe, expect, it } from "vitest";
import { currentCommitDocument, type ActiveDocument } from "../../src/web/document-workspace.js";

describe("document workspace commit rebinding", () => {
  it("keeps a resolved Walkthrough reference pinned while ordinary files follow selection", () => {
    const reference: ActiveDocument = {
      kind: "repository-file",
      path: "src/reference.ts",
      sourceOid: "c".repeat(40),
      comparisonPolicy: "reference-target",
      referenceContext: {
        outcome: "latest",
        walkthroughId: "walkthrough",
        referenceId: "reference",
        anchorSourceOid: "a".repeat(40),
        latestHeadOid: "c".repeat(40),
        referenceFingerprint: "fingerprint",
        diffBaseOid: "b".repeat(40),
        hasDiff: true,
        latestFile: null,
      },
    };

    expect(currentCommitDocument(reference)).toBe(reference);
    expect(
      currentCommitDocument({
        kind: "repository-file",
        path: "src/reference.ts",
        sourceOid: "a".repeat(40),
        comparisonPolicy: "selected-range",
      }),
    ).toEqual({ kind: "repository-file", path: "src/reference.ts" });
  });

  it("keeps a fixture Structure pinned to its exact spike source commit", () => {
    const structure: ActiveDocument = {
      kind: "structure-spike",
      id: "rvw-comment-watch-flow",
      title: "Comment watch flow",
      sourceOid: "b".repeat(40),
    };

    expect(currentCommitDocument(structure)).toBe(structure);
  });
});
