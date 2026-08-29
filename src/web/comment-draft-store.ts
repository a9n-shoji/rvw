import type { SelectedLineRange } from "@pierre/diffs/react";
import {
  documentPaneTransitions,
  documentPaneTabKey,
  documentTabKey,
  type ActiveDocument,
  type DocumentPaneId,
  type DocumentWorkspaceState,
} from "./document-workspace.js";

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

export type CommentDraftWorkspaceTransitionResult =
  { status: "applied"; commentDraftsMoved: boolean } | { status: "conflict" };

const draftsByPullRequest = new Map<string, Map<string, CommentDraftState>>();
const replyDraftsByPullRequest = new Map<string, Map<string, CommentReplyDraftSnapshot>>();
const emptyReplyDraftByPullRequest = new Map<string, CommentReplyDraftSnapshot>();
const replyDraftListeners = new Set<() => void>();
const revisionByPullRequest = new Map<string, number>();

export function hasPendingCommentDrafts(): boolean {
  return (
    [...draftsByPullRequest.values()].some((drafts) => drafts.size > 0) ||
    [...replyDraftsByPullRequest.values()].some((drafts) => drafts.size > 0)
  );
}

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
    document.referenceContext?.latestHeadOid ?? null,
    document.referenceContext?.outcome ?? null,
  ];
}

function documentIdentityTabKey(identity: unknown): string | null {
  if (!Array.isArray(identity)) return null;
  if (identity[0] === "pull-request-markdown") return "pull-request-markdown";
  if (identity[0] === "walkthrough" && typeof identity[1] === "string") {
    return `walkthrough:${identity[1]}`;
  }
  if (identity[0] === "repository-file" && typeof identity[1] === "string") {
    return `file:${identity[1]}`;
  }
  return null;
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

export function commentReplyDraftScope(pane: DocumentPaneId, document: ActiveDocument): string {
  return documentPaneTabKey(pane, document);
}

function commentReplyDraftMovesForDocument(
  pullRequestId: string,
  sourceDocument: ActiveDocument,
  targetDocument: ActiveDocument,
  sourcePane: DocumentPaneId,
  targetPane: DocumentPaneId,
): Array<{
  sourceKey: string;
  targetKey: string;
  draft: CommentReplyDraftSnapshot;
}> {
  if (sourcePane === targetPane) return [];
  const drafts = replyDraftsByPullRequest.get(pullRequestId);
  if (!drafts) return [];
  const sourcePrefix = `inline:${commentReplyDraftScope(sourcePane, sourceDocument)}:`;
  const targetPrefix = `inline:${commentReplyDraftScope(targetPane, targetDocument)}:`;
  return [...drafts.entries()]
    .filter(([key]) => key.startsWith(sourcePrefix))
    .map(([sourceKey, draft]) => ({
      sourceKey,
      targetKey: `${targetPrefix}${sourceKey.slice(sourcePrefix.length)}`,
      draft,
    }));
}

function commentDraftMovesForDocument(
  pullRequestId: string,
  sourceDocument: ActiveDocument,
  sourcePane: DocumentPaneId,
  targetPane: DocumentPaneId,
): Array<{ sourceKey: string; targetKey: string; draft: CommentDraftState }> {
  if (sourcePane === targetPane) return [];
  const commentDrafts = draftsByPullRequest.get(pullRequestId);
  if (!commentDrafts) return [];
  const sourceTabKey = documentTabKey(sourceDocument);
  const moves: Array<{ sourceKey: string; targetKey: string; draft: CommentDraftState }> = [];
  for (const [sourceKey, draft] of commentDrafts) {
    let context: unknown;
    try {
      context = JSON.parse(sourceKey);
    } catch {
      continue;
    }
    if (
      !Array.isArray(context) ||
      context.length !== 5 ||
      context[0] !== sourcePane ||
      documentIdentityTabKey(context[1]) !== sourceTabKey
    ) {
      continue;
    }
    const contextValues = context as unknown[];
    moves.push({
      sourceKey,
      targetKey: JSON.stringify([targetPane, ...contextValues.slice(1)]),
      draft,
    });
  }
  return moves;
}

export function moveCommentDraftsForWorkspaceTransition(
  pullRequestId: string,
  previous: DocumentWorkspaceState,
  next: DocumentWorkspaceState,
): CommentDraftWorkspaceTransitionResult {
  const replyMoves: Array<{
    sourceKey: string;
    targetKey: string;
    draft: CommentReplyDraftSnapshot;
  }> = [];
  const commentMoves: Array<{
    sourceKey: string;
    targetKey: string;
    draft: CommentDraftState;
  }> = [];
  for (const transition of documentPaneTransitions(previous, next)) {
    replyMoves.push(
      ...commentReplyDraftMovesForDocument(
        pullRequestId,
        transition.sourceDocument,
        transition.targetDocument,
        transition.sourcePane,
        transition.targetPane,
      ),
    );
    commentMoves.push(
      ...commentDraftMovesForDocument(
        pullRequestId,
        transition.sourceDocument,
        transition.sourcePane,
        transition.targetPane,
      ),
    );
  }

  const replyDrafts = replyDraftsByPullRequest.get(pullRequestId);
  const commentDrafts = draftsByPullRequest.get(pullRequestId);
  if (
    replyMoves.some(({ targetKey }) => replyDrafts?.has(targetKey)) ||
    commentMoves.some(({ targetKey }) => commentDrafts?.has(targetKey))
  ) {
    return { status: "conflict" };
  }

  for (const { sourceKey } of replyMoves) replyDrafts?.delete(sourceKey);
  for (const { targetKey, draft } of replyMoves) replyDrafts?.set(targetKey, draft);
  for (const { sourceKey } of commentMoves) commentDrafts?.delete(sourceKey);
  for (const { targetKey, draft } of commentMoves) commentDrafts?.set(targetKey, draft);
  if (replyMoves.length > 0) notifyReplyDraftListeners();
  return { status: "applied", commentDraftsMoved: commentMoves.length > 0 };
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
