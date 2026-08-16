import type { SelectedLineRange } from "@pierre/diffs/react";
import type { ActiveDocument } from "./document-workspace.js";

export interface CommentDraftState {
  body: string;
  selection: SelectedLineRange | null;
  markdownComposerOpen: boolean;
  fileComposerOpen: boolean;
}

export interface CommentDraftContext {
  activeDocument: ActiveDocument;
  selectedOid: string;
  oldOid: string | null;
  displayMode: "full" | "pull-request" | "range";
}

const draftsByPullRequest = new Map<string, Map<string, CommentDraftState>>();
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
    documentIdentity(context.activeDocument),
    context.selectedOid,
    context.oldOid,
    context.displayMode,
  ]);
}

export function currentCommentDraftRevision(pullRequestId: string): number {
  return revisionByPullRequest.get(pullRequestId) ?? 0;
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
  revisionByPullRequest.set(pullRequestId, currentCommentDraftRevision(pullRequestId) + 1);
}
