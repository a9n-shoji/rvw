import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../../src/domain/models.js";
import type { CommentsResponse } from "../../src/web/api.js";
import {
  cancelCommentQuery,
  invalidateCommentQuery,
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition did not become true");
}

describe("comment query cache", () => {
  it("moves the canonical target to updated-at order and preserves unrelated identities", () => {
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

    putCommentInCache(queryClient, pullRequestId, updated);

    const next = queryClient.getQueryData<CommentsResponse>(["comments", pullRequestId])!;
    expect(next).not.toBe(response);
    expect(next.comments).not.toBe(response.comments);
    expect(next.comments[0]).toEqual(updated);
    expect(next.comments[1]).toBe(second);
  });

  it("places creates first, removes deletes, and seeds a missing list", () => {
    const queryClient = new QueryClient();
    const first = comment("first", "First");
    const second = comment("second", "Second", "2026-08-08T01:00:00.000Z");
    queryClient.setQueryData<CommentsResponse>(["comments", pullRequestId], {
      comments: [first],
    });

    putCommentInCache(queryClient, pullRequestId, second);
    removeCommentFromCache(queryClient, pullRequestId, first.id);

    expect(queryClient.getQueryData<CommentsResponse>(["comments", pullRequestId])).toEqual({
      comments: [second],
    });
    putCommentInCache(queryClient, "missing", first);
    expect(queryClient.getQueryData(["comments", "missing"])).toEqual({ comments: [first] });
  });

  it("recovers the complete list after a mutation cancels the initial GET", async () => {
    const queryClient = new QueryClient();
    const first = comment("first", "First");
    const second = comment("second", "Second", "2026-08-08T01:00:00.000Z");
    const created = comment("created", "Created", "2026-08-08T02:00:00.000Z");
    let requests = 0;
    let initialStarted = (): void => {};
    const initialStartedPromise = new Promise<void>((resolve) => {
      initialStarted = resolve;
    });
    let aborted = false;
    const observer = new QueryObserver<CommentsResponse>(queryClient, {
      queryKey: ["comments", pullRequestId],
      queryFn: async ({ signal }) => {
        requests += 1;
        if (requests > 1) return { comments: [created, second, first] };
        initialStarted();
        return await new Promise<CommentsResponse>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    await initialStartedPromise;

    await cancelCommentQuery(queryClient, pullRequestId);
    putCommentInCache(queryClient, pullRequestId, created);
    expect(queryClient.getQueryData(["comments", pullRequestId])).toEqual({
      comments: [created],
    });
    await waitUntil(() => requests === 2);
    await waitUntil(
      () =>
        queryClient.getQueryData<CommentsResponse>(["comments", pullRequestId])?.comments.length ===
        3,
    );

    expect(aborted).toBe(true);
    expect(queryClient.getQueryData(["comments", pullRequestId])).toEqual({
      comments: [created, second, first],
    });
    unsubscribe();
  });

  it("replaces a canceled external poll with a post-mutation consistency GET", async () => {
    const queryClient = new QueryClient();
    const first = comment("first", "First");
    const local = comment("local", "Local", "2026-08-08T02:00:00.000Z");
    const external = comment("external", "External", "2026-08-08T03:00:00.000Z");
    queryClient.setQueryData<CommentsResponse>(["comments", pullRequestId], { comments: [first] });
    let requests = 0;
    let externalPollStarted = (): void => {};
    const externalPollStartedPromise = new Promise<void>((resolve) => {
      externalPollStarted = resolve;
    });
    let externalPollAborted = false;
    const observer = new QueryObserver<CommentsResponse>(queryClient, {
      queryKey: ["comments", pullRequestId],
      staleTime: Number.POSITIVE_INFINITY,
      queryFn: async ({ signal }) => {
        requests += 1;
        if (requests > 1) return { comments: [external, local, first] };
        externalPollStarted();
        return await new Promise<CommentsResponse>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              externalPollAborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
    });
    const unsubscribe = observer.subscribe(() => {});

    invalidateCommentQuery(queryClient, pullRequestId);
    await externalPollStartedPromise;
    putCommentInCache(queryClient, pullRequestId, local);
    await waitUntil(() => requests === 2);
    await waitUntil(
      () =>
        queryClient.getQueryData<CommentsResponse>(["comments", pullRequestId])?.comments[0]?.id ===
        external.id,
    );

    expect(externalPollAborted).toBe(true);
    expect(queryClient.getQueryData(["comments", pullRequestId])).toEqual({
      comments: [external, local, first],
    });
    unsubscribe();
  });

  it("refetches an invalidated comment list after the viewer is reopened", async () => {
    const queryClient = new QueryClient();
    const local = comment("local", "Local");
    const external = comment("external", "External", "2026-08-08T01:00:00.000Z");
    queryClient.setQueryData<CommentsResponse>(["comments", pullRequestId], { comments: [local] });
    const firstObserver = new QueryObserver<CommentsResponse>(queryClient, {
      queryKey: ["comments", pullRequestId],
      staleTime: Number.POSITIVE_INFINITY,
      queryFn: () => Promise.resolve({ comments: [local] }),
    });
    const unsubscribeFirst = firstObserver.subscribe(() => {});
    await cancelCommentQuery(queryClient, pullRequestId);
    unsubscribeFirst();
    invalidateCommentQuery(queryClient, pullRequestId);

    let requests = 0;
    const reopenedObserver = new QueryObserver<CommentsResponse>(queryClient, {
      queryKey: ["comments", pullRequestId],
      staleTime: Number.POSITIVE_INFINITY,
      queryFn: () => {
        requests += 1;
        return Promise.resolve({ comments: [external, local] });
      },
    });
    const unsubscribeReopened = reopenedObserver.subscribe(() => {});
    await waitUntil(() => requests === 1);
    await waitUntil(
      () =>
        queryClient.getQueryData<CommentsResponse>(["comments", pullRequestId])?.comments[0]?.id ===
        external.id,
    );

    expect(queryClient.getQueryData(["comments", pullRequestId])).toEqual({
      comments: [external, local],
    });
    unsubscribeReopened();
  });

  it("repairs reversed mutation responses with the latest server snapshot", async () => {
    const queryClient = new QueryClient();
    const original = comment("first", "Original");
    const older = comment("first", "Older response", "2026-08-08T01:00:00.000Z");
    const latest = comment("first", "Latest response", "2026-08-08T02:00:00.000Z");
    queryClient.setQueryData<CommentsResponse>(["comments", pullRequestId], {
      comments: [original],
    });
    let requests = 0;
    let firstBarrierStarted = (): void => {};
    const firstBarrierStartedPromise = new Promise<void>((resolve) => {
      firstBarrierStarted = resolve;
    });
    const observer = new QueryObserver<CommentsResponse>(queryClient, {
      queryKey: ["comments", pullRequestId],
      staleTime: Number.POSITIVE_INFINITY,
      queryFn: async ({ signal }) => {
        requests += 1;
        if (requests > 1) return { comments: [latest] };
        firstBarrierStarted();
        return await new Promise<CommentsResponse>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const unsubscribe = observer.subscribe(() => {});

    putCommentInCache(queryClient, pullRequestId, latest);
    await firstBarrierStartedPromise;
    putCommentInCache(queryClient, pullRequestId, older);
    expect(
      queryClient.getQueryData<CommentsResponse>(["comments", pullRequestId])?.comments[0],
    ).toEqual(older);
    await waitUntil(() => requests === 2);
    await waitUntil(
      () =>
        queryClient.getQueryData<CommentsResponse>(["comments", pullRequestId])?.comments[0]
          ?.posts[0]?.body === "Latest response",
    );

    expect(queryClient.getQueryData(["comments", pullRequestId])).toEqual({ comments: [latest] });
    unsubscribe();
  });
});
