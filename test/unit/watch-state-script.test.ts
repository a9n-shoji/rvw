import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = path.resolve("skills/rvw-watch-comments/scripts/watch-state.mjs");

function run(state: string, command: string, args: string[] = [], input?: unknown) {
  const result = spawnSync(process.execPath, [script, command, "--state", state, ...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function ingest(state: string, frame: unknown) {
  return run(state, "ingest", [], frame);
}

describe("rvw-watch-comments task state", () => {
  it("atomically queues cursors and suppresses a self event received before completion", () => {
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-watch-state-")), "task.db");
    run(state, "init", ["--expected-login", "reviewer", "--own-mode", "fix-and-push"]);
    ingest(state, {
      type: "ready",
      databaseId: "0123456789abcdef0123456789abcdef",
      cursor: "cursor-0",
      anchoredAtCurrent: true,
    });
    ingest(state, {
      type: "comment-posted",
      cursor: "cursor-1",
      event: {
        sequence: 1,
        postId: "human-post",
        commentId: "comment-1",
        commentRef: "rvw://comment/comment-1",
        pullRequestId: "pr-1",
        pullRequestUrl: "https://github.com/acme/repo/pull/1",
        createdAt: "2026-08-20T00:00:00.000Z",
        deleted: false,
      },
    });

    expect(run(state, "list")).toMatchObject({
      pending: [
        {
          pullRequest: "https://github.com/acme/repo/pull/1",
          commentRefs: ["rvw://comment/comment-1"],
        },
      ],
    });
    const claimed = run(state, "claim", [
      "--pull-request",
      "https://github.com/acme/repo/pull/1",
      "--write-key",
      "acme/repo",
    ]);
    expect(claimed).toMatchObject({
      attempts: 1,
      operations: [{ commentRef: "rvw://comment/comment-1" }],
    });

    ingest(state, {
      type: "comment-posted",
      cursor: "cursor-2",
      event: {
        sequence: 2,
        postId: "agent-post",
        commentId: "comment-1",
        commentRef: "rvw://comment/comment-1",
        pullRequestId: "pr-1",
        pullRequestUrl: "https://github.com/acme/repo/pull/1",
        createdAt: "2026-08-20T00:00:01.000Z",
        deleted: false,
      },
    });
    run(state, "complete", ["--lease", String(claimed.leaseId)], {
      postIds: ["agent-post"],
    });

    expect(run(state, "list")).toMatchObject({ pending: [] });
    expect(run(state, "status")).toMatchObject({
      cursor: "cursor-2",
      batches: { inFlight: 0, unbatchedEvents: 0 },
    });
  });

  it("recovers a lease with the same idempotency key and serializes repository writers", () => {
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-watch-state-")), "task.db");
    run(state, "init", ["--own-mode", "investigate-and-reply"]);
    ingest(state, {
      type: "ready",
      databaseId: "fedcba9876543210fedcba9876543210",
      cursor: "cursor-0",
      anchoredAtCurrent: true,
    });
    for (const [sequence, pull] of [
      [1, 1],
      [2, 2],
    ] as const) {
      ingest(state, {
        type: "comment-posted",
        cursor: `cursor-${sequence}`,
        event: {
          sequence,
          postId: `post-${sequence}`,
          commentId: `comment-${sequence}`,
          commentRef: `rvw://comment/comment-${sequence}`,
          pullRequestId: `pr-${pull}`,
          pullRequestUrl: `https://github.com/acme/repo/pull/${pull}`,
          createdAt: "2026-08-20T00:00:00.000Z",
          deleted: false,
        },
      });
    }
    const first = run(state, "claim", [
      "--pull-request",
      "https://github.com/acme/repo/pull/1",
      "--write-key",
      "acme/repo",
    ]);
    const blocked = spawnSync(
      process.execPath,
      [
        script,
        "claim",
        "--state",
        state,
        "--pull-request",
        "https://github.com/acme/repo/pull/2",
        "--write-key",
        "acme/repo",
      ],
      { encoding: "utf8" },
    );
    expect(blocked.status).toBe(1);

    const firstKey = (first.operations as Array<{ idempotencyKey: string }>)[0]!.idempotencyKey;
    expect(run(state, "recover")).toMatchObject({ recovered: 1, pending: 1 });
    const retried = run(state, "claim", [
      "--pull-request",
      "https://github.com/acme/repo/pull/1",
      "--write-key",
      "acme/repo",
    ]);
    expect((retried.operations as Array<{ idempotencyKey: string }>)[0]!.idempotencyKey).toBe(
      firstKey,
    );
  });
});
