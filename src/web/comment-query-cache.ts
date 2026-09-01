import type { QueryClient } from "@tanstack/react-query";
import type { ReviewComment } from "../domain/models.js";
import type { CommentsResponse } from "./api.js";

const commentsQueryKey = (pullRequestId: string) => ["comments", pullRequestId] as const;
const localCommentRevisionCredits = new WeakMap<QueryClient, Map<string, number>>();

function revisionCredits(queryClient: QueryClient): Map<string, number> {
  const existing = localCommentRevisionCredits.get(queryClient);
  if (existing) return existing;
  const created = new Map<string, number>();
  localCommentRevisionCredits.set(queryClient, created);
  return created;
}

export async function cancelCommentQuery(
  queryClient: QueryClient,
  pullRequestId: string,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey: commentsQueryKey(pullRequestId), exact: true });
}

export async function beginLocalCommentMutation(
  queryClient: QueryClient,
  pullRequestId: string,
): Promise<void> {
  const credits = revisionCredits(queryClient);
  credits.set(pullRequestId, (credits.get(pullRequestId) ?? 0) + 1);
  await cancelCommentQuery(queryClient, pullRequestId);
}

export async function failLocalCommentMutation(
  queryClient: QueryClient,
  pullRequestId: string,
): Promise<void> {
  const credits = revisionCredits(queryClient);
  const remaining = (credits.get(pullRequestId) ?? 0) - 1;
  if (remaining > 0) credits.set(pullRequestId, remaining);
  else credits.delete(pullRequestId);
  await queryClient.invalidateQueries({ queryKey: commentsQueryKey(pullRequestId), exact: true });
}

export function consumeLocalCommentRevisionDelta(
  queryClient: QueryClient,
  pullRequestId: string,
  delta: number,
): boolean {
  if (delta <= 0) return false;
  const credits = revisionCredits(queryClient);
  const available = credits.get(pullRequestId) ?? 0;
  if (available === 0) return false;
  const remaining = available - delta;
  if (remaining > 0) credits.set(pullRequestId, remaining);
  else credits.delete(pullRequestId);
  return delta <= available;
}

function byMostRecentlyUpdated(left: ReviewComment, right: ReviewComment): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
}

export async function putCommentInCache(
  queryClient: QueryClient,
  pullRequestId: string,
  comment: ReviewComment,
): Promise<void> {
  await cancelCommentQuery(queryClient, pullRequestId);
  queryClient.setQueryData<CommentsResponse>(commentsQueryKey(pullRequestId), (current) => {
    const comments = [comment, ...(current?.comments.filter(({ id }) => id !== comment.id) ?? [])];
    comments.sort(byMostRecentlyUpdated);
    return { ...(current ?? {}), comments };
  });
}

export async function removeCommentFromCache(
  queryClient: QueryClient,
  pullRequestId: string,
  commentId: string,
): Promise<void> {
  await cancelCommentQuery(queryClient, pullRequestId);
  queryClient.setQueryData<CommentsResponse>(commentsQueryKey(pullRequestId), (current) => {
    if (!current || !current.comments.some(({ id }) => id === commentId)) return current;
    return { ...current, comments: current.comments.filter(({ id }) => id !== commentId) };
  });
}
