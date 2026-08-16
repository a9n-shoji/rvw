import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCommentDraftsForPullRequest,
  commentDraftContextKey,
  currentCommentDraftRevision,
  readCommentDraft,
  writeCommentDraft,
  type CommentDraftState,
} from "../../src/web/comment-draft-store.js";
import type { ActiveDocument } from "../../src/web/document-workspace.js";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const draft: CommentDraftState = {
  body: "未送信ドラフト",
  selection: null,
  markdownComposerOpen: false,
  fileComposerOpen: true,
};

function contextKey(activeDocument: ActiveDocument): string {
  return commentDraftContextKey({
    activeDocument,
    selectedOid: "c".repeat(40),
    oldOid: "b".repeat(40),
    displayMode: "range",
  });
}

describe("comment draft store", () => {
  beforeEach(() => clearCommentDraftsForPullRequest(pullRequestId));

  it("isolates the same path by exact source and comparison policy", () => {
    const current = contextKey({ kind: "repository-file", path: "src/example.ts" });
    const exactFirst = contextKey({
      kind: "repository-file",
      path: "src/example.ts",
      sourceOid: "a".repeat(40),
      comparisonPolicy: "exact-source",
    });
    const exactSecond = contextKey({
      kind: "repository-file",
      path: "src/example.ts",
      sourceOid: "d".repeat(40),
      comparisonPolicy: "exact-source",
    });

    expect(new Set([current, exactFirst, exactSecond]).size).toBe(3);
  });

  it("clears one pull request and rejects stale unmount writes", () => {
    const key = contextKey({ kind: "repository-file", path: "src/example.ts" });
    const revision = currentCommentDraftRevision(pullRequestId);
    writeCommentDraft(pullRequestId, key, revision, draft);
    expect(readCommentDraft(pullRequestId, key)).toEqual(draft);

    clearCommentDraftsForPullRequest(pullRequestId);
    expect(readCommentDraft(pullRequestId, key)).toBeUndefined();
    expect(currentCommentDraftRevision(pullRequestId)).toBe(revision + 1);

    writeCommentDraft(pullRequestId, key, revision, draft);
    expect(readCommentDraft(pullRequestId, key)).toBeUndefined();
  });
});
