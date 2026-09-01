import type { QueryClient } from "@tanstack/react-query";
import type { ReviewComment } from "../domain/models.js";
import type { CommentsResponse } from "./api.js";

export function putCommentInCache(
  queryClient: QueryClient,
  pullRequestId: string,
  comment: ReviewComment,
): void {
  queryClient.setQueryData<CommentsResponse>(["comments", pullRequestId], (current) => {
    if (!current) return current;
    const index = current.comments.findIndex(({ id }) => id === comment.id);
    if (index < 0) return { ...current, comments: [...current.comments, comment] };
    if (current.comments[index] === comment) return current;
    const comments = current.comments.slice();
    comments[index] = comment;
    return { ...current, comments };
  });
}

export function removeCommentFromCache(
  queryClient: QueryClient,
  pullRequestId: string,
  commentId: string,
): void {
  queryClient.setQueryData<CommentsResponse>(["comments", pullRequestId], (current) => {
    if (!current || !current.comments.some(({ id }) => id === commentId)) return current;
    return { ...current, comments: current.comments.filter(({ id }) => id !== commentId) };
  });
}
