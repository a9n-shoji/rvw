import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCommentDraftsForReview,
  commentDraftContextKey,
  commentReplyDraftScope,
  currentCommentDraftRevision,
  deleteCommentDraftForIssue,
  moveCommentDraftsForWorkspaceTransition,
  readCommentDraft,
  readCommentReplyDraft,
  writeCommentDraft,
  writeCommentReplyDraft,
  type CommentDraftState,
} from "../../src/web/comment-draft-store.js";
import {
  assignDocumentToPane,
  moveDocumentToPane,
  removeDocumentFromWorkspace,
  type ActiveDocument,
  type DocumentWorkspaceState,
} from "../../src/web/document-workspace.js";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const draft: CommentDraftState = {
  body: "未送信ドラフト",
  selection: null,
  documentRevision: null,
  markdownComposerOpen: false,
  fileComposerOpen: true,
};
const issueDocument: ActiveDocument = {
  kind: "issue",
  id: "issue-142",
  number: 142,
  title: "同期中も入力を保持する",
  url: "https://github.com/example/repository/issues/142",
};

function contextKey(
  activeDocument: ActiveDocument,
  pane: "left" | "right" = "left",
  reviewKind: "pull-request" | "repository" = "pull-request",
): string {
  return commentDraftContextKey({
    reviewKind,
    activeDocument,
    pane,
    selectedOid: "c".repeat(40),
    oldOid: "b".repeat(40),
    displayMode: "range",
  });
}

function workspace(left: ActiveDocument[], right: ActiveDocument[]): DocumentWorkspaceState {
  return {
    documents: { left, right },
    active: { left: left[0] ?? null, right: right[0] ?? null },
    focusedPane: right.length > 0 ? "right" : "left",
    navigationRevision: { left: 0, right: 0 },
  };
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

  it("keeps each pane's Issue draft identity stable across source refreshes", () => {
    const left = contextKey(issueDocument, "left");
    const right = contextKey(issueDocument, "right");
    const refreshedLeft = commentDraftContextKey({
      reviewKind: "pull-request",
      activeDocument: issueDocument,
      pane: "left",
      selectedOid: "d".repeat(40),
      oldOid: null,
      displayMode: "full",
    });
    const refreshedRight = commentDraftContextKey({
      reviewKind: "pull-request",
      activeDocument: issueDocument,
      pane: "right",
      selectedOid: "d".repeat(40),
      oldOid: null,
      displayMode: "full",
    });

    expect(right).not.toBe(left);
    expect(refreshedLeft).toBe(left);
    expect(refreshedRight).toBe(right);
  });

  it("keeps a current Repository Review file draft key stable across source refreshes", () => {
    const document: ActiveDocument = { kind: "repository-file", path: "src/example.ts" };
    const first = contextKey(document, "left", "repository");
    const refreshed = commentDraftContextKey({
      reviewKind: "repository",
      activeDocument: document,
      pane: "left",
      selectedOid: "d".repeat(40),
      oldOid: null,
      displayMode: "full",
    });
    const exact = contextKey(
      {
        ...document,
        sourceOid: "d".repeat(40),
        comparisonPolicy: "exact-source",
      },
      "left",
      "repository",
    );

    expect(refreshed).toBe(first);
    expect(exact).not.toBe(first);
  });

  it("rejects replacing a current file with an exact-source variant while its draft is open", () => {
    const current: ActiveDocument = { kind: "repository-file", path: "src/example.ts" };
    const exact: ActiveDocument = {
      ...current,
      sourceOid: "a".repeat(40),
      comparisonPolicy: "exact-source",
    };
    const previous = workspace([current], []);
    const next = assignDocumentToPane(previous, exact, "left");
    const key = contextKey(current, "left", "repository");
    writeCommentDraft(pullRequestId, key, currentCommentDraftRevision(pullRequestId, key), draft);

    expect(moveCommentDraftsForWorkspaceTransition(pullRequestId, previous, next)).toEqual({
      status: "conflict",
      reason: "document-replacement",
    });
    expect(readCommentDraft(pullRequestId, key)).toEqual(draft);
  });

  it("rejects replacing one pane's current source when it survives in the other pane", () => {
    const current: ActiveDocument = { kind: "repository-file", path: "src/example.ts" };
    const exact: ActiveDocument = {
      ...current,
      sourceOid: "a".repeat(40),
      comparisonPolicy: "exact-source",
    };
    const previous = workspace([current], [current]);
    const next = assignDocumentToPane(previous, exact, "left");
    const key = contextKey(current, "left", "repository");
    writeCommentDraft(pullRequestId, key, currentCommentDraftRevision(pullRequestId, key), draft);

    expect(moveCommentDraftsForWorkspaceTransition(pullRequestId, previous, next)).toEqual({
      status: "conflict",
      reason: "document-replacement",
    });
    expect(readCommentDraft(pullRequestId, key)).toEqual(draft);
  });

  it("rejects a cross-pane current/exact-source replacement after pane normalization", () => {
    const current: ActiveDocument = { kind: "repository-file", path: "src/example.ts" };
    const exact: ActiveDocument = {
      ...current,
      sourceOid: "a".repeat(40),
      comparisonPolicy: "exact-source",
    };
    const previous = workspace([current], [exact]);
    const next = moveDocumentToPane(previous, current, "left", "right");
    const key = contextKey(exact, "right", "repository");
    writeCommentDraft(pullRequestId, key, currentCommentDraftRevision(pullRequestId, key), draft);

    expect(next).toMatchObject({
      documents: { left: [current], right: [] },
    });
    expect(moveCommentDraftsForWorkspaceTransition(pullRequestId, previous, next)).toEqual({
      status: "conflict",
      reason: "document-replacement",
    });
    expect(readCommentDraft(pullRequestId, key)).toEqual(draft);
  });

  it("rejects replacing an exact-source document that owns only an inline reply draft", () => {
    const current: ActiveDocument = { kind: "repository-file", path: "src/example.ts" };
    const exact: ActiveDocument = {
      ...current,
      sourceOid: "a".repeat(40),
      comparisonPolicy: "exact-source",
    };
    const previous = workspace([current], [exact]);
    const next = moveDocumentToPane(previous, current, "left", "right");
    const replyKey = `inline:${commentReplyDraftScope("right", exact)}:comment-1`;
    writeCommentReplyDraft(pullRequestId, replyKey, {
      ...readCommentReplyDraft(pullRequestId, replyKey),
      body: "置換で隠してはいけない返信",
    });

    expect(moveCommentDraftsForWorkspaceTransition(pullRequestId, previous, next)).toEqual({
      status: "conflict",
      reason: "document-replacement",
    });
    expect(readCommentReplyDraft(pullRequestId, replyKey).body).toBe("置換で隠してはいけない返信");
  });

  it("isolates the same document by pane", () => {
    const document: ActiveDocument = { kind: "repository-file", path: "src/example.ts" };

    expect(contextKey(document, "left")).not.toBe(contextKey(document, "right"));
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

  it("clears both panes for only the removed Issue and rejects their stale unmount writes", () => {
    const removedLeftKey = contextKey(issueDocument, "left");
    const removedRightKey = contextKey(issueDocument, "right");
    const retainedIssueKey = contextKey({
      kind: "issue",
      id: "issue-143",
      number: 143,
      title: "Keep this Issue",
      url: "https://github.com/example/repository/issues/143",
    });
    const fileKey = contextKey({ kind: "repository-file", path: "src/example.ts" });
    const removedLeftRevision = currentCommentDraftRevision(pullRequestId, removedLeftKey);
    const removedRightRevision = currentCommentDraftRevision(pullRequestId, removedRightKey);
    const retainedRevision = currentCommentDraftRevision(pullRequestId, retainedIssueKey);
    const fileRevision = currentCommentDraftRevision(pullRequestId, fileKey);
    writeCommentDraft(pullRequestId, removedLeftKey, removedLeftRevision, draft);
    writeCommentDraft(pullRequestId, removedRightKey, removedRightRevision, {
      ...draft,
      body: "右ペインの未送信ドラフト",
    });
    writeCommentDraft(pullRequestId, retainedIssueKey, retainedRevision, draft);
    writeCommentDraft(pullRequestId, fileKey, fileRevision, draft);

    deleteCommentDraftForIssue(pullRequestId, "issue-142");

    expect(readCommentDraft(pullRequestId, removedLeftKey)).toBeUndefined();
    expect(readCommentDraft(pullRequestId, removedRightKey)).toBeUndefined();
    expect(readCommentDraft(pullRequestId, retainedIssueKey)).toEqual(draft);
    expect(readCommentDraft(pullRequestId, fileKey)).toEqual(draft);
    writeCommentDraft(pullRequestId, removedLeftKey, removedLeftRevision, draft);
    writeCommentDraft(pullRequestId, removedRightKey, removedRightRevision, draft);
    expect(readCommentDraft(pullRequestId, removedLeftKey)).toBeUndefined();
    expect(readCommentDraft(pullRequestId, removedRightKey)).toBeUndefined();

    const reopenedRevision = currentCommentDraftRevision(pullRequestId, removedLeftKey);
    expect(reopenedRevision).not.toBe(removedLeftRevision);
    writeCommentDraft(pullRequestId, removedLeftKey, reopenedRevision, draft);
    expect(readCommentDraft(pullRequestId, removedLeftKey)).toEqual(draft);
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

  it("moves reply and new-comment drafts with an explicit tab transition", () => {
    const document: ActiveDocument = { kind: "repository-file", path: "src/example.ts" };
    const previous = workspace([{ kind: "pull-request-markdown" }, document], []);
    const next = moveDocumentToPane(previous, document, "left", "right");
    const viewerDocument: ActiveDocument = {
      ...document,
      oldPath: "src/example-old.ts",
      newPath: "src/example.ts",
    };
    const sourceKey = `inline:${commentReplyDraftScope("left", document)}:comment-1`;
    const targetKey = `inline:${commentReplyDraftScope("right", document)}:comment-1`;
    const sourceCommentKey = contextKey(viewerDocument, "left");
    const targetCommentKey = contextKey(viewerDocument, "right");
    const initial = readCommentReplyDraft(pullRequestId, sourceKey);
    writeCommentReplyDraft(pullRequestId, sourceKey, {
      ...initial,
      body: "タブと一緒に移動する返信",
    });
    writeCommentDraft(
      pullRequestId,
      sourceCommentKey,
      currentCommentDraftRevision(pullRequestId),
      draft,
    );

    expect(moveCommentDraftsForWorkspaceTransition(pullRequestId, previous, next)).toEqual({
      status: "applied",
      commentDraftsMoved: true,
    });
    expect(readCommentReplyDraft(pullRequestId, sourceKey).body).toBe("");
    expect(readCommentReplyDraft(pullRequestId, targetKey).body).toBe("タブと一緒に移動する返信");
    expect(readCommentDraft(pullRequestId, sourceCommentKey)).toBeUndefined();
    expect(readCommentDraft(pullRequestId, targetCommentKey)).toEqual(draft);
  });

  it("moves an Issue draft with its tab", () => {
    const previous = workspace([{ kind: "pull-request-markdown" }, issueDocument], []);
    const next = moveDocumentToPane(previous, issueDocument, "left", "right");
    const sourceKey = contextKey(issueDocument, "left");
    const targetKey = contextKey(issueDocument, "right");
    writeCommentDraft(
      pullRequestId,
      sourceKey,
      currentCommentDraftRevision(pullRequestId, sourceKey),
      draft,
    );

    expect(moveCommentDraftsForWorkspaceTransition(pullRequestId, previous, next)).toEqual({
      status: "applied",
      commentDraftsMoved: true,
    });
    expect(readCommentDraft(pullRequestId, sourceKey)).toBeUndefined();
    expect(readCommentDraft(pullRequestId, targetKey)).toEqual(draft);
  });

  it("rejects moving an Issue tab onto a pane with another draft for the same Issue", () => {
    const keep: ActiveDocument = { kind: "pull-request-markdown" };
    const previous = workspace([keep, issueDocument], [issueDocument]);
    const next = workspace([keep], [issueDocument]);
    const sourceKey = contextKey(issueDocument, "left");
    const targetKey = contextKey(issueDocument, "right");
    writeCommentDraft(
      pullRequestId,
      sourceKey,
      currentCommentDraftRevision(pullRequestId, sourceKey),
      draft,
    );
    writeCommentDraft(
      pullRequestId,
      targetKey,
      currentCommentDraftRevision(pullRequestId, targetKey),
      { ...draft, body: "移動先のIssue draft" },
    );

    expect(moveCommentDraftsForWorkspaceTransition(pullRequestId, previous, next)).toEqual({
      status: "conflict",
      reason: "destination",
    });
    expect(readCommentDraft(pullRequestId, sourceKey)?.body).toBe("未送信ドラフト");
    expect(readCommentDraft(pullRequestId, targetKey)?.body).toBe("移動先のIssue draft");
  });

  it("moves every right-pane draft when closing the last left tab normalizes the workspace", () => {
    const leftDocument: ActiveDocument = { kind: "pull-request-markdown" };
    const firstRight: ActiveDocument = { kind: "repository-file", path: "src/first.ts" };
    const secondRight: ActiveDocument = { kind: "repository-file", path: "src/second.ts" };
    const previous = workspace([leftDocument], [firstRight, secondRight]);
    const next = removeDocumentFromWorkspace(previous, leftDocument, "left");
    const replySource = `inline:${commentReplyDraftScope("right", firstRight)}:comment-1`;
    const replyTarget = `inline:${commentReplyDraftScope("left", firstRight)}:comment-1`;
    const commentSource = contextKey(secondRight, "right");
    const commentTarget = contextKey(secondRight, "left");
    writeCommentReplyDraft(pullRequestId, replySource, {
      ...readCommentReplyDraft(pullRequestId, replySource),
      body: "正規化でも移動する返信",
    });
    writeCommentDraft(
      pullRequestId,
      commentSource,
      currentCommentDraftRevision(pullRequestId),
      draft,
    );

    expect(moveCommentDraftsForWorkspaceTransition(pullRequestId, previous, next)).toEqual({
      status: "applied",
      commentDraftsMoved: true,
    });
    expect(readCommentReplyDraft(pullRequestId, replyTarget).body).toBe("正規化でも移動する返信");
    expect(readCommentDraft(pullRequestId, commentTarget)).toEqual(draft);
  });

  it("rejects a workspace transition atomically when a destination draft exists", () => {
    const document: ActiveDocument = { kind: "repository-file", path: "src/example.ts" };
    const keep: ActiveDocument = { kind: "pull-request-markdown" };
    const other: ActiveDocument = { kind: "repository-file", path: "src/other.ts" };
    const previous = workspace([keep, document], [document, other]);
    const next = workspace([keep, other], [document]);
    const sourceKey = `inline:${commentReplyDraftScope("left", document)}:comment-1`;
    const targetKey = `inline:${commentReplyDraftScope("right", document)}:comment-1`;
    const otherSourceKey = contextKey(other, "right");
    writeCommentReplyDraft(pullRequestId, sourceKey, {
      ...readCommentReplyDraft(pullRequestId, sourceKey),
      body: "移動元の返信",
    });
    writeCommentReplyDraft(pullRequestId, targetKey, {
      ...readCommentReplyDraft(pullRequestId, targetKey),
      body: "移動先の返信",
    });
    writeCommentDraft(
      pullRequestId,
      otherSourceKey,
      currentCommentDraftRevision(pullRequestId),
      draft,
    );

    expect(moveCommentDraftsForWorkspaceTransition(pullRequestId, previous, next)).toEqual({
      status: "conflict",
      reason: "destination",
    });
    expect(readCommentReplyDraft(pullRequestId, sourceKey).body).toBe("移動元の返信");
    expect(readCommentReplyDraft(pullRequestId, targetKey).body).toBe("移動先の返信");
    expect(readCommentDraft(pullRequestId, otherSourceKey)).toEqual(draft);
  });
});
