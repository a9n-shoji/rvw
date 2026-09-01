import type { InvalidateQueryFilters, QueryClient } from "@tanstack/react-query";
import type { CommentPlacementBatchResult } from "../domain/models.js";

export async function cancelAndInvalidateQueries(
  queryClient: QueryClient,
  filters: InvalidateQueryFilters,
): Promise<void> {
  await queryClient.cancelQueries(filters);
  await queryClient.invalidateQueries(filters);
}

function placementResponse(value: unknown): CommentPlacementBatchResult | null {
  if (typeof value !== "object" || value === null) return null;
  if ("comments" in value && Array.isArray(value.comments)) {
    return value as CommentPlacementBatchResult;
  }
  if ("response" in value) return placementResponse(value.response);
  return null;
}

export function placementQueryHasFailures(value: unknown): boolean {
  return placementResponse(value)?.comments.some(({ failures }) => failures.length > 0) ?? false;
}

export async function invalidateFailedPlacementQueries(queryClient: QueryClient): Promise<void> {
  await cancelAndInvalidateQueries(queryClient, {
    predicate: ({ queryKey, state }) =>
      queryKey[0] === "comment-placements" && placementQueryHasFailures(state.data),
  });
}
