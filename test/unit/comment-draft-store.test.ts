import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCommentDraftsForPullRequest,
  commentDraftContextKey,
  commentReplyDraftScope,
  currentCommentDraftRevision,
  moveCommentReplyDraftsForDocument,
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

  it("moves a reply draft with its tab without overwriting a destination draft", () => {
    const document: ActiveDocument = { kind: "repository-file", path: "src/example.ts" };
    const sourceKey = `inline:${commentReplyDraftScope("left", document)}:comment-1`;
    const targetKey = `inline:${commentReplyDraftScope("right", document)}:comment-1`;
    const initial = readCommentReplyDraft(pullRequestId, sourceKey);
    writeCommentReplyDraft(pullRequestId, sourceKey, {
      ...initial,
      body: "タブと一緒に移動する返信",
    });

    expect(moveCommentReplyDraftsForDocument(pullRequestId, document, "left", "right")).toBe(true);
    expect(readCommentReplyDraft(pullRequestId, sourceKey).body).toBe("");
    expect(readCommentReplyDraft(pullRequestId, targetKey).body).toBe("タブと一緒に移動する返信");

    writeCommentReplyDraft(pullRequestId, sourceKey, {
      ...initial,
      body: "上書きしてはいけない返信",
    });
    expect(moveCommentReplyDraftsForDocument(pullRequestId, document, "left", "right")).toBe(false);
    expect(readCommentReplyDraft(pullRequestId, sourceKey).body).toBe("上書きしてはいけない返信");
    expect(readCommentReplyDraft(pullRequestId, targetKey).body).toBe("タブと一緒に移動する返信");
  });
});
