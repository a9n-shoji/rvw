import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../../src/domain/models.js";
import type { CommentsResponse } from "../../src/web/api.js";
import { putCommentInCache, removeCommentFromCache } from "../../src/web/comment-query-cache.js";

const pullRequestId = "11111111-1111-4111-8111-111111111111";

function comment(id: string, body: string): ReviewComment {
  const createdAt = "2026-08-08T00:00:00.000Z";
  return {
    id,
    ref: `rvw://comment/${id}`,
    pullRequestId,
    createdHeadOid: "b".repeat(40),
    resolvedAt: null,
    createdAt,
    updatedAt: createdAt,
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
        updatedAt: createdAt,
      },
    ],
  };
}

describe("comment query cache", () => {
  it("replaces only the canonical target and preserves unrelated identities", () => {
    const queryClient = new QueryClient();
    const first = comment("first", "First");
    const second = comment("second", "Second");
    const response: CommentsResponse = { comments: [first, second] };
    queryClient.setQueryData(["comments", pullRequestId], response);
    const updated = { ...first, resolvedAt: "2026-08-08T01:00:00.000Z" };

    putCommentInCache(queryClient, pullRequestId, updated);

    const next = queryClient.getQueryData<CommentsResponse>(["comments", pullRequestId])!;
    expect(next).not.toBe(response);
    expect(next.comments).not.toBe(response.comments);
    expect(next.comments[0]).toEqual(updated);
    expect(next.comments[1]).toBe(second);
  });

  it("appends creates and removes deletes without fabricating a missing list", () => {
    const queryClient = new QueryClient();
    const first = comment("first", "First");
    const second = comment("second", "Second");
    queryClient.setQueryData<CommentsResponse>(["comments", pullRequestId], {
      comments: [first],
    });

    putCommentInCache(queryClient, pullRequestId, second);
    removeCommentFromCache(queryClient, pullRequestId, first.id);

    expect(queryClient.getQueryData<CommentsResponse>(["comments", pullRequestId])).toEqual({
      comments: [second],
    });
    putCommentInCache(queryClient, "missing", first);
    expect(queryClient.getQueryData(["comments", "missing"])).toBeUndefined();
  });
});
