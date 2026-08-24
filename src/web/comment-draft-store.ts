import type { SelectedLineRange } from "@pierre/diffs/react";
import {
  documentPaneTransitions,
  documentPaneTabKey,
  documentTabKey,
  type ActiveDocument,
  type DocumentPaneId,
  type DocumentWorkspaceState,
} from "./document-workspace.js";
import type { ReviewKind } from "./review-context.js";

export interface CommentDraftState {
  body: string;
  selection: SelectedLineRange | null;
  documentRevision: string | null;
  markdownComposerOpen: boolean;
  fileComposerOpen: boolean;
}

export interface CommentDraftContext {
  reviewKind: ReviewKind;
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
  | { status: "applied"; commentDraftsMoved: boolean }
  | { status: "conflict"; reason: "destination" | "document-replacement" };

const draftsByReview = new Map<string, Map<string, CommentDraftState>>();
const replyDraftsByReview = new Map<string, Map<string, CommentReplyDraftSnapshot>>();
const emptyReplyDraftByReview = new Map<string, CommentReplyDraftSnapshot>();
const replyDraftListeners = new Set<() => void>();
const revisionByReview = new Map<string, number>();
const revisionByContext = new Map<string, Map<string, number>>();
let nextDraftRevision = 0;

function issueDocumentIdentity(issueId: string): unknown[] {
  return ["issue", issueId];
}

function documentIdentity(document: ActiveDocument): unknown[] {
  if (document.kind === "pull-request-markdown") return ["pull-request-markdown"];
  if (document.kind === "walkthrough") {
    return ["walkthrough", document.id, document.sourceOid];
  }
  if (document.kind === "issue") return issueDocumentIdentity(document.id);
  return [
    "repository-file",
    document.path,
    document.oldPath ?? null,
    document.newPath ?? null,
    document.sourceOid ?? null,
    document.comparisonPolicy ?? null,
  ];
}

function documentIdentityTabKey(identity: unknown): string | null {
  if (!Array.isArray(identity)) return null;
  if (identity[0] === "pull-request-markdown") return "pull-request-markdown";
  if (identity[0] === "walkthrough" && typeof identity[1] === "string") {
    return `walkthrough:${identity[1]}`;
  }
  if (identity[0] === "issue" && typeof identity[1] === "string") {
    return `issue:${identity[1]}`;
  }
  if (identity[0] === "repository-file" && typeof identity[1] === "string") {
    return `file:${identity[1]}`;
  }
  return null;
}

export function commentDraftContextKey(context: CommentDraftContext): string {
  if (context.activeDocument.kind === "issue") {
    return JSON.stringify([
      context.pane,
      documentIdentity(context.activeDocument),
      null,
      null,
      "issue",
    ]);
  }
  const currentRepositoryFile =
    context.reviewKind === "repository" &&
    context.activeDocument.kind === "repository-file" &&
    context.activeDocument.sourceOid === undefined;
  return JSON.stringify([
    context.pane,
    documentIdentity(context.activeDocument),
    currentRepositoryFile ? null : context.selectedOid,
    currentRepositoryFile ? null : context.oldOid,
    currentRepositoryFile ? "current" : context.displayMode,
  ]);
}

function hasCommentDraftForDocument(
  reviewId: string,
  document: ActiveDocument,
  pane: DocumentPaneId,
): boolean {
  const drafts = draftsByReview.get(reviewId);
  if (!drafts) return false;
  const identity = JSON.stringify(documentIdentity(document));
  for (const contextKey of drafts.keys()) {
    let context: unknown;
    try {
      context = JSON.parse(contextKey);
    } catch {
      continue;
    }
    if (
      Array.isArray(context) &&
      context.length === 5 &&
      context[0] === pane &&
      JSON.stringify(context[1]) === identity
    ) {
      return true;
    }
  }
  return false;
}

function hasCommentReplyDraftForDocument(
  reviewId: string,
  document: ActiveDocument,
  pane: DocumentPaneId,
): boolean {
  const drafts = replyDraftsByReview.get(reviewId);
  if (!drafts) return false;
  const prefix = `inline:${commentReplyDraftScope(pane, document)}:`;
  return [...drafts.keys()].some((key) => key.startsWith(prefix));
}

function sameDocumentIdentity(left: ActiveDocument, right: ActiveDocument): boolean {
  return JSON.stringify(documentIdentity(left)) === JSON.stringify(documentIdentity(right));
}

function replacesDraftOwningDocument(
  reviewId: string,
  previous: DocumentWorkspaceState,
  next: DocumentWorkspaceState,
): boolean {
  const nextDocuments = [...next.documents.left, ...next.documents.right];
  for (const sourcePane of ["left", "right"] as const) {
    for (const sourceDocument of previous.documents[sourcePane]) {
      const ownsDraft =
        hasCommentDraftForDocument(reviewId, sourceDocument, sourcePane) ||
        hasCommentReplyDraftForDocument(reviewId, sourceDocument, sourcePane);
      if (!ownsDraft) {
        continue;
      }
      const samePaneDocument = next.documents[sourcePane].find(
        (candidate) => documentTabKey(candidate) === documentTabKey(sourceDocument),
      );
      if (samePaneDocument) {
        if (!sameDocumentIdentity(samePaneDocument, sourceDocument)) return true;
        continue;
      }
      if (nextDocuments.some((candidate) => sameDocumentIdentity(candidate, sourceDocument))) {
        continue;
      }
      if (
        nextDocuments.some(
          (candidate) =>
            documentTabKey(candidate) === documentTabKey(sourceDocument) &&
            !sameDocumentIdentity(candidate, sourceDocument),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function currentCommentDraftRevision(reviewId: string, contextKey?: string): number {
  const reviewRevision = revisionByReview.get(reviewId) ?? 0;
  if (contextKey === undefined) return reviewRevision;
  return Math.max(reviewRevision, revisionByContext.get(reviewId)?.get(contextKey) ?? 0);
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

export function commentReplyDraftScope(pane: DocumentPaneId, document: ActiveDocument): string {
  return documentPaneTabKey(pane, document);
}

function commentReplyDraftMovesForDocument(
  reviewId: string,
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
  const drafts = replyDraftsByReview.get(reviewId);
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
  reviewId: string,
  sourceDocument: ActiveDocument,
  sourcePane: DocumentPaneId,
  targetPane: DocumentPaneId,
): Array<{ sourceKey: string; targetKey: string; draft: CommentDraftState }> {
  if (sourcePane === targetPane) return [];
  const commentDrafts = draftsByReview.get(reviewId);
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
  reviewId: string,
  previous: DocumentWorkspaceState,
  next: DocumentWorkspaceState,
): CommentDraftWorkspaceTransitionResult {
  if (replacesDraftOwningDocument(reviewId, previous, next)) {
    return { status: "conflict", reason: "document-replacement" };
  }
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
        reviewId,
        transition.sourceDocument,
        transition.targetDocument,
        transition.sourcePane,
        transition.targetPane,
      ),
    );
    commentMoves.push(
      ...commentDraftMovesForDocument(
        reviewId,
        transition.sourceDocument,
        transition.sourcePane,
        transition.targetPane,
      ),
    );
  }

  const replyDrafts = replyDraftsByReview.get(reviewId);
  const commentDrafts = draftsByReview.get(reviewId);
  if (
    replyMoves.some(({ targetKey }) => replyDrafts?.has(targetKey)) ||
    commentMoves.some(({ targetKey }) => commentDrafts?.has(targetKey))
  ) {
    return { status: "conflict", reason: "destination" };
  }

  for (const { sourceKey } of replyMoves) replyDrafts?.delete(sourceKey);
  for (const { targetKey, draft } of replyMoves) replyDrafts?.set(targetKey, draft);
  for (const { sourceKey } of commentMoves) commentDrafts?.delete(sourceKey);
  for (const { targetKey, draft } of commentMoves) commentDrafts?.set(targetKey, draft);
  if (replyMoves.length > 0) notifyReplyDraftListeners();
  return { status: "applied", commentDraftsMoved: commentMoves.length > 0 };
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
  if (revision !== currentCommentDraftRevision(reviewId, contextKey)) return;
  let drafts = draftsByReview.get(reviewId);
  if (!drafts) {
    drafts = new Map();
    draftsByReview.set(reviewId, drafts);
  }
  drafts.set(contextKey, draft);
}

export function deleteCommentDraft(reviewId: string, contextKey: string, revision: number): void {
  if (revision !== currentCommentDraftRevision(reviewId, contextKey)) return;
  const drafts = draftsByReview.get(reviewId);
  drafts?.delete(contextKey);
  if (drafts?.size === 0) draftsByReview.delete(reviewId);
}

export function deleteCommentDraftForIssue(reviewId: string, issueId: string): void {
  const contextKeys = (["left", "right"] as const).map((pane) =>
    JSON.stringify([pane, issueDocumentIdentity(issueId), null, null, "issue"]),
  );
  const drafts = draftsByReview.get(reviewId);
  for (const contextKey of contextKeys) drafts?.delete(contextKey);
  if (draftsByReview.get(reviewId)?.size === 0) draftsByReview.delete(reviewId);
  let revisions = revisionByContext.get(reviewId);
  if (!revisions) {
    revisions = new Map();
    revisionByContext.set(reviewId, revisions);
  }
  const revision = ++nextDraftRevision;
  for (const contextKey of contextKeys) revisions.set(contextKey, revision);
}

export function clearCommentDraftsForReview(reviewId: string): void {
  draftsByReview.delete(reviewId);
  replyDraftsByReview.delete(reviewId);
  revisionByReview.set(reviewId, ++nextDraftRevision);
  revisionByContext.delete(reviewId);
  emptyReplyDraftByReview.delete(reviewId);
  notifyReplyDraftListeners();
}
