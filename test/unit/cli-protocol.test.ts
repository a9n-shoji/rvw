import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/application/runtime.js";
import { createProgram, runCli } from "../../src/cli/main.js";
import type { CommentPost, PullRequest, ReviewComment } from "../../src/domain/models.js";

const pullRequest: PullRequest = {
  id: "pull-request-1",
  host: "github.com",
  owner: "acme",
  repository: "review-repo",
  number: 7,
  url: "https://github.com/acme/review-repo/pull/7",
  latestAuthorLogin: "review-author",
  latestHeadRepositoryOwner: "review-author",
  latestHeadRepositoryName: "review-repo",
  localRepositoryPath: "/review-repo",
  gitCommonDir: "/review-repo/.git",
  latestTitle: "Improve review context",
  latestBody: "Give Agents the complete context.",
  latestBaseRefName: "main",
  latestHeadRefName: "feature",
  latestBaseOid: "a".repeat(40),
  latestComparisonBaseOid: "b".repeat(40),
  latestHeadOid: "c".repeat(40),
  githubUpdatedAt: "2026-08-10T00:00:00.000Z",
  fetchedAt: "2026-08-10T00:01:00.000Z",
  createdAt: "2026-08-10T00:01:00.000Z",
  updatedAt: "2026-08-10T00:01:00.000Z",
};

const commentRef = "rvw://comment/10000000-0000-4000-8000-000000000001";
const rootPost: CommentPost = {
  id: "post-1",
  commentId: "comment-1",
  body: "Please preserve this line.",
  relatedCommitOid: null,
  references: [],
  authorLabel: "Reviewer",
  isRoot: true,
  createdAt: "2026-08-10T00:02:00.000Z",
  updatedAt: "2026-08-10T00:02:00.000Z",
};
const reviewCommentWithoutPosts: Omit<ReviewComment, "posts"> = {
  id: "comment-1",
  ref: commentRef,
  pullRequestId: pullRequest.id,
  createdHeadOid: "d".repeat(40),
  resolvedAt: null,
  createdAt: "2026-08-10T00:02:00.000Z",
  updatedAt: "2026-08-10T00:03:00.000Z",
  target: {
    kind: "document",
    documentKind: "repository-file",
    sourceOid: "d".repeat(40),
    path: "src/example.ts",
    startLine: 12,
    endLine: 12,
  },
};

const formattedPullRequest = {
  url: pullRequest.url,
  owner: pullRequest.owner,
  repository: pullRequest.repository,
  number: pullRequest.number,
  authorLogin: pullRequest.latestAuthorLogin,
  headRepository: {
    owner: "review-author",
    name: "review-repo",
    url: "https://github.com/review-author/review-repo",
  },
  title: pullRequest.latestTitle,
  baseRefName: pullRequest.latestBaseRefName,
  baseOid: pullRequest.latestBaseOid,
  comparisonBaseOid: pullRequest.latestComparisonBaseOid,
  headRefName: pullRequest.latestHeadRefName,
  headOid: pullRequest.latestHeadOid,
  githubUpdatedAt: pullRequest.githubUpdatedAt,
  fetchedAt: pullRequest.fetchedAt,
  localRepositoryPath: pullRequest.localRepositoryPath,
};
const formattedPullRequestWithBody = {
  ...formattedPullRequest,
  body: pullRequest.latestBody,
};

const commentReviewContext = {
  pullRequest,
  comment: {
    ...reviewCommentWithoutPosts,
    posts: [rootPost],
  },
  latestPlacement: {
    outdated: false,
    range: { startLine: 12, endLine: 12 },
    path: "src/example.ts",
  },
  exactSource: {
    sourceOid: "d".repeat(40),
    path: "src/example.ts",
    availability: "available",
    excerpt: {
      startLine: 1,
      endLine: 20,
      text: "export function example() {}",
      truncatedBefore: false,
      truncatedAfter: true,
      truncatedByBytes: false,
    },
  },
  walkthrough: null,
  githubState: {
    liveCheckedAt: null,
    staleAgainstGitHub: null,
    live: null,
  },
};

function captureStdout(): () => unknown {
  let stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  return () => JSON.parse(stdout) as unknown;
}

function captureJsonSequence(): () => unknown[] {
  let stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  return () =>
    stdout
      .split("\u001e")
      .filter((value) => value.trim().length > 0)
      .map((value) => JSON.parse(value) as unknown);
}

function provideStdin(value: unknown): void {
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    Readable.from([JSON.stringify(value)]) as unknown as typeof process.stdin,
  );
}

function mockRuntime(service: Record<string, unknown>): {
  runtime: Runtime;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  return {
    runtime: { service, close } as unknown as Runtime,
    close,
  };
}

describe("CLI protocol discovery", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("advertises the current Walkthrough lifecycle capabilities", async () => {
    const readStdout = captureStdout();
    const program = createProgram(() => {
      throw new Error("protocol discovery must not initialize the runtime");
    });

    await program.parseAsync(["node", "rvw", "protocol", "--json"]);

    expect(readStdout()).toEqual({
      protocolVersion: 3,
      appVersion: "0.2.0",
      capabilities: [
        "agent.transport",
        "comment.create",
        "comment.list",
        "comment.watch",
        "comment.read",
        "comment.reply",
        "comment.edit",
        "comment.codeReferences",
        "comment.resolve",
        "comment.reopen",
        "pullRequest.sync",
        "walkthrough.read",
        "walkthrough.publish",
        "walkthrough.update",
        "walkthrough.delete",
      ],
    });
    expect(
      program.commands
        .find((command) => command.name() === "comment")
        ?.commands.map((command) => command.name()),
    ).toEqual(["watch", "create", "list", "get", "reply", "edit", "resolve", "reopen"]);
    expect(
      program.commands
        .find((command) => command.name() === "walkthrough")
        ?.commands.map((command) => command.name()),
    ).toEqual(["publish", "get", "update", "delete"]);
    expect(
      program.commands
        .find((command) => command.name() === "agent")
        ?.commands.map((command) => command.name()),
    ).toEqual(["ping", "status"]);
    expect(
      program.commands
        .find((command) => command.name() === "open")
        ?.options.map((option) => option.long),
    ).toEqual(["--no-open", "--foreground", "--port"]);
    expect(
      program
        .createHelp()
        .visibleCommands(program)
        .map((command) => command.name()),
    ).not.toContain("__open-worker");
  });

  it("streams a resumable comment watch as an RFC 7464 sequence", async () => {
    const listCommentPostEvents = vi.fn().mockReturnValue({
      databaseId: "0123456789abcdef0123456789abcdef",
      startCursor: "previous-cursor",
      cursor: "next-cursor",
      anchoredAtCurrent: false,
      hasMore: false,
      events: [
        {
          cursor: "next-cursor",
          event: {
            sequence: 2,
            createdAt: "2026-08-20T00:00:00.000Z",
            postId: "reply-1",
            commentId: "comment-1",
            commentRef,
            pullRequestId: pullRequest.id,
            pullRequestUrl: pullRequest.url,
            deleted: false,
          },
        },
      ],
    });
    const { runtime } = mockRuntime({ listCommentPostEvents });
    const readStdout = captureJsonSequence();

    await createProgram(() => runtime).parseAsync([
      "node",
      "rvw",
      "comment",
      "watch",
      "--after",
      "previous-cursor",
      "--once",
      "--json-seq",
    ]);

    expect(listCommentPostEvents).toHaveBeenCalledWith("previous-cursor", 100);
    expect(readStdout()).toMatchObject([
      {
        type: "ready",
        databaseId: "0123456789abcdef0123456789abcdef",
        cursor: "previous-cursor",
        anchoredAtCurrent: false,
      },
      {
        type: "comment-posted",
        cursor: "next-cursor",
        event: {
          sequence: 2,
          postId: "reply-1",
          commentRef,
          pullRequestUrl: pullRequest.url,
          deleted: false,
        },
      },
      { type: "stopped", cursor: "next-cursor" },
    ]);
  });

  it("creates one unresolved comment from a strict stdin payload", async () => {
    const input = {
      pullRequest: pullRequest.url,
      target: {
        kind: "document" as const,
        documentKind: "repository-file" as const,
        sourceOid: "d".repeat(40),
        path: "src/example.ts",
        startLine: 12,
        endLine: 12,
      },
      body: "Inspect [the implementation](rvw-ref:implementation).",
      relatedCommitOid: "d".repeat(40),
      references: [
        {
          id: "implementation",
          label: "Implementation",
          path: "src/example.ts",
          startLine: 12,
          endLine: 12,
          description: null,
        },
      ],
      authorLabel: "Codex",
    };
    const created = {
      ...reviewCommentWithoutPosts,
      target: input.target,
      posts: [{ ...rootPost, authorLabel: "Codex" }],
    };
    const createCommentForReference = vi.fn().mockResolvedValue(created);
    const { runtime, close } = mockRuntime({ createCommentForReference });
    const readStdout = captureStdout();
    provideStdin(input);

    await createProgram(() => runtime).parseAsync([
      "node",
      "rvw",
      "comment",
      "create",
      "--stdin",
      "--json",
    ]);

    expect(createCommentForReference).toHaveBeenCalledWith(input);
    expect(readStdout()).toEqual({ ok: true, comment: created });
    expect(close).toHaveBeenCalledOnce();
  });

  it("replaces one recorded comment post through the Agent CLI", async () => {
    const input = {
      body: "✅ [対応しました](rvw-ref:result)",
      relatedCommitOid: "d".repeat(40),
      references: [
        {
          id: "result",
          label: "Result",
          path: "src/example.ts",
          startLine: 12,
          endLine: 12,
          description: null,
        },
      ],
    };
    const edited = { ...rootPost, ...input, updatedAt: "2026-08-20T00:00:00.000Z" };
    const editCommentPost = vi.fn().mockResolvedValue(edited);
    const { runtime, close } = mockRuntime({ editCommentPost });
    const readStdout = captureStdout();
    provideStdin(input);

    await createProgram(() => runtime).parseAsync([
      "node",
      "rvw",
      "comment",
      "edit",
      commentRef,
      "--post",
      rootPost.id,
      "--stdin",
      "--json",
    ]);

    expect(editCommentPost).toHaveBeenCalledWith(commentRef, rootPost.id, input);
    expect(readStdout()).toEqual({ ok: true, post: edited });
    expect(close).toHaveBeenCalledOnce();
  });

  it("lists unresolved comments by default with latest placement", async () => {
    const listCommentReviewContexts = vi.fn().mockResolvedValue({
      pullRequest,
      comments: [
        {
          comment: reviewCommentWithoutPosts,
          rootPost,
          postCount: 2,
          latestPlacement: {
            outdated: false,
            range: { startLine: 12, endLine: 12 },
            path: "src/example.ts",
          },
        },
      ],
      page: {
        offset: 0,
        limit: 50,
        returned: 1,
        total: 1,
        hasMore: false,
        nextOffset: null,
      },
    });
    const { runtime } = mockRuntime({ listCommentReviewContexts });
    const readStdout = captureStdout();

    await createProgram(() => runtime).parseAsync([
      "node",
      "rvw",
      "comment",
      "list",
      pullRequest.url,
      "--json",
    ]);

    expect(listCommentReviewContexts).toHaveBeenCalledWith(pullRequest.url, false, {
      limit: 50,
      offset: 0,
    });
    expect(readStdout()).toEqual({
      ok: true,
      pullRequest: formattedPullRequest,
      state: "unresolved",
      page: {
        offset: 0,
        limit: 50,
        returned: 1,
        total: 1,
        hasMore: false,
        nextOffset: null,
      },
      comments: [
        {
          comment: {
            ref: commentRef,
            resolved: false,
            createdAt: reviewCommentWithoutPosts.createdAt,
            updatedAt: reviewCommentWithoutPosts.updatedAt,
            target: {
              kind: "document",
              documentKind: "repository-file",
              path: "src/example.ts",
              startLine: 12,
              endLine: 12,
            },
            postCount: 2,
            rootPost: {
              body: "Please preserve this line.",
              bodyTruncated: false,
              authorLabel: "Reviewer",
              relatedCommitOid: null,
              createdAt: rootPost.createdAt,
              updatedAt: rootPost.updatedAt,
            },
          },
          latestPlacement: {
            outdated: false,
            range: { startLine: 12, endLine: 12 },
            path: "src/example.ts",
          },
        },
      ],
    });
  });

  it("bounds the list root-post preview by UTF-8 bytes", async () => {
    const listCommentReviewContexts = vi.fn().mockResolvedValue({
      pullRequest,
      comments: [
        {
          comment: reviewCommentWithoutPosts,
          rootPost: { ...rootPost, body: "あ".repeat(1_000) },
          postCount: 1,
          latestPlacement: { outdated: true, range: null, path: "src/example.ts" },
        },
      ],
      page: {
        offset: 0,
        limit: 1,
        returned: 1,
        total: 1,
        hasMore: false,
        nextOffset: null,
      },
    });
    const { runtime } = mockRuntime({ listCommentReviewContexts });
    const readStdout = captureStdout();

    await createProgram(() => runtime).parseAsync([
      "node",
      "rvw",
      "comment",
      "list",
      pullRequest.url,
      "--limit",
      "1",
      "--json",
    ]);

    const output = readStdout() as {
      comments: Array<{ comment: { rootPost: { body: string; bodyTruncated: boolean } } }>;
    };
    const preview = output.comments[0]?.comment.rootPost;
    expect(Buffer.byteLength(preview?.body ?? "", "utf8")).toBeLessThanOrEqual(512);
    expect(preview?.bodyTruncated).toBe(true);
  });

  it.each([
    ["resolved", true],
    ["all", undefined],
  ] as const)("maps the %s comment list state to the service filter", async (state, resolved) => {
    const listCommentReviewContexts = vi.fn().mockResolvedValue({
      pullRequest,
      comments: [],
      page: {
        offset: 10,
        limit: 5,
        returned: 0,
        total: 10,
        hasMore: false,
        nextOffset: null,
      },
    });
    const { runtime } = mockRuntime({ listCommentReviewContexts });
    const readStdout = captureStdout();

    await createProgram(() => runtime).parseAsync([
      "node",
      "rvw",
      "comment",
      "list",
      pullRequest.url,
      "--state",
      state,
      "--limit",
      "5",
      "--offset",
      "10",
      "--json",
    ]);

    expect(listCommentReviewContexts).toHaveBeenCalledWith(pullRequest.url, resolved, {
      limit: 5,
      offset: 10,
    });
    expect(readStdout()).toEqual({
      ok: true,
      pullRequest: formattedPullRequest,
      state,
      page: {
        offset: 10,
        limit: 5,
        returned: 0,
        total: 10,
        hasMore: false,
        nextOffset: null,
      },
      comments: [],
    });
  });

  it("returns an INVALID_INPUT JSON error for an invalid list state", async () => {
    const readStdout = captureStdout();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runCli([
      "node",
      "rvw",
      "comment",
      "list",
      pullRequest.url,
      "--state",
      "invalid",
      "--json",
    ]);

    expect(process.exitCode).toBe(2);
    expect(readStdout()).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "入力がCLI schemaに適合しません。",
        suggestions: [],
      },
    });
  });

  it("gets PR metadata without the body, derived placement, and bounded exact source", async () => {
    const getCommentReviewContext = vi.fn().mockResolvedValue(commentReviewContext);
    const { runtime } = mockRuntime({ getCommentReviewContext });
    const readStdout = captureStdout();

    await createProgram(() => runtime).parseAsync([
      "node",
      "rvw",
      "comment",
      "get",
      commentRef,
      "--json",
    ]);

    expect(getCommentReviewContext).toHaveBeenCalledWith(commentRef, { live: false });
    expect(readStdout()).toEqual({
      ok: true,
      pullRequest: formattedPullRequest,
      comment: {
        ...reviewCommentWithoutPosts,
        posts: [rootPost],
        resolved: false,
      },
      latestHeadOid: "c".repeat(40),
      latestPlacement: {
        outdated: false,
        range: { startLine: 12, endLine: 12 },
        path: "src/example.ts",
      },
      exactSource: {
        sourceOid: "d".repeat(40),
        path: "src/example.ts",
        availability: "available",
        excerpt: {
          startLine: 1,
          endLine: 20,
          text: "export function example() {}",
          truncatedBefore: false,
          truncatedAfter: true,
          truncatedByBytes: false,
        },
      },
      walkthrough: null,
      githubState: {
        liveCheckedAt: null,
        staleAgainstGitHub: null,
        live: null,
      },
    });
  });

  it("includes the PR body in comment get only when requested", async () => {
    const getCommentReviewContext = vi.fn().mockResolvedValue(commentReviewContext);
    const { runtime } = mockRuntime({ getCommentReviewContext });
    const readStdout = captureStdout();

    await createProgram(() => runtime).parseAsync([
      "node",
      "rvw",
      "comment",
      "get",
      commentRef,
      "--include-pr-body",
      "--json",
    ]);

    expect(getCommentReviewContext).toHaveBeenCalledWith(commentRef, { live: false });
    expect(readStdout()).toMatchObject({
      ok: true,
      pullRequest: formattedPullRequestWithBody,
    });
  });

  it("reads the current Walkthrough through the CLI", async () => {
    const uri = "rvw://walkthrough/70000000-0000-4000-8000-000000000001";
    const getWalkthroughByUri = vi.fn().mockReturnValue({
      pullRequest: { id: "pull-request-1", localRepositoryPath: "/review-repo" },
      walkthrough: { id: "70000000-0000-4000-8000-000000000001", ref: uri },
    });
    const { runtime, close } = mockRuntime({ getWalkthroughByUri });
    const readStdout = captureStdout();

    await createProgram(() => runtime).parseAsync([
      "node",
      "rvw",
      "walkthrough",
      "get",
      uri,
      "--json",
    ]);

    expect(getWalkthroughByUri).toHaveBeenCalledWith(uri);
    expect(readStdout()).toMatchObject({
      ok: true,
      pullRequest: { id: "pull-request-1" },
      walkthrough: { ref: uri },
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("passes a complete Walkthrough replacement from stdin to the service", async () => {
    const uri = "rvw://walkthrough/70000000-0000-4000-8000-000000000001";
    const input = {
      sourceOid: "b".repeat(40),
      title: "Improved explanation",
      body: "Open [the handler](rvw-ref:handler).",
      diagramBindings: { Handler: "handler" },
      references: [
        {
          id: "handler",
          label: "RequestHandler.execute",
          path: "src/request-handler.ts",
          startLine: 12,
          endLine: 28,
          description: "Expanded after reviewer feedback",
        },
      ],
    };
    const updateWalkthrough = vi
      .fn()
      .mockResolvedValue({ id: "walkthrough-1", ref: uri, ...input });
    const { runtime, close } = mockRuntime({ updateWalkthrough });
    const readStdout = captureStdout();
    provideStdin(input);

    await createProgram(() => runtime).parseAsync([
      "node",
      "rvw",
      "walkthrough",
      "update",
      uri,
      "--stdin",
      "--json",
    ]);

    expect(updateWalkthrough).toHaveBeenCalledWith(uri, input);
    expect(readStdout()).toMatchObject({
      ok: true,
      walkthrough: { ref: uri, title: "Improved explanation" },
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("previews Walkthrough deletion and exits without deleting when --yes is absent", async () => {
    const uri = "rvw://walkthrough/70000000-0000-4000-8000-000000000001";
    const getWalkthroughDeletePreview = vi.fn().mockReturnValue({
      walkthrough: { id: "walkthrough-1", ref: uri, title: "Temporary explanation" },
      counts: { comments: 1, posts: 2, references: 3 },
      confirmationRequired: true,
    });
    const deleteWalkthroughByUri = vi.fn();
    const { runtime, close } = mockRuntime({
      getWalkthroughDeletePreview,
      deleteWalkthroughByUri,
    });
    const readStdout = captureStdout();

    await createProgram(() => runtime).parseAsync([
      "node",
      "rvw",
      "walkthrough",
      "delete",
      uri,
      "--json",
    ]);

    expect(getWalkthroughDeletePreview).toHaveBeenCalledWith(uri);
    expect(deleteWalkthroughByUri).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(readStdout()).toMatchObject({
      ok: false,
      error: { code: "WALKTHROUGH_DELETE_CONFIRMATION_REQUIRED" },
      counts: { comments: 1, posts: 2, references: 3 },
      confirmationRequired: true,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("deletes the exact Walkthrough after --yes confirmation", async () => {
    const uri = "rvw://walkthrough/70000000-0000-4000-8000-000000000001";
    const getWalkthroughDeletePreview = vi.fn();
    const deleteWalkthroughByUri = vi.fn().mockReturnValue({
      id: "walkthrough-1",
      ref: uri,
      pullRequestId: "pull-request-1",
      counts: { comments: 1, posts: 2, references: 3 },
    });
    const { runtime, close } = mockRuntime({
      getWalkthroughDeletePreview,
      deleteWalkthroughByUri,
    });
    const readStdout = captureStdout();

    await createProgram(() => runtime).parseAsync([
      "node",
      "rvw",
      "walkthrough",
      "delete",
      uri,
      "--yes",
      "--json",
    ]);

    expect(getWalkthroughDeletePreview).not.toHaveBeenCalled();
    expect(deleteWalkthroughByUri).toHaveBeenCalledWith(uri);
    expect(process.exitCode).toBeUndefined();
    expect(readStdout()).toMatchObject({
      ok: true,
      deleted: { ref: uri, counts: { comments: 1, posts: 2, references: 3 } },
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
