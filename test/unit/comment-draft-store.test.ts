import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCommentDraftsForPullRequest,
  commentDraftContextKey,
  commentReplyDraftScope,
  currentCommentDraftRevision,
  moveCommentDraftsForWorkspaceTransition,
  readCommentDraft,
  readCommentReplyDraft,
  writeCommentDraft,
  writeCommentReplyDraft,
  type CommentDraftState,
} from "../../src/web/comment-draft-store.js";
import {
  moveDocumentToPane,
  removeDocumentFromWorkspace,
  type ActiveDocument,
  type DocumentWorkspaceState,
} from "../../src/web/document-workspace.js";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const draft: CommentDraftState = {
  body: "未送信ドラフト",
  selection: null,
  markdownComposerOpen: false,
  fileComposerOpen: true,
};

function contextKey(activeDocument: ActiveDocument, pane: "left" | "right" = "left"): string {
  return commentDraftContextKey({
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

  it("isolates the same document by pane", () => {
    const document: ActiveDocument = { kind: "repository-file", path: "src/example.ts" };

    expect(contextKey(document, "left")).not.toBe(contextKey(document, "right"));
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

    clearCommentDraftsForPullRequest(pullRequestId);
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
    });
    expect(readCommentReplyDraft(pullRequestId, sourceKey).body).toBe("移動元の返信");
    expect(readCommentReplyDraft(pullRequestId, targetKey).body).toBe("移動先の返信");
    expect(readCommentDraft(pullRequestId, otherSourceKey)).toEqual(draft);
  });
});
