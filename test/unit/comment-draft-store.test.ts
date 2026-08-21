import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCommentDraftsForReview,
  commentDraftContextKey,
  currentCommentDraftRevision,
  deleteCommentDraftForIssue,
  readCommentDraft,
  readCommentReplyDraft,
  writeCommentDraft,
  writeCommentReplyDraft,
  type CommentDraftState,
} from "../../src/web/comment-draft-store.js";
import type { ActiveDocument } from "../../src/web/document-workspace.js";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const draft: CommentDraftState = {
  body: "未送信ドラフト",
  selection: null,
  documentRevision: null,
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
  beforeEach(() => clearCommentDraftsForReview(pullRequestId));

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

  it("keeps an Issue draft identity stable across source refreshes", () => {
    const issue: ActiveDocument = {
      kind: "issue",
      id: "issue-142",
      number: 142,
      title: "同期中も入力を保持する",
      url: "https://github.com/example/repository/issues/142",
    };
    const first = contextKey(issue);
    const refreshed = commentDraftContextKey({
      activeDocument: issue,
      selectedOid: "d".repeat(40),
      oldOid: null,
      displayMode: "full",
    });

    expect(refreshed).toBe(first);
  });

  it("clears one pull request and rejects stale unmount writes", () => {
    const key = contextKey({ kind: "repository-file", path: "src/example.ts" });
    const revision = currentCommentDraftRevision(pullRequestId);
    writeCommentDraft(pullRequestId, key, revision, draft);
    expect(readCommentDraft(pullRequestId, key)).toEqual(draft);

    clearCommentDraftsForReview(pullRequestId);
    expect(readCommentDraft(pullRequestId, key)).toBeUndefined();
    expect(currentCommentDraftRevision(pullRequestId)).toBe(revision + 1);

    writeCommentDraft(pullRequestId, key, revision, draft);
    expect(readCommentDraft(pullRequestId, key)).toBeUndefined();
  });

  it("clears only the removed Issue draft and rejects its stale unmount write", () => {
    const removedIssueKey = contextKey({
      kind: "issue",
      id: "issue-142",
      number: 142,
      title: "Remove this Issue",
      url: "https://github.com/example/repository/issues/142",
    });
    const retainedIssueKey = contextKey({
      kind: "issue",
      id: "issue-143",
      number: 143,
      title: "Keep this Issue",
      url: "https://github.com/example/repository/issues/143",
    });
    const fileKey = contextKey({ kind: "repository-file", path: "src/example.ts" });
    const removedRevision = currentCommentDraftRevision(pullRequestId, removedIssueKey);
    const retainedRevision = currentCommentDraftRevision(pullRequestId, retainedIssueKey);
    const fileRevision = currentCommentDraftRevision(pullRequestId, fileKey);
    writeCommentDraft(pullRequestId, removedIssueKey, removedRevision, draft);
    writeCommentDraft(pullRequestId, retainedIssueKey, retainedRevision, draft);
    writeCommentDraft(pullRequestId, fileKey, fileRevision, draft);

    deleteCommentDraftForIssue(pullRequestId, "issue-142");

    expect(readCommentDraft(pullRequestId, removedIssueKey)).toBeUndefined();
    expect(readCommentDraft(pullRequestId, retainedIssueKey)).toEqual(draft);
    expect(readCommentDraft(pullRequestId, fileKey)).toEqual(draft);
    writeCommentDraft(pullRequestId, removedIssueKey, removedRevision, draft);
    expect(readCommentDraft(pullRequestId, removedIssueKey)).toBeUndefined();

    const reopenedRevision = currentCommentDraftRevision(pullRequestId, removedIssueKey);
    expect(reopenedRevision).not.toBe(removedRevision);
    writeCommentDraft(pullRequestId, removedIssueKey, reopenedRevision, draft);
    expect(readCommentDraft(pullRequestId, removedIssueKey)).toEqual(draft);
  });

  it("restores an in-progress reply and rejects it after the review state is reset", () => {
    const key = "inline:comment-1";
    const initial = readCommentReplyDraft(pullRequestId, key);
    writeCommentReplyDraft(pullRequestId, key, {
      ...initial,
      body: "別コメントの同期中も保持する返信",
      focused: true,
    });
    expect(readCommentReplyDraft(pullRequestId, key)).toEqual({
      revision: initial.revision,
      body: "別コメントの同期中も保持する返信",
      focused: true,
    });

    clearCommentDraftsForReview(pullRequestId);
    expect(readCommentReplyDraft(pullRequestId, key)).toEqual({
      revision: initial.revision + 1,
      body: "",
      focused: false,
    });
    writeCommentReplyDraft(pullRequestId, key, {
      ...initial,
      body: "復元してはいけない返信",
    });
    expect(readCommentReplyDraft(pullRequestId, key).body).toBe("");
  });
});
