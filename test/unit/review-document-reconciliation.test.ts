import { describe, expect, it } from "vitest";
import type { ActiveDocument, DocumentWorkspaceState } from "../../src/web/document-workspace.js";
import { reconcileReviewDocumentWorkspace } from "../../src/web/use-review-document-reconciliation.js";

describe("review document reconciliation", () => {
  it("rebinds open Issue and Walkthrough metadata to refreshed summaries", () => {
    const issue: ActiveDocument = {
      kind: "issue",
      id: "issue-1",
      number: 23,
      title: "Old issue title",
      url: "https://github.com/acme/review-repo/issues/23",
    };
    const walkthrough: ActiveDocument = {
      kind: "walkthrough",
      id: "walkthrough-1",
      title: "Old walkthrough title",
      sourceOid: "a".repeat(40),
    };
    const current: DocumentWorkspaceState = {
      documents: { left: [issue], right: [walkthrough] },
      active: { left: issue, right: walkthrough },
      focusedPane: "left",
      navigationRevision: { left: 2, right: 3 },
    };

    const reconciled = reconcileReviewDocumentWorkspace(current, {
      issues: [
        {
          id: "issue-1",
          number: 23,
          title: "Current issue title",
          url: "https://github.com/acme/review-repo/issues/23?updated=1",
        },
      ],
      issuesEnabled: true,
      walkthroughs: [
        {
          id: "walkthrough-1",
          title: "Current walkthrough title",
          sourceOid: "b".repeat(40),
        },
      ],
      walkthroughsEnabled: true,
    });

    expect(reconciled.documents.left[0]).toEqual({
      kind: "issue",
      id: "issue-1",
      number: 23,
      title: "Current issue title",
      url: "https://github.com/acme/review-repo/issues/23?updated=1",
    });
    expect(reconciled.documents.right[0]).toEqual({
      kind: "walkthrough",
      id: "walkthrough-1",
      title: "Current walkthrough title",
      sourceOid: "b".repeat(40),
    });
    expect(reconciled.active.left).toBe(reconciled.documents.left[0]);
    expect(reconciled.active.right).toBe(reconciled.documents.right[0]);
    expect(reconciled.navigationRevision).toEqual({ left: 2, right: 3 });
  });

  it("keeps an externally removed Issue open so draft-aware removal remains authoritative", () => {
    const issue: ActiveDocument = {
      kind: "issue",
      id: "issue-1",
      number: 23,
      title: "Draft target",
      url: "https://github.com/acme/review-repo/issues/23",
    };
    const current: DocumentWorkspaceState = {
      documents: { left: [issue], right: [] },
      active: { left: issue, right: null },
      focusedPane: "left",
      navigationRevision: { left: 0, right: 0 },
    };

    expect(
      reconcileReviewDocumentWorkspace(current, {
        issues: [],
        issuesEnabled: true,
        walkthroughs: [],
        walkthroughsEnabled: false,
      }),
    ).toBe(current);
  });
});
