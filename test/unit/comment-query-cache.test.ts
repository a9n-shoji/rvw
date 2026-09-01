import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../../src/domain/models.js";
import type { CommentsResponse } from "../../src/web/api.js";
import {
  beginLocalCommentMutation,
  consumeLocalCommentRevisionDelta,
  failLocalCommentMutation,
  putCommentInCache,
  removeCommentFromCache,
} from "../../src/web/comment-query-cache.js";

const pullRequestId = "11111111-1111-4111-8111-111111111111";

function comment(id: string, body: string, updatedAt = "2026-08-08T00:00:00.000Z"): ReviewComment {
  const createdAt = "2026-08-08T00:00:00.000Z";
  return {
    id,
    ref: `rvw://comment/${id}`,
    pullRequestId,
    createdHeadOid: "b".repeat(40),
    resolvedAt: null,
    createdAt,
    updatedAt,
    target: { kind: "pull-request" },
    posts: [
      {
        id: `${id}-post`,
        commentId: id,
        body,
        relatedCommitOid: null,
        references: [],
        authorLabel: "You",
        lastModifiedBy: "human",
        isRoot: true,
        createdAt,
        updatedAt,
      },
    ],
  };
}

describe("comment query cache", () => {
  it("moves the canonical target to updated-at order and preserves unrelated identities", async () => {
    const queryClient = new QueryClient();
    const first = comment("first", "First");
    const second = comment("second", "Second", "2026-08-08T01:00:00.000Z");
    const response: CommentsResponse = { comments: [first, second] };
    queryClient.setQueryData(["comments", pullRequestId], response);
    const updated = {
      ...first,
      resolvedAt: "2026-08-08T02:00:00.000Z",
      updatedAt: "2026-08-08T02:00:00.000Z",
    };

    await putCommentInCache(queryClient, pullRequestId, updated);

    const next = queryClient.getQueryData<CommentsResponse>(["comments", pullRequestId])!;
    expect(next).not.toBe(response);
    expect(next.comments).not.toBe(response.comments);
    expect(next.comments[0]).toEqual(updated);
    expect(next.comments[1]).toBe(second);
  });

  it("places creates first, removes deletes, and seeds a missing list", async () => {
    const queryClient = new QueryClient();
    const first = comment("first", "First");
    const second = comment("second", "Second", "2026-08-08T01:00:00.000Z");
    queryClient.setQueryData<CommentsResponse>(["comments", pullRequestId], {
      comments: [first],
    });

    await putCommentInCache(queryClient, pullRequestId, second);
    await removeCommentFromCache(queryClient, pullRequestId, first.id);

    expect(queryClient.getQueryData<CommentsResponse>(["comments", pullRequestId])).toEqual({
      comments: [second],
    });
    await putCommentInCache(queryClient, "missing", first);
    expect(queryClient.getQueryData(["comments", "missing"])).toEqual({ comments: [first] });
  });

  it("cancels a deferred stale GET before writing a canonical mutation response", async () => {
    const queryClient = new QueryClient();
    const stale = comment("first", "Stale");
    const canonical = comment("first", "Canonical", "2026-08-08T02:00:00.000Z");
    let resolveStale: ((response: CommentsResponse) => void) | undefined;
    let aborted = false;
    const inFlight = queryClient.fetchQuery({
      queryKey: ["comments", pullRequestId],
      queryFn: async ({ signal }) =>
        await new Promise<CommentsResponse>((resolve, reject) => {
          resolveStale = resolve;
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    });
    const observedInFlight = inFlight.catch((error: unknown) => error);
    await Promise.resolve();

    await putCommentInCache(queryClient, pullRequestId, canonical);
    resolveStale?.({ comments: [stale] });
    await observedInFlight;

    expect(aborted).toBe(true);
    expect(queryClient.getQueryData(["comments", pullRequestId])).toEqual({
      comments: [canonical],
    });
  });

  it("suppresses only revision deltas accounted for by successful local mutations", async () => {
    const queryClient = new QueryClient();

    await beginLocalCommentMutation(queryClient, pullRequestId);
    expect(consumeLocalCommentRevisionDelta(queryClient, pullRequestId, 1)).toBe(true);
    expect(consumeLocalCommentRevisionDelta(queryClient, pullRequestId, 1)).toBe(false);

    await beginLocalCommentMutation(queryClient, pullRequestId);
    expect(consumeLocalCommentRevisionDelta(queryClient, pullRequestId, 2)).toBe(false);

    await beginLocalCommentMutation(queryClient, pullRequestId);
    await failLocalCommentMutation(queryClient, pullRequestId);
    expect(consumeLocalCommentRevisionDelta(queryClient, pullRequestId, 1)).toBe(false);
  });
});
