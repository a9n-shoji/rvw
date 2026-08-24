import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const script = path.resolve("skills/rvw-watch-comments/scripts/watch-state.mjs");

function stableReviewArgs(command: string, args: string[]): string[] {
  if (command !== "claim") return args;
  const pullRequestIndex = args.indexOf("--pull-request");
  if (pullRequestIndex >= 0) {
    const display = args[pullRequestIndex + 1]!;
    return [
      ...args.slice(0, pullRequestIndex),
      "--context-kind",
      "pull-request",
      "--context-key",
      `pull-request:${display}`,
      "--context-display",
      display,
      ...args.slice(pullRequestIndex + 2),
    ];
  }
  const kindIndex = args.indexOf("--context-kind");
  const keyIndex = args.indexOf("--context-key");
  if (kindIndex < 0 || keyIndex < 0 || args.includes("--context-display")) return args;
  const kind = args[kindIndex + 1]!;
  const display = args[keyIndex + 1]!;
  const result = [...args];
  result[keyIndex + 1] =
    kind === "repository" ? `repository:${display.toLowerCase()}` : `pull-request:${display}`;
  return [...result, "--context-display", display.toLowerCase()];
}

function stableReviewFrame(frame: unknown): unknown {
  if (!frame || typeof frame !== "object" || !("event" in frame)) return frame;
  const event = (frame as { event?: Record<string, unknown> }).event;
  if (!event) return frame;
  const context = event.context;
  if (context && typeof context === "object" && "kind" in context) {
    const review = context as Record<string, unknown>;
    if (review.kind === "repository" && typeof review.repository === "string") {
      const hasStableId = typeof review.repositoryReviewId === "string";
      event.context = {
        kind: "repository",
        repositoryReviewId: hasStableId
          ? review.repositoryReviewId
          : `repository:${review.repository.toLowerCase()}`,
        repository: hasStableId ? review.repository : review.repository.toLowerCase(),
      };
    }
    return frame;
  }
  if (typeof event.pullRequestUrl === "string") {
    event.context = {
      kind: "pull-request",
      pullRequestId: `pull-request:${event.pullRequestUrl}`,
      pullRequestUrl: event.pullRequestUrl,
    };
    delete event.pullRequestUrl;
  }
  return frame;
}

function run(state: string, command: string, args: string[] = [], input?: unknown) {
  const result = spawnSync(
    process.execPath,
    [script, command, "--state", state, ...stableReviewArgs(command, args)],
    {
      encoding: "utf8",
      ...(input === undefined ? {} : { input: JSON.stringify(input) }),
    },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function runRaw(state: string, command: string, args: string[] = [], input?: unknown) {
  const result = spawnSync(process.execPath, [script, command, "--state", state, ...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function ingest(state: string, frame: unknown) {
  return run(state, "ingest", [], stableReviewFrame(frame));
}

describe("rvw-watch-comments task state", () => {
  it("re-keys a real v3 pending PR context to its protocol v4 stable ID", () => {
    const state = path.join(
      mkdtempSync(path.join(os.tmpdir(), "rvw-watch-v3-context-")),
      "task.db",
    );
    const pullRequestUrl = "https://github.com/Acme/Repo/pull/23";
    const createdAt = "2026-08-20T00:00:00.000Z";
    const legacy = new DatabaseSync(state);
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY, cursor TEXT NOT NULL, post_id TEXT NOT NULL,
        comment_ref TEXT NOT NULL, pull_request_url TEXT NOT NULL, deleted INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'completed')), batch_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE batches (
        id TEXT PRIMARY KEY, pull_request_url TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'in_flight', 'completed', 'quarantined')),
        attempts INTEGER NOT NULL, next_attempt_at TEXT, lease_id TEXT, write_key TEXT,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE operations (
        batch_id TEXT NOT NULL, comment_ref TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, post_id TEXT,
        PRIMARY KEY(batch_id, comment_ref)
      );
      CREATE TABLE suppressed_posts (post_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    `);
    const insertMeta = legacy.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
    for (const [key, value] of [
      ["task_id", "legacy-task"],
      ["database_id", "11112222333344445555666677778888"],
      ["cursor", "cursor-1"],
      ["last_sequence", "1"],
      ["own_mode", "fix-and-push"],
      ["expected_login", "reviewer"],
      ["batch_scoped_status_posts", "1"],
    ] as const) {
      insertMeta.run(key, value);
    }
    legacy
      .prepare(
        `INSERT INTO events(
          sequence, cursor, post_id, comment_ref, pull_request_url, deleted,
          status, batch_id, created_at, updated_at
        ) VALUES (1, 'cursor-1', 'legacy-post', 'rvw://comment/legacy', ?, 0,
          'pending', 'legacy-batch', ?, ?)`,
      )
      .run(pullRequestUrl, createdAt, createdAt);
    legacy
      .prepare(
        `INSERT INTO batches(
          id, pull_request_url, status, attempts, next_attempt_at, lease_id,
          write_key, last_error, created_at, updated_at
        ) VALUES ('legacy-batch', ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(pullRequestUrl, createdAt, createdAt);
    legacy
      .prepare(
        `INSERT INTO operations(batch_id, comment_ref, idempotency_key, post_id)
        VALUES ('legacy-batch', 'rvw://comment/legacy', 'legacy-operation', NULL)`,
      )
      .run();
    legacy.close();

    expect(
      runRaw(state, "ingest", [], {
        type: "comment-posted",
        cursor: "cursor-2",
        event: {
          sequence: 2,
          postId: "v4-post",
          commentRef: "rvw://comment/v4",
          context: {
            kind: "pull-request",
            pullRequestId: "pull-request-uuid-23",
            pullRequestUrl: "https://github.com/acme/repo/pull/23",
          },
          createdAt: "2026-08-20T00:00:01.000Z",
          deleted: false,
        },
      }),
    ).toMatchObject({ status: "queued" });

    expect(runRaw(state, "list").pending).toEqual([
      expect.objectContaining({
        context: {
          kind: "pull-request",
          pullRequestId: "pull-request-uuid-23",
          pullRequestUrl: "https://github.com/acme/repo/pull/23",
        },
        batchId: "legacy-batch",
      }),
    ]);
    const claimed = runRaw(state, "claim", [
      "--context-kind",
      "pull-request",
      "--context-key",
      "pull-request-uuid-23",
      "--context-display",
      "https://github.com/acme/repo/pull/23",
      "--write-key",
      "acme/repo",
    ]);
    expect(claimed).toMatchObject({
      batchId: "legacy-batch",
      context: { kind: "pull-request", pullRequestId: "pull-request-uuid-23" },
    });
    expect(runRaw(state, "list")).toMatchObject({ pending: [] });
    expect(() =>
      runRaw(state, "claim", [
        "--context-kind",
        "pull-request",
        "--context-key",
        "pull-request-uuid-23",
        "--context-display",
        "https://github.com/acme/repo/pull/23",
        "--write-key",
        "acme/repo",
      ]),
    ).toThrow(/in-flight|owns repository/);
    expect(runRaw(state, "recover")).toMatchObject({ recovered: 1, pending: 1 });
    expect(
      runRaw(state, "claim", [
        "--context-kind",
        "pull-request",
        "--context-key",
        "pull-request-uuid-23",
        "--context-display",
        "https://github.com/acme/repo/pull/23",
        "--write-key",
        "acme/repo",
      ]),
    ).toMatchObject({ batchId: "legacy-batch", attempts: 2 });
  });

  it("re-keys and recovers a real v3 in-flight PR lease without a second stable-ID claim", () => {
    const state = path.join(
      mkdtempSync(path.join(os.tmpdir(), "rvw-watch-v3-in-flight-context-")),
      "task.db",
    );
    const pullRequestUrl = "https://github.com/Acme/Repo/pull/23";
    const createdAt = "2026-08-20T00:00:00.000Z";
    const legacy = new DatabaseSync(state);
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY, cursor TEXT NOT NULL, post_id TEXT NOT NULL,
        comment_ref TEXT NOT NULL, pull_request_url TEXT NOT NULL, deleted INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'completed')), batch_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE batches (
        id TEXT PRIMARY KEY, pull_request_url TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'in_flight', 'completed', 'quarantined')),
        attempts INTEGER NOT NULL, next_attempt_at TEXT, lease_id TEXT, write_key TEXT,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE operations (
        batch_id TEXT NOT NULL, comment_ref TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, post_id TEXT,
        PRIMARY KEY(batch_id, comment_ref)
      );
      CREATE TABLE suppressed_posts (post_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    `);
    const insertMeta = legacy.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
    for (const [key, value] of [
      ["task_id", "legacy-in-flight-task"],
      ["database_id", "11112222333344445555666677778888"],
      ["cursor", "cursor-1"],
      ["last_sequence", "1"],
      ["own_mode", "fix-and-push"],
      ["expected_login", "reviewer"],
      ["batch_scoped_status_posts", "1"],
    ] as const) {
      insertMeta.run(key, value);
    }
    legacy
      .prepare(
        `INSERT INTO events(
          sequence, cursor, post_id, comment_ref, pull_request_url, deleted,
          status, batch_id, created_at, updated_at
        ) VALUES (1, 'cursor-1', 'legacy-post', 'rvw://comment/legacy-in-flight', ?, 0,
          'pending', 'legacy-in-flight-batch', ?, ?)`,
      )
      .run(pullRequestUrl, createdAt, createdAt);
    legacy
      .prepare(
        `INSERT INTO batches(
          id, pull_request_url, status, attempts, next_attempt_at, lease_id,
          write_key, last_error, created_at, updated_at
        ) VALUES ('legacy-in-flight-batch', ?, 'in_flight', 1, NULL, 'legacy-lease',
          'acme/repo', NULL, ?, ?)`,
      )
      .run(pullRequestUrl, createdAt, createdAt);
    legacy
      .prepare(
        `INSERT INTO operations(batch_id, comment_ref, idempotency_key, post_id)
        VALUES ('legacy-in-flight-batch', 'rvw://comment/legacy-in-flight',
          'legacy-in-flight-operation', NULL)`,
      )
      .run();
    legacy.close();

    expect(
      runRaw(state, "ingest", [], {
        type: "comment-posted",
        cursor: "cursor-2",
        event: {
          sequence: 2,
          postId: "v4-post",
          commentRef: "rvw://comment/v4-after-crash",
          context: {
            kind: "pull-request",
            pullRequestId: "pull-request-uuid-23",
            pullRequestUrl: "https://github.com/acme/repo/pull/23",
          },
          createdAt: "2026-08-20T00:00:01.000Z",
          deleted: false,
        },
      }),
    ).toMatchObject({ status: "queued" });
    expect(runRaw(state, "list")).toMatchObject({ inFlight: 1, pending: [] });
    expect(() =>
      runRaw(state, "claim", [
        "--context-kind",
        "pull-request",
        "--context-key",
        "pull-request-uuid-23",
        "--context-display",
        "https://github.com/acme/repo/pull/23",
        "--write-key",
        "acme/repo",
      ]),
    ).toThrow(/in-flight/);

    expect(runRaw(state, "recover")).toMatchObject({ recovered: 1, pending: 1 });
    const recovered = runRaw(state, "claim", [
      "--context-kind",
      "pull-request",
      "--context-key",
      "pull-request-uuid-23",
      "--context-display",
      "https://github.com/acme/repo/pull/23",
      "--write-key",
      "acme/repo",
    ]);
    expect(recovered).toMatchObject({
      batchId: "legacy-in-flight-batch",
      attempts: 2,
      context: { kind: "pull-request", pullRequestId: "pull-request-uuid-23" },
    });
    expect(() =>
      runRaw(state, "claim", [
        "--context-kind",
        "pull-request",
        "--context-key",
        "pull-request-uuid-23",
        "--context-display",
        "https://github.com/acme/repo/pull/23",
        "--write-key",
        "acme/repo",
      ]),
    ).toThrow(/in-flight/);
  });

  it("batches Repository Reviews by repository and rejects write reservations", () => {
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-watch-branch-")), "task.db");
    run(state, "init", ["--own-mode", "fix-and-push"]);
    ingest(state, {
      type: "ready",
      databaseId: "11112222333344445555666677778888",
      cursor: "cursor-0",
      anchoredAtCurrent: true,
    });
    ingest(state, {
      type: "comment-posted",
      cursor: "cursor-1",
      event: {
        sequence: 1,
        postId: "branch-human-post",
        commentRef: "rvw://comment/repository-comment",
        context: { kind: "repository", repository: "Acme/Repo" },
        createdAt: "2026-08-20T00:00:00.000Z",
        deleted: false,
      },
    });

    expect(run(state, "list")).toMatchObject({
      pending: [
        {
          context: { kind: "repository", repository: "acme/repo" },
          repository: "acme/repo",
          commentRefs: ["rvw://comment/repository-comment"],
        },
      ],
    });
    const claimed = run(state, "claim", [
      "--context-kind",
      "repository",
      "--context-key",
      "acme/repo",
    ]);
    expect(claimed).toMatchObject({
      context: { kind: "repository", repository: "acme/repo" },
      writeKey: null,
      operations: [{ commentRef: "rvw://comment/repository-comment", statusPostId: null }],
    });
    expect(() =>
      run(state, "reserve-write", ["--lease", String(claimed.leaseId), "--write-key", "acme/repo"]),
    ).toThrow(/investigate-and-reply/);
    run(state, "complete", ["--lease", String(claimed.leaseId)], {
      postIds: ["branch-final-reply"],
    });
    expect(
      ingest(state, {
        type: "comment-posted",
        cursor: "cursor-2",
        event: {
          sequence: 2,
          postId: "branch-final-reply",
          commentRef: "rvw://comment/repository-comment",
          context: { kind: "repository", repository: "acme/repo" },
          createdAt: "2026-08-20T00:00:01.000Z",
          deleted: false,
        },
      }),
    ).toMatchObject({ status: "suppressed" });
  });

  it("groups repository casing by stable ID and keeps a recreated review separate", () => {
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-watch-identity-")), "task.db");
    run(state, "init");
    ingest(state, {
      type: "ready",
      databaseId: "12121212121212121212121212121212",
      cursor: "cursor-0",
      anchoredAtCurrent: true,
    });
    for (const [sequence, repositoryReviewId, repository] of [
      [1, "repository-review-1", "Acme/Repo"],
      [2, "repository-review-1", "acme/repo"],
      [3, "repository-review-2", "acme/repo"],
    ] as const) {
      ingest(state, {
        type: "comment-posted",
        cursor: `cursor-${sequence}`,
        event: {
          sequence,
          postId: `branch-post-${sequence}`,
          commentRef: `rvw://comment/repository-comment-${sequence}`,
          context: { kind: "repository", repositoryReviewId, repository },
          createdAt: `2026-08-20T00:00:0${sequence}.000Z`,
          deleted: false,
        },
      });
    }

    expect(run(state, "list")).toMatchObject({
      pending: [
        {
          context: {
            kind: "repository",
            repositoryReviewId: "repository-review-1",
            repository: "acme/repo",
          },
          eventCount: 2,
        },
        {
          context: {
            kind: "repository",
            repositoryReviewId: "repository-review-2",
            repository: "acme/repo",
          },
          eventCount: 1,
        },
      ],
    });
  });

  it("allows concurrent Repository Review leases even when the task can fix owned Pull Requests", () => {
    const state = path.join(
      mkdtempSync(path.join(os.tmpdir(), "rvw-watch-branch-parallel-")),
      "task.db",
    );
    run(state, "init", ["--own-mode", "fix-and-push", "--expected-login", "reviewer"]);
    ingest(state, {
      type: "ready",
      databaseId: "11113333555577779999aaaaccccdddd",
      cursor: "cursor-0",
      anchoredAtCurrent: true,
    });
    ingest(state, {
      type: "comment-posted",
      cursor: "cursor-1",
      event: {
        sequence: 1,
        postId: "branch-human-post-1",
        commentRef: "rvw://comment/repository-comment-1",
        context: { kind: "repository", repository: "acme/repo" },
        createdAt: "2026-08-20T00:00:00.000Z",
        deleted: false,
      },
    });
    const first = run(state, "claim", [
      "--context-kind",
      "repository",
      "--context-key",
      "acme/repo",
    ]);
    ingest(state, {
      type: "comment-posted",
      cursor: "cursor-2",
      event: {
        sequence: 2,
        postId: "branch-human-post-2",
        commentRef: "rvw://comment/repository-comment-2",
        context: { kind: "repository", repository: "acme/repo" },
        createdAt: "2026-08-20T00:00:01.000Z",
        deleted: false,
      },
    });

    expect(run(state, "list")).toMatchObject({
      inFlight: 1,
      pending: [{ commentRefs: ["rvw://comment/repository-comment-2"] }],
    });
    const second = run(state, "claim", [
      "--context-kind",
      "repository",
      "--context-key",
      "acme/repo",
    ]);
    expect(second.batchId).not.toBe(first.batchId);
    expect(run(state, "status")).toMatchObject({ batches: { inFlight: 2 } });
  });

  it("completes an already-ingested Repository Review final reply when suppression is recorded", () => {
    const state = path.join(
      mkdtempSync(path.join(os.tmpdir(), "rvw-watch-branch-first-")),
      "task.db",
    );
    run(state, "init", ["--own-mode", "fix-and-push"]);
    ingest(state, {
      type: "ready",
      databaseId: "99992222333344445555666677778888",
      cursor: "cursor-0",
      anchoredAtCurrent: true,
    });
    ingest(state, {
      type: "comment-posted",
      cursor: "cursor-1",
      event: {
        sequence: 1,
        postId: "branch-human-post",
        commentRef: "rvw://comment/repository-comment",
        context: { kind: "repository", repository: "acme/repo" },
        createdAt: "2026-08-20T00:00:00.000Z",
        deleted: false,
      },
    });
    const claimed = run(state, "claim", [
      "--context-kind",
      "repository",
      "--context-key",
      "acme/repo",
    ]);
    expect(
      ingest(state, {
        type: "comment-posted",
        cursor: "cursor-2",
        event: {
          sequence: 2,
          postId: "branch-final-reply",
          commentRef: "rvw://comment/repository-comment",
          context: { kind: "repository", repository: "acme/repo" },
          createdAt: "2026-08-20T00:00:01.000Z",
          deleted: false,
        },
      }),
    ).toMatchObject({ status: "queued" });
    expect(run(state, "status")).toMatchObject({
      batches: { inFlight: 1, unbatchedEvents: 1 },
    });

    run(state, "complete", ["--lease", String(claimed.leaseId)], {
      postIds: ["branch-final-reply"],
    });
    expect(run(state, "list")).toMatchObject({ pending: [] });
    expect(run(state, "status")).toMatchObject({
      batches: { inFlight: 0, unbatchedEvents: 0 },
    });
  });

  it("waits for the pending set to become non-empty and emits monitor-ready JSON", async () => {
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-watch-wait-")), "task.db");
    run(state, "init");
    ingest(state, {
      type: "ready",
      databaseId: "ffeeddccbbaa00998877665544332211",
      cursor: "cursor-0",
      anchoredAtCurrent: true,
    });
    const waiter = spawn(
      process.execPath,
      [script, "wait", "--state", state, "--interval-ms", "10"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const output = new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      waiter.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      waiter.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      waiter.on("error", reject);
      waiter.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr));
      });
    });
    ingest(state, {
      type: "comment-posted",
      cursor: "cursor-1",
      event: {
        sequence: 1,
        postId: "human-post-wait",
        commentRef: "rvw://comment/comment-wait",
        pullRequestUrl: "https://github.com/acme/repo/pull/8",
        createdAt: "2026-08-20T00:00:00.000Z",
        deleted: false,
      },
    });

    expect(JSON.parse(await output)).toMatchObject({
      ok: true,
      type: "pending",
      pullRequests: ["https://github.com/acme/repo/pull/8"],
      pending: [{ commentRefs: ["rvw://comment/comment-wait"] }],
    });
  });

  it("can reserve a repository writer after an automatically acknowledged claim", () => {
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-watch-reserve-")), "task.db");
    run(state, "init", ["--own-mode", "fix-and-push", "--expected-login", "reviewer"]);
    ingest(state, {
      type: "ready",
      databaseId: "abcdefabcdefabcdefabcdefabcdefab",
      cursor: "cursor-0",
      anchoredAtCurrent: true,
    });
    ingest(state, {
      type: "comment-posted",
      cursor: "cursor-1",
      event: {
        sequence: 1,
        postId: "human-post-reserve",
        commentRef: "rvw://comment/comment-reserve",
        pullRequestUrl: "https://github.com/acme/repo/pull/9",
        createdAt: "2026-08-20T00:00:00.000Z",
        deleted: false,
      },
    });
    const claimed = run(state, "claim", ["--pull-request", "https://github.com/acme/repo/pull/9"]);

    expect(
      run(state, "reserve-write", ["--lease", String(claimed.leaseId), "--write-key", "Acme/Repo"]),
    ).toMatchObject({ status: "reserved", writeKey: "acme/repo" });
    expect(run(state, "status")).toMatchObject({
      inFlightBatches: [
        {
          leaseId: claimed.leaseId,
          writeKey: "acme/repo",
          operations: [{ commentRef: "rvw://comment/comment-reserve" }],
        },
      ],
    });
  });

  it("allows concurrent leases for the same PR under an investigate-only policy", () => {
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-watch-parallel-")), "task.db");
    const pullRequest = "https://github.com/acme/repo/pull/9";
    run(state, "init", ["--own-mode", "investigate-and-reply"]);
    ingest(state, {
      type: "ready",
      databaseId: "abc123abc123abc123abc123abc123ab",
      cursor: "cursor-0",
      anchoredAtCurrent: true,
    });
    ingest(state, {
      type: "comment-posted",
      cursor: "cursor-1",
      event: {
        sequence: 1,
        postId: "human-post-parallel-1",
        commentRef: "rvw://comment/comment-parallel-1",
        pullRequestUrl: pullRequest,
        createdAt: "2026-08-20T00:00:00.000Z",
        deleted: false,
      },
    });
    const first = run(state, "claim", ["--pull-request", pullRequest]);

    ingest(state, {
      type: "comment-posted",
      cursor: "cursor-2",
      event: {
        sequence: 2,
        postId: "human-post-parallel-2",
        commentRef: "rvw://comment/comment-parallel-2",
        pullRequestUrl: pullRequest,
        createdAt: "2026-08-20T00:00:01.000Z",
        deleted: false,
      },
    });
    expect(run(state, "list")).toMatchObject({
      inFlight: 1,
      pending: [{ pullRequest, commentRefs: ["rvw://comment/comment-parallel-2"] }],
    });

    const second = run(state, "claim", ["--pull-request", pullRequest]);
    expect(second).toMatchObject({ pullRequest, attempts: 1, writeKey: null });
    expect(second.batchId).not.toBe(first.batchId);
    expect(run(state, "status")).toMatchObject({ batches: { inFlight: 2 } });

    const writeCapableClaim = spawnSync(
      process.execPath,
      [
        script,
        "claim",
        "--state",
        state,
        "--context-kind",
        "pull-request",
        "--context-key",
        `pull-request:${pullRequest}`,
        "--context-display",
        pullRequest,
        "--write-key",
        "acme/repo",
      ],
      { encoding: "utf8" },
    );
    expect(writeCapableClaim.status).toBe(1);
    expect(writeCapableClaim.stderr).toContain("investigate-and-reply");

    const writeReservation = spawnSync(
      process.execPath,
      [
        script,
        "reserve-write",
        "--state",
        state,
        "--lease",
        String(first.leaseId),
        "--write-key",
        "acme/repo",
      ],
      { encoding: "utf8" },
    );
    expect(writeReservation.status).toBe(1);
    expect(writeReservation.stderr).toContain(
      "Task policy does not allow repository write reservations",
    );
  });

  it("records a new durable status post for a later batch in the same thread", () => {
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
      operations: [{ commentRef: "rvw://comment/comment-1", statusPostId: null }],
    });
    const acknowledgementKey = (claimed.operations as Array<{ idempotencyKey: string }>)[0]!
      .idempotencyKey;

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
    expect(
      run(state, "ack", ["--lease", String(claimed.leaseId)], {
        commentRef: "rvw://comment/comment-1",
        postId: "agent-post",
      }),
    ).toMatchObject({ status: "recorded", statusPostId: "agent-post" });
    run(state, "complete", ["--lease", String(claimed.leaseId)], {
      postIds: [],
    });

    expect(run(state, "list")).toMatchObject({ pending: [] });
    expect(run(state, "status")).toMatchObject({
      cursor: "cursor-2",
      batches: { inFlight: 0, unbatchedEvents: 0 },
    });

    ingest(state, {
      type: "comment-posted",
      cursor: "cursor-3",
      event: {
        sequence: 3,
        postId: "human-follow-up",
        commentRef: "rvw://comment/comment-1",
        pullRequestUrl: "https://github.com/acme/repo/pull/1",
        createdAt: "2026-08-20T00:00:02.000Z",
        deleted: false,
      },
    });
    const interruptedFollowUp = run(state, "claim", [
      "--pull-request",
      "https://github.com/acme/repo/pull/1",
    ]);
    const legacyState = new DatabaseSync(state);
    legacyState.exec(`
      DELETE FROM operations;
      ALTER TABLE operations DROP COLUMN post_id;
      CREATE TABLE comment_statuses (
        comment_ref TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        post_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacyState
      .prepare(
        `INSERT INTO comment_statuses(
          comment_ref, idempotency_key, post_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "rvw://comment/comment-1",
        acknowledgementKey,
        "agent-post",
        "2026-08-20T00:00:01.000Z",
        "2026-08-20T00:00:01.000Z",
      );
    legacyState.prepare("DELETE FROM meta WHERE key = 'batch_scoped_status_posts'").run();
    legacyState.close();
    expect(run(state, "recover")).toMatchObject({ recovered: 1, pending: 1 });
    const followUp = run(state, "claim", ["--pull-request", "https://github.com/acme/repo/pull/1"]);
    expect(followUp).toMatchObject({
      batchId: interruptedFollowUp.batchId,
      attempts: 2,
    });
    expect(followUp).toMatchObject({
      operations: [
        {
          commentRef: "rvw://comment/comment-1",
          statusPostId: null,
        },
      ],
    });
    const followUpKey = (followUp.operations as Array<{ idempotencyKey: string }>)[0]!
      .idempotencyKey;
    expect(followUpKey).not.toBe(acknowledgementKey);
    run(state, "ack", ["--lease", String(followUp.leaseId)], {
      commentRef: "rvw://comment/comment-1",
      postId: "agent-follow-up",
    });

    ingest(state, {
      type: "comment-posted",
      cursor: "cursor-4",
      event: {
        sequence: 4,
        postId: "agent-follow-up",
        commentRef: "rvw://comment/comment-1",
        pullRequestUrl: "https://github.com/acme/repo/pull/1",
        createdAt: "2026-08-20T00:00:03.000Z",
        deleted: true,
      },
    });
    expect(run(state, "recover")).toMatchObject({ recovered: 1, pending: 1 });
    const afterDeletion = run(state, "claim", [
      "--pull-request",
      "https://github.com/acme/repo/pull/1",
    ]);
    const replacement = (
      afterDeletion.operations as Array<{
        idempotencyKey: string;
        statusPostId: string | null;
      }>
    )[0]!;
    expect(replacement.statusPostId).toBeNull();
    expect(replacement.idempotencyKey).not.toBe(followUpKey);
  });

  it("recovers a lease with the same idempotency key and serializes repository writers", () => {
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-watch-state-")), "task.db");
    run(state, "init", ["--own-mode", "fix-and-push", "--expected-login", "reviewer"]);
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
    run(state, "ack", ["--lease", String(first.leaseId)], {
      commentRef: "rvw://comment/comment-1",
      postId: "agent-status-1",
    });
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
    expect(retried).toMatchObject({
      operations: [{ commentRef: "rvw://comment/comment-1", statusPostId: "agent-status-1" }],
    });
  });

  it("migrates the status post of an unfinished thread-scoped legacy batch", () => {
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-watch-state-")), "task.db");
    const pullRequest = "https://github.com/acme/repo/pull/4";
    const commentRef = "rvw://comment/comment-4";
    run(state, "init");
    ingest(state, {
      type: "ready",
      databaseId: "11223344556677889900aabbccddeeff",
      cursor: "cursor-0",
      anchoredAtCurrent: true,
    });
    ingest(state, {
      type: "comment-posted",
      cursor: "cursor-1",
      event: {
        sequence: 1,
        postId: "human-post-4",
        commentRef,
        pullRequestUrl: pullRequest,
        createdAt: "2026-08-20T00:00:00.000Z",
        deleted: false,
      },
    });
    const first = run(state, "claim", ["--pull-request", pullRequest]);
    const legacyKey = "legacy-task:batch:1";
    const database = new DatabaseSync(state);
    database.exec(`
      CREATE TABLE comment_statuses (
        comment_ref TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        post_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const batchCreatedAt = String(
      database.prepare("SELECT created_at FROM batches WHERE id = ?").get(String(first.batchId))!
        .created_at,
    );
    database.prepare("DELETE FROM operations WHERE batch_id = ?").run(String(first.batchId));
    database.exec("ALTER TABLE operations DROP COLUMN post_id;");
    database
      .prepare(
        `INSERT INTO comment_statuses(
          comment_ref, idempotency_key, post_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(commentRef, legacyKey, "legacy-status-post", batchCreatedAt, batchCreatedAt);
    database.prepare("DELETE FROM meta WHERE key = 'batch_scoped_status_posts'").run();
    database.close();

    run(state, "recover");
    const migrated = run(state, "claim", ["--pull-request", pullRequest]);
    expect(migrated).toMatchObject({
      operations: [{ commentRef, idempotencyKey: legacyKey, statusPostId: "legacy-status-post" }],
    });
  });

  it("surfaces status posts for an interrupted third attempt that becomes quarantined", () => {
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-watch-state-")), "task.db");
    const pullRequest = "https://github.com/acme/repo/pull/3";
    const commentRef = "rvw://comment/comment-3";
    run(state, "init");
    ingest(state, {
      type: "ready",
      databaseId: "00112233445566778899aabbccddeeff",
      cursor: "cursor-0",
      anchoredAtCurrent: true,
    });
    ingest(state, {
      type: "comment-posted",
      cursor: "cursor-1",
      event: {
        sequence: 1,
        postId: "human-post-3",
        commentRef,
        pullRequestUrl: pullRequest,
        createdAt: "2026-08-20T00:00:00.000Z",
        deleted: false,
      },
    });

    const first = run(state, "claim", ["--pull-request", pullRequest]);
    run(state, "ack", ["--lease", String(first.leaseId)], {
      commentRef,
      postId: "agent-status-3",
    });
    expect(run(state, "recover")).toMatchObject({ pending: 1, quarantined: 0 });
    run(state, "claim", ["--pull-request", pullRequest]);
    expect(run(state, "recover")).toMatchObject({ pending: 1, quarantined: 0 });
    run(state, "claim", ["--pull-request", pullRequest]);

    expect(run(state, "recover")).toMatchObject({
      pending: 0,
      quarantined: 1,
      quarantinedBatches: [
        {
          pullRequest,
          operations: [{ commentRef, statusPostId: "agent-status-3" }],
        },
      ],
    });
    expect(run(state, "status")).toMatchObject({
      batches: { quarantined: 1 },
      quarantinedBatches: [
        {
          pullRequest,
          operations: [{ commentRef, statusPostId: "agent-status-3" }],
        },
      ],
    });
  });
});
