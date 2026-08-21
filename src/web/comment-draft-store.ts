import type { SelectedLineRange } from "@pierre/diffs/react";
import type { ActiveDocument } from "./document-workspace.js";

export interface CommentDraftState {
  body: string;
  selection: SelectedLineRange | null;
  documentRevision: string | null;
  markdownComposerOpen: boolean;
  fileComposerOpen: boolean;
}

export interface CommentDraftContext {
  activeDocument: ActiveDocument;
  selectedOid: string;
  oldOid: string | null;
  displayMode: "full" | "pull-request" | "range";
}

export interface CommentReplyDraftSnapshot {
  revision: number;
  body: string;
  focused: boolean;
}

const draftsByReview = new Map<string, Map<string, CommentDraftState>>();
const replyDraftsByReview = new Map<string, Map<string, CommentReplyDraftSnapshot>>();
const emptyReplyDraftByReview = new Map<string, CommentReplyDraftSnapshot>();
const replyDraftListeners = new Set<() => void>();
const revisionByReview = new Map<string, number>();

function documentIdentity(document: ActiveDocument): unknown[] {
  if (document.kind === "pull-request-markdown") return ["pull-request-markdown"];
  if (document.kind === "walkthrough") {
    return ["walkthrough", document.id, document.sourceOid];
  }
  if (document.kind === "issue") return ["issue", document.id];
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
  if (context.activeDocument.kind === "issue") {
    return JSON.stringify([documentIdentity(context.activeDocument)]);
  }
  return JSON.stringify([
    documentIdentity(context.activeDocument),
    context.selectedOid,
    context.oldOid,
    context.displayMode,
  ]);
}

export function currentCommentDraftRevision(reviewId: string): number {
  return revisionByReview.get(reviewId) ?? 0;
}

function emptyCommentReplyDraft(reviewId: string): CommentReplyDraftSnapshot {
  const revision = currentCommentDraftRevision(reviewId);
  const existing = emptyReplyDraftByReview.get(reviewId);
  if (existing?.revision === revision) return existing;
  const empty = { revision, body: "", focused: false };
  emptyReplyDraftByReview.set(reviewId, empty);
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
  reviewId: string,
  contextKey: string,
): CommentReplyDraftSnapshot {
  return replyDraftsByReview.get(reviewId)?.get(contextKey) ?? emptyCommentReplyDraft(reviewId);
}

export function writeCommentReplyDraft(
  reviewId: string,
  contextKey: string,
  draft: CommentReplyDraftSnapshot,
): void {
  if (draft.revision !== currentCommentDraftRevision(reviewId)) return;
  const existing = readCommentReplyDraft(reviewId, contextKey);
  if (existing.body === draft.body && existing.focused === draft.focused) return;
  let drafts = replyDraftsByReview.get(reviewId);
  if (!drafts) {
    drafts = new Map();
    replyDraftsByReview.set(reviewId, drafts);
  }
  if (draft.body || draft.focused) drafts.set(contextKey, draft);
  else drafts.delete(contextKey);
  if (drafts.size === 0) replyDraftsByReview.delete(reviewId);
  notifyReplyDraftListeners();
}

export function deleteCommentReplyDraftsForComment(reviewId: string, commentId: string): void {
  const drafts = replyDraftsByReview.get(reviewId);
  if (!drafts) return;
  let deleted = false;
  for (const contextKey of drafts.keys()) {
    if (!contextKey.endsWith(`:${commentId}`)) continue;
    drafts.delete(contextKey);
    deleted = true;
  }
  if (!deleted) return;
  if (drafts.size === 0) replyDraftsByReview.delete(reviewId);
  notifyReplyDraftListeners();
}

export function readCommentDraft(
  reviewId: string,
  contextKey: string,
): CommentDraftState | undefined {
  return draftsByReview.get(reviewId)?.get(contextKey);
}

export function writeCommentDraft(
  reviewId: string,
  contextKey: string,
  revision: number,
  draft: CommentDraftState,
): void {
  if (revision !== currentCommentDraftRevision(reviewId)) return;
  let drafts = draftsByReview.get(reviewId);
  if (!drafts) {
    drafts = new Map();
    draftsByReview.set(reviewId, drafts);
  }
  drafts.set(contextKey, draft);
}

export function deleteCommentDraft(reviewId: string, contextKey: string, revision: number): void {
  if (revision !== currentCommentDraftRevision(reviewId)) return;
  const drafts = draftsByReview.get(reviewId);
  drafts?.delete(contextKey);
  if (drafts?.size === 0) draftsByReview.delete(reviewId);
}

export function clearCommentDraftsForReview(reviewId: string): void {
  draftsByReview.delete(reviewId);
  replyDraftsByReview.delete(reviewId);
  revisionByReview.set(reviewId, currentCommentDraftRevision(reviewId) + 1);
  emptyReplyDraftByReview.delete(reviewId);
  notifyReplyDraftListeners();
}
