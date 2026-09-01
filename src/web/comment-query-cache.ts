import type { QueryClient } from "@tanstack/react-query";
import type { ReviewComment } from "../domain/models.js";
import type { CommentsResponse } from "./api.js";

const commentsQueryKey = (pullRequestId: string) => ["comments", pullRequestId] as const;

export async function cancelCommentQuery(
  queryClient: QueryClient,
  pullRequestId: string,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey: commentsQueryKey(pullRequestId), exact: true });
}

function byMostRecentlyUpdated(left: ReviewComment, right: ReviewComment): number {
  return right.updatedAt.localeCompare(left.updatedAt);
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
