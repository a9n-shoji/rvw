import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const script = path.resolve("skills/rvw-watch-comments/scripts/watch-state.mjs");
const authorityScript = path.resolve("test/fixtures/fake-watch-authority-rvw.mjs");

function authorityEnvironment(state: string) {
  return {
    ...process.env,
    RVW_BIN: process.execPath,
    RVW_BIN_ARGS_JSON: JSON.stringify([authorityScript]),
    FAKE_WATCH_STATE: state,
  };
}

function run(state: string, command: string, args: string[] = [], input?: unknown) {
  const result = spawnSync(process.execPath, [script, command, "--state", state, ...args], {
    encoding: "utf8",
    env: authorityEnvironment(state),
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function bindAuthority(state: string) {
  const database = new DatabaseSync(state);
  database.prepare("UPDATE meta SET value = '1' WHERE key = 'watch_ownership_schema'").run();
  database
    .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('watch_generation', '1')")
    .run();
  database
    .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('watch_ownership_status', 'active')")
    .run();
  database.close();
}

function ingest(state: string, frame: unknown) {
  const result = run(state, "ingest", [], frame);
  if ((frame as { type?: unknown })?.type === "ready") bindAuthority(state);
  return result;
}

describe("rvw-watch-comments task state", () => {
  it("fails closed instead of silently activating a legacy task state", () => {
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-watch-legacy-")), "task.db");
    run(state, "init");
    const database = new DatabaseSync(state);
    database.prepare("DELETE FROM meta WHERE key LIKE 'watch_ownership_%'").run();
    database.close();

    for (const command of ["activate", "verify"]) {
      const result = spawnSync(process.execPath, [script, command, "--state", state], {
        encoding: "utf8",
        env: authorityEnvironment(state),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Legacy watch state cannot be");
    }
  });

  it("durably skips operations independently and completes an all-skipped batch", () => {
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-watch-skip-")), "task.db");
    const pullRequest = "https://github.com/acme/repo/pull/10";
    run(state, "init");
    ingest(state, {
      type: "ready",
      databaseId: "00112233445566778899aabbccddeeff",
      cursor: "cursor-0",
      anchoredAtCurrent: false,
    });
    for (const [sequence, commentRef] of [
      "rvw://comment/resolved",
      "rvw://comment/gone",
    ].entries()) {
      ingest(state, {
        type: "comment-posted",
        cursor: `cursor-${sequence + 1}`,
        event: {
          sequence: sequence + 1,
          postId: `post-${sequence + 1}`,
          commentRef,
          pullRequestUrl: pullRequest,
          createdAt: "2026-08-20T00:00:00.000Z",
          deleted: false,
        },
      });
    }
    const claimed = run(state, "claim", ["--pull-request", pullRequest]);

    expect(
      run(state, "skip", ["--lease", String(claimed.leaseId)], {
        commentRef: "rvw://comment/resolved",
        reason: "resolved",
      }),
    ).toMatchObject({ status: "skipped", batchCompleted: false });
    expect(
      run(state, "skip", ["--lease", String(claimed.leaseId)], {
        commentRef: "rvw://comment/gone",
        reason: "gone",
      }),
    ).toMatchObject({ status: "skipped", batchCompleted: true });
    expect(run(state, "list")).toMatchObject({ inFlight: 0, pending: [] });
    expect(run(state, "status")).toMatchObject({
      batches: { completed: 1, inFlight: 0, unbatchedEvents: 0 },
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
    run(state, "init", ["--own-mode", "fix-and-push"]);
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
    bindAuthority(state);
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
        "--pull-request",
        pullRequest,
        "--write-key",
        "acme/repo",
      ],
      { encoding: "utf8", env: authorityEnvironment(state) },
    );
    expect(writeCapableClaim.status).toBe(1);
    expect(writeCapableClaim.stderr).toContain(
      "Task policy does not allow repository write reservations",
    );

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
    run(state, "init", ["--own-mode", "fix-and-push"]);
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
