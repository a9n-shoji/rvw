import type { SelectedLineRange } from "@pierre/diffs/react";
import type { ActiveDocument, DocumentPaneId } from "./document-workspace.js";

export interface CommentDraftState {
  body: string;
  selection: SelectedLineRange | null;
  markdownComposerOpen: boolean;
  fileComposerOpen: boolean;
}

export interface CommentDraftContext {
  activeDocument: ActiveDocument;
  pane: DocumentPaneId;
  selectedOid: string;
  oldOid: string | null;
  displayMode: "full" | "pull-request" | "range";
}

export interface CommentReplyDraftSnapshot {
  revision: number;
  body: string;
  focused: boolean;
}

const draftsByPullRequest = new Map<string, Map<string, CommentDraftState>>();
const replyDraftsByPullRequest = new Map<string, Map<string, CommentReplyDraftSnapshot>>();
const emptyReplyDraftByPullRequest = new Map<string, CommentReplyDraftSnapshot>();
const replyDraftListeners = new Set<() => void>();
const revisionByPullRequest = new Map<string, number>();

function documentIdentity(document: ActiveDocument): unknown[] {
  if (document.kind === "pull-request-markdown") return ["pull-request-markdown"];
  if (document.kind === "walkthrough") {
    return ["walkthrough", document.id, document.sourceOid];
  }
  return [
    "repository-file",
    document.path,
    document.oldPath ?? null,
    document.newPath ?? null,
    document.sourceOid ?? null,
    document.comparisonPolicy ?? null,
  ];
}

export function commentDraftContextKey(context: CommentDraftContext): string {
  return JSON.stringify([
    context.pane,
    documentIdentity(context.activeDocument),
    context.selectedOid,
    context.oldOid,
    context.displayMode,
  ]);
}

export function currentCommentDraftRevision(pullRequestId: string): number {
  return revisionByPullRequest.get(pullRequestId) ?? 0;
}

function emptyCommentReplyDraft(pullRequestId: string): CommentReplyDraftSnapshot {
  const revision = currentCommentDraftRevision(pullRequestId);
  const existing = emptyReplyDraftByPullRequest.get(pullRequestId);
  if (existing?.revision === revision) return existing;
  const empty = { revision, body: "", focused: false };
  emptyReplyDraftByPullRequest.set(pullRequestId, empty);
  return empty;
}

function notifyReplyDraftListeners(): void {
  for (const listener of replyDraftListeners) listener();
}

export function subscribeCommentReplyDrafts(listener: () => void): () => void {
  replyDraftListeners.add(listener);
  return () => replyDraftListeners.delete(listener);
}

export function readCommentReplyDraft(
  pullRequestId: string,
  contextKey: string,
): CommentReplyDraftSnapshot {
  return (
    replyDraftsByPullRequest.get(pullRequestId)?.get(contextKey) ??
    emptyCommentReplyDraft(pullRequestId)
  );
}

export function writeCommentReplyDraft(
  pullRequestId: string,
  contextKey: string,
  draft: CommentReplyDraftSnapshot,
): void {
  if (draft.revision !== currentCommentDraftRevision(pullRequestId)) return;
  const existing = readCommentReplyDraft(pullRequestId, contextKey);
  if (existing.body === draft.body && existing.focused === draft.focused) return;
  let drafts = replyDraftsByPullRequest.get(pullRequestId);
  if (!drafts) {
    drafts = new Map();
    replyDraftsByPullRequest.set(pullRequestId, drafts);
  }
  if (draft.body || draft.focused) drafts.set(contextKey, draft);
  else drafts.delete(contextKey);
  if (drafts.size === 0) replyDraftsByPullRequest.delete(pullRequestId);
  notifyReplyDraftListeners();
}

export function deleteCommentReplyDraftsForComment(pullRequestId: string, commentId: string): void {
  const drafts = replyDraftsByPullRequest.get(pullRequestId);
  if (!drafts) return;
  let deleted = false;
  for (const contextKey of drafts.keys()) {
    if (!contextKey.endsWith(`:${commentId}`)) continue;
    drafts.delete(contextKey);
    deleted = true;
  }
  if (!deleted) return;
  if (drafts.size === 0) replyDraftsByPullRequest.delete(pullRequestId);
  notifyReplyDraftListeners();
}

export function readCommentDraft(
  pullRequestId: string,
  contextKey: string,
): CommentDraftState | undefined {
  return draftsByPullRequest.get(pullRequestId)?.get(contextKey);
}

export function writeCommentDraft(
  pullRequestId: string,
  contextKey: string,
  revision: number,
  draft: CommentDraftState,
): void {
  if (revision !== currentCommentDraftRevision(pullRequestId)) return;
  let drafts = draftsByPullRequest.get(pullRequestId);
  if (!drafts) {
    drafts = new Map();
    draftsByPullRequest.set(pullRequestId, drafts);
  }
  drafts.set(contextKey, draft);
}

export function deleteCommentDraft(
  pullRequestId: string,
  contextKey: string,
  revision: number,
): void {
  if (revision !== currentCommentDraftRevision(pullRequestId)) return;
  const drafts = draftsByPullRequest.get(pullRequestId);
  drafts?.delete(contextKey);
  if (drafts?.size === 0) draftsByPullRequest.delete(pullRequestId);
}

export function clearCommentDraftsForPullRequest(pullRequestId: string): void {
  draftsByPullRequest.delete(pullRequestId);
  replyDraftsByPullRequest.delete(pullRequestId);
  revisionByPullRequest.set(pullRequestId, currentCommentDraftRevision(pullRequestId) + 1);
  emptyReplyDraftByPullRequest.delete(pullRequestId);
  notifyReplyDraftListeners();
}
