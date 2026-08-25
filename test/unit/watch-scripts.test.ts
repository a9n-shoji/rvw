import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const scripts = path.resolve("skills/rvw-watch-comments/scripts");
const stateScript = path.join(scripts, "watch-state.mjs");
const preflightScript = path.join(scripts, "preflight.mjs");
const autoAckScript = path.join(scripts, "auto-ack.mjs");
const completeRepositoryScript = path.join(scripts, "complete-repository.mjs");
const driverScript = path.join(scripts, "watch-driver.mjs");

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

function stableReviewArgs(command: string, args: string[]): string[] {
  if (command !== "claim") return args;
  const pullRequestIndex = args.indexOf("--pull-request");
  if (pullRequestIndex >= 0) {
    const display = args[pullRequestIndex + 1]!;
    return [
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

interface FakeRvwCall {
  args: string[];
  input: unknown;
}

function readFakeCalls(log: string): FakeRvwCall[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown as FakeRvwCall);
}

function runState(state: string, command: string, args: string[] = [], input?: unknown) {
  const result = spawnSync(
    process.execPath,
    [stateScript, command, "--state", state, ...stableReviewArgs(command, args)],
    {
      encoding: "utf8",
      ...(input === undefined ? {} : { input: JSON.stringify(stableReviewFrame(input)) }),
    },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function createFakeRvw(directory: string): { script: string; log: string } {
  const script = path.join(directory, "fake-rvw.mjs");
  const log = path.join(directory, "rvw-calls.jsonl");
  writeFileSync(
    script,
    String.raw`import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const parsedInput = input ? JSON.parse(input) : null;
const priorCalls = existsSync(process.env.FAKE_RVW_LOG)
  ? readFileSync(process.env.FAKE_RVW_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  : [];
appendFileSync(process.env.FAKE_RVW_LOG, JSON.stringify({ args, input: parsedInput }) + "\n");
const json = (value, code = 0) => {
  process.stdout.write(JSON.stringify(value) + "\n");
  process.exitCode = code;
};
if (args[0] === "protocol") {
  json({ protocolVersion: 4, appVersion: "9.9.9", capabilities: [
    "agent.transport", "comment.watch", "comment.read", "comment.reply",
    "comment.edit", "comment.codeReferences", "pullRequest.sync", "repositoryReview.read"
  ] });
} else if (args[0] === "agent" && args[1] === "status") {
  json({ ok: true, connected: true, selectedTransport: "agent-socket" });
} else if (args[0] === "agent" && args[1] === "ping") {
  json({ ok: true, connected: true, selectedTransport: "agent-socket" });
} else if (args[0] === "comment" && args[1] === "get") {
  const goneCommentRefs = JSON.parse(process.env.FAKE_GONE_COMMENT_REFS_JSON ?? "[]");
  if (goneCommentRefs.includes(args[2])) {
    json({ ok: false, error: { code: "COMMENT_NOT_FOUND", message: "Comment no longer exists" } }, 2);
  } else {
  const pullRequestNumber = args[2]?.match(/comment-(\d+)/)?.[1] ?? "1";
  const pullRequestUrl = "https://github.com/acme/repo/pull/" + pullRequestNumber;
  json({ ok: true,
    context: { kind: "pull-request",
      pullRequestId: "pull-request:" + pullRequestUrl,
      pullRequestUrl },
    pullRequest: { id: "pull-request:" + pullRequestUrl,
      url: pullRequestUrl },
    comment: { ref: args[2], posts: [] } });
  }
} else if (args[0] === "comment" && args[1] === "reply") {
  const goneOnReplyCommentRefs = JSON.parse(process.env.FAKE_GONE_ON_REPLY_COMMENT_REFS_JSON ?? "[]");
  const deletedIdempotencyCommentRefs = JSON.parse(process.env.FAKE_DELETED_IDEMPOTENCY_COMMENT_REFS_JSON ?? "[]");
  if (goneOnReplyCommentRefs.includes(args[2])) {
    json({ ok: false, error: { code: "COMMENT_NOT_FOUND", message: "Comment disappeared before reply" } }, 2);
  } else if (deletedIdempotencyCommentRefs.includes(args[2])) {
    json({ ok: false, error: { code: "IDEMPOTENCY_RESULT_DELETED", message: "Reply was deleted",
      details: { postId: "deleted-status-post" } } }, 2);
  } else {
  const priorReplyIndex = priorCalls.findIndex((call) =>
    call.args[0] === "comment" && call.args[1] === "reply" &&
    call.input?.idempotencyKey === parsedInput.idempotencyKey
  );
  const replyCount = priorReplyIndex >= 0
    ? priorCalls.slice(0, priorReplyIndex + 1).filter((call) => call.args[0] === "comment" && call.args[1] === "reply").length
    : priorCalls.filter((call) => call.args[0] === "comment" && call.args[1] === "reply").length + 1;
  json({ ok: true, post: { id: "status-post-" + replyCount, body: parsedInput.body } });
  }
} else if (args[0] === "comment" && args[1] === "edit") {
  json({ ok: true, post: { id: args[4], body: parsedInput.body } });
} else if (args[0] === "comment" && args[1] === "watch") {
  const afterIndex = args.indexOf("--after");
  const startCursor = afterIndex < 0 ? "cursor-0" : args[afterIndex + 1];
  process.stdout.write("\u001e" + JSON.stringify({
    type: "ready", databaseId: "0123456789abcdef0123456789abcdef",
    cursor: startCursor, anchoredAtCurrent: afterIndex < 0
  }) + "\n");
  if (afterIndex < 0) {
    process.stdout.write("\u001e" + JSON.stringify({
      type: "comment-posted", cursor: "cursor-1", event: {
        sequence: 1, postId: "human-post", commentRef: "rvw://comment/comment-1",
        context: { kind: "pull-request",
          pullRequestId: "pull-request:https://github.com/acme/repo/pull/1",
          pullRequestUrl: "https://github.com/acme/repo/pull/1" },
        createdAt: "2026-08-20T00:00:00.000Z", deleted: false
      }
    }) + "\n");
  }
  process.on("SIGTERM", () => {
    process.stdout.write("\u001e" + JSON.stringify({ type: "stopped", cursor: startCursor }) + "\n");
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else {
  json({ ok: false, error: { code: "UNEXPECTED", message: args.join(" ") } }, 2);
}
`,
  );
  return { script, log };
}

function fakeEnvironment(
  fake: { script: string; log: string },
  goneCommentRefs: string[] = [],
  goneOnReplyCommentRefs: string[] = [],
  deletedIdempotencyCommentRefs: string[] = [],
) {
  return {
    ...process.env,
    RVW_BIN: process.execPath,
    RVW_BIN_ARGS_JSON: JSON.stringify([fake.script]),
    FAKE_RVW_LOG: fake.log,
    FAKE_GONE_COMMENT_REFS_JSON: JSON.stringify(goneCommentRefs),
    FAKE_GONE_ON_REPLY_COMMENT_REFS_JSON: JSON.stringify(goneOnReplyCommentRefs),
    FAKE_DELETED_IDEMPOTENCY_COMMENT_REFS_JSON: JSON.stringify(deletedIdempotencyCommentRefs),
  };
}

function initializeQueuedState(state: string) {
  runState(state, "init");
  runState(state, "ingest", [], {
    type: "ready",
    databaseId: "0123456789abcdef0123456789abcdef",
    cursor: "cursor-0",
    anchoredAtCurrent: true,
  });
  runState(state, "ingest", [], {
    type: "comment-posted",
    cursor: "cursor-1",
    event: {
      sequence: 1,
      postId: "human-post",
      commentRef: "rvw://comment/comment-1",
      pullRequestUrl: "https://github.com/acme/repo/pull/1",
      createdAt: "2026-08-20T00:00:00.000Z",
      deleted: false,
    },
  });
}

function initializeRepositoryQueuedState(
  state: string,
  commentRefs = ["rvw://comment/repository-comment"],
) {
  runState(state, "init", ["--own-mode", "fix-and-push"]);
  runState(state, "ingest", [], {
    type: "ready",
    databaseId: "fedcba9876543210fedcba9876543210",
    cursor: "cursor-0",
    anchoredAtCurrent: true,
  });
  for (const [index, commentRef] of commentRefs.entries()) {
    const sequence = index + 1;
    runState(state, "ingest", [], {
      type: "comment-posted",
      cursor: `cursor-${sequence}`,
      event: {
        sequence,
        postId: `branch-human-post-${sequence}`,
        commentRef,
        context: {
          kind: "repository",
          repositoryReviewId: "repository:acme/repo",
          repository: "acme/repo",
        },
        createdAt: `2026-08-20T00:00:0${index}.000Z`,
        deleted: false,
      },
    });
  }
}

function collectJsonLines(child: ChildProcessWithoutNullStreams) {
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
  }> = [];
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  return {
    messages,
    waitFor(predicate: (message: Record<string, unknown>) => boolean) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index < 0) return;
          waiters.splice(index, 1);
          reject(new Error("Timed out waiting for watch-driver output"));
        }, 5000);
      });
    },
  };
}

describe("rvw-watch-comments bundled scripts", () => {
  it("runs protocol, transport status, and ping as one preflight command", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-preflight-"));
    const fake = createFakeRvw(directory);
    const result = spawnSync(process.execPath, [preflightScript], {
      encoding: "utf8",
      env: fakeEnvironment(fake),
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      node: { ok: true },
      rvw: { appVersion: "9.9.9", protocolVersion: 4, missingCapabilities: [] },
      checks: { agentStatus: true, agentPingConnected: true },
    });
    const calls = readFakeCalls(fake.log).map((call) => call.args);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["protocol", "--json"],
        ["agent", "status", "--json"],
        ["agent", "ping", "--json"],
      ]),
    );
  });

  it("claims, reads, replies, and records an acknowledgement in one call", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-auto-ack-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeQueuedState(state);

    const result = spawnSync(
      process.execPath,
      [
        autoAckScript,
        "--state",
        state,
        "--context-kind",
        "pull-request",
        "--context-key",
        "pull-request:https://github.com/acme/repo/pull/1",
        "--context-display",
        "https://github.com/acme/repo/pull/1",
        "--author-label",
        "Codex",
      ],
      { encoding: "utf8", env: fakeEnvironment(fake) },
    );

    expect(result.status).toBe(0);
    const firstAcknowledgement = JSON.parse(result.stdout) as unknown as {
      leaseId: string;
      operations: Array<{ idempotencyKey: string }>;
    };
    expect(firstAcknowledgement).toMatchObject({
      ok: true,
      type: "acknowledged",
      operations: [
        {
          commentRef: "rvw://comment/comment-1",
          statusPostId: "status-post-1",
          acknowledgement: "created",
          status: "acknowledged",
        },
      ],
    });
    expect(runState(state, "status")).toMatchObject({
      batches: { inFlight: 1 },
      inFlightBatches: [
        { operations: [{ commentRef: "rvw://comment/comment-1", statusPostId: "status-post-1" }] },
      ],
    });
    const replyCall = readFakeCalls(fake.log).find((call) => call.args[1] === "reply");
    expect(replyCall?.input).toMatchObject({ body: "🔎 確認中です…", authorLabel: "Codex" });
    expect(typeof (replyCall?.input as { idempotencyKey?: unknown }).idempotencyKey).toBe("string");

    runState(state, "complete", ["--lease", firstAcknowledgement.leaseId], { postIds: [] });
    runState(state, "ingest", [], {
      type: "comment-posted",
      cursor: "cursor-2",
      event: {
        sequence: 2,
        postId: "human-follow-up",
        commentRef: "rvw://comment/comment-1",
        pullRequestUrl: "https://github.com/acme/repo/pull/1",
        createdAt: "2026-08-20T00:00:01.000Z",
        deleted: false,
      },
    });
    const followUpAcknowledgement = spawnSync(
      process.execPath,
      [
        autoAckScript,
        "--state",
        state,
        "--context-kind",
        "pull-request",
        "--context-key",
        "pull-request:https://github.com/acme/repo/pull/1",
        "--context-display",
        "https://github.com/acme/repo/pull/1",
        "--author-label",
        "Codex",
      ],
      { encoding: "utf8", env: fakeEnvironment(fake) },
    );
    expect(followUpAcknowledgement.status).toBe(0);
    const followUp = JSON.parse(followUpAcknowledgement.stdout) as {
      operations: Array<{ idempotencyKey: string }>;
    };
    expect(followUp).toMatchObject({
      operations: [
        {
          statusPostId: "status-post-2",
          acknowledgement: "created",
        },
      ],
    });
    expect(followUp.operations[0]?.idempotencyKey).not.toBe(
      firstAcknowledgement.operations[0]?.idempotencyKey,
    );
    const calls = readFakeCalls(fake.log);
    expect(calls.filter((call) => call.args[1] === "reply")).toHaveLength(2);
    expect(calls.some((call) => call.args[1] === "edit")).toBe(false);
  });

  it("pins the acknowledgement author before reply and rejects a changed or omitted restart label", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-auto-ack-author-recovery-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeQueuedState(state);
    const contextArguments = [
      "--context-kind",
      "pull-request",
      "--context-key",
      "pull-request:https://github.com/acme/repo/pull/1",
      "--context-display",
      "https://github.com/acme/repo/pull/1",
    ];
    const claimed = runState(state, "claim", [...contextArguments, "--author-label", "Codex"]) as {
      operations: Array<{ commentRef: string; idempotencyKey: string }>;
    };
    const operation = claimed.operations[0];
    expect(operation).toBeDefined();
    expect(runState(state, "status")).toMatchObject({
      authorLabel: "Codex",
      authorLabelBound: true,
    });

    const firstReply = spawnSync(
      process.execPath,
      [fake.script, "comment", "reply", operation!.commentRef, "--stdin", "--json"],
      {
        encoding: "utf8",
        env: fakeEnvironment(fake),
        input: JSON.stringify({
          body: "🔎 確認中です…",
          idempotencyKey: operation!.idempotencyKey,
          authorLabel: "Codex",
        }),
      },
    );
    expect(firstReply.status).toBe(0);
    expect(JSON.parse(firstReply.stdout)).toMatchObject({ post: { id: "status-post-1" } });
    expect(runState(state, "recover")).toMatchObject({ recovered: 1, pending: 1 });

    for (const restartArguments of [
      [...contextArguments, "--author-label", "Claude Code"],
      contextArguments,
    ]) {
      const restart = spawnSync(
        process.execPath,
        [autoAckScript, "--state", state, ...restartArguments],
        { encoding: "utf8", env: fakeEnvironment(fake) },
      );
      expect(restart.status).toBe(1);
      expect(JSON.parse(restart.stdout)).toMatchObject({
        ok: false,
        error: "watch-state claim failed",
      });
      expect(readFakeCalls(fake.log)).toHaveLength(1);
    }

    const resumed = spawnSync(
      process.execPath,
      [autoAckScript, "--state", state, ...contextArguments, "--author-label", "Codex"],
      { encoding: "utf8", env: fakeEnvironment(fake) },
    );
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      ok: true,
      attempts: 2,
      operations: [{ statusPostId: "status-post-1", acknowledgement: "created" }],
    });
    const replyCalls = readFakeCalls(fake.log).filter(
      (call) => call.args[0] === "comment" && call.args[1] === "reply",
    );
    expect(replyCalls).toHaveLength(2);
    expect(replyCalls[0]?.input).toEqual(replyCalls[1]?.input);
  });

  it("rejects a changed author label before an empty watcher starts", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-watch-driver-author-startup-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeQueuedState(state);
    const claimed = runState(state, "claim", [
      "--context-kind",
      "pull-request",
      "--context-key",
      "pull-request:https://github.com/acme/repo/pull/1",
      "--context-display",
      "https://github.com/acme/repo/pull/1",
      "--author-label",
      "Codex",
    ]) as { leaseId: string };
    runState(state, "complete", ["--lease", claimed.leaseId], { postIds: [] });
    expect(runState(state, "status")).toMatchObject({
      authorLabel: "Codex",
      authorLabelBound: true,
      batches: { pending: 0, inFlight: 0, completed: 1 },
    });

    for (const args of [
      [driverScript, state, "--auto-ack", "--author-label", "Claude Code"],
      [driverScript, state, "--auto-ack"],
    ]) {
      const result = spawnSync(process.execPath, args, {
        encoding: "utf8",
        env: fakeEnvironment(fake),
      });
      expect(result.status).toBe(23);
      expect(result.stdout).toBe("");
      const failure = JSON.parse(result.stderr) as { error?: unknown };
      expect(failure).toMatchObject({ ok: false, exitCode: 23 });
      expect(failure.error).toEqual(
        expect.stringContaining("Existing task author label Codex does not match"),
      );
    }
    expect(existsSync(fake.log)).toBe(false);
  });

  it("posts one Repository Review final reply and durably suppresses its later event", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-branch-complete-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeRepositoryQueuedState(state);
    const claimed = runState(state, "claim", [
      "--context-kind",
      "repository",
      "--context-key",
      "acme/repo",
    ]);
    const input = {
      leaseId: claimed.leaseId,
      context: {
        kind: "repository",
        repositoryReviewId: "repository:acme/repo",
        repository: "acme/repo",
      },
      outcomes: [
        {
          commentRef: "rvw://comment/repository-comment",
          body: "📝 調査結果\n\nRead [the source policy](rvw-ref:source-policy).",
          relatedCommitOid: "a".repeat(64),
          references: [
            {
              id: "source-policy",
              label: "Source policy",
              path: "src/application/rvw-service.ts",
              startLine: 1317,
              endLine: 1330,
              description: null,
            },
          ],
          pushStatus: "not-attempted",
        },
      ],
    };
    const completed = spawnSync(
      process.execPath,
      [completeRepositoryScript, "--state", state, "--lease", String(claimed.leaseId)],
      { encoding: "utf8", env: fakeEnvironment(fake), input: JSON.stringify(input) },
    );

    expect(completed.status, completed.stderr).toBe(0);
    const result = JSON.parse(completed.stdout) as {
      replies: Array<{ idempotencyKey: string; postId: string }>;
    };
    expect(result).toMatchObject({
      type: "repository-completed",
      context: { kind: "repository", repository: "acme/repo" },
      replies: [{ postId: "status-post-1" }],
    });
    expect(result.replies[0]?.idempotencyKey).toBe(
      (claimed.operations as Array<{ idempotencyKey: string }>)[0]?.idempotencyKey,
    );
    expect(readFakeCalls(fake.log).find((call) => call.args[1] === "reply")?.input).toMatchObject({
      relatedCommitOid: "a".repeat(64),
      references: [{ id: "source-policy", path: "src/application/rvw-service.ts" }],
    });
    expect(runState(state, "list")).toMatchObject({ pending: [] });
    expect(
      runState(state, "ingest", [], {
        type: "comment-posted",
        cursor: "cursor-2",
        event: {
          sequence: 2,
          postId: result.replies[0]?.postId,
          commentRef: "rvw://comment/repository-comment",
          context: {
            kind: "repository",
            repositoryReviewId: "repository:acme/repo",
            repository: "acme/repo",
          },
          createdAt: "2026-08-20T00:00:01.000Z",
          deleted: false,
        },
      }),
    ).toMatchObject({ status: "suppressed" });
  });

  it("completes an all-gone Repository Review batch without posting a reply", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-repository-all-gone-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeRepositoryQueuedState(state);
    const claimed = runState(state, "claim", [
      "--context-kind",
      "repository",
      "--context-key",
      "acme/repo",
    ]);
    const completed = spawnSync(
      process.execPath,
      [completeRepositoryScript, "--state", state, "--lease", String(claimed.leaseId)],
      {
        encoding: "utf8",
        env: fakeEnvironment(fake, ["rvw://comment/repository-comment"]),
        input: JSON.stringify({
          leaseId: claimed.leaseId,
          context: {
            kind: "repository",
            repositoryReviewId: "repository:acme/repo",
            repository: "acme/repo",
          },
          outcomes: [{ commentRef: "rvw://comment/repository-comment", status: "gone" }],
        }),
      },
    );

    expect(completed.status, completed.stderr).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({
      type: "repository-completed",
      replies: [],
      gone: [
        {
          commentRef: "rvw://comment/repository-comment",
          status: "gone",
          reason: "confirmed",
        },
      ],
    });
    expect(readFakeCalls(fake.log).map((call) => call.args.slice(0, 2))).toEqual([
      ["comment", "get"],
    ]);
    expect(runState(state, "status")).toMatchObject({
      batches: { pending: 0, inFlight: 0, completed: 1, quarantined: 0 },
    });
  });

  it("completes a mixed Repository Review batch with replies only for surviving Comments", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-repository-mixed-gone-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    const surviving = "rvw://comment/repository-comment";
    const deleted = "rvw://comment/repository-comment-gone";
    initializeRepositoryQueuedState(state, [surviving, deleted]);
    const claimed = runState(state, "claim", [
      "--context-kind",
      "repository",
      "--context-key",
      "acme/repo",
    ]);
    const completed = spawnSync(
      process.execPath,
      [completeRepositoryScript, "--state", state, "--lease", String(claimed.leaseId)],
      {
        encoding: "utf8",
        env: fakeEnvironment(fake, [deleted]),
        input: JSON.stringify({
          leaseId: claimed.leaseId,
          context: {
            kind: "repository",
            repositoryReviewId: "repository:acme/repo",
            repository: "acme/repo",
          },
          outcomes: [
            {
              commentRef: surviving,
              status: "reply",
              body: "📝 調査結果\n\nThe surviving Comment receives this reply.",
              relatedCommitOid: null,
              references: [],
              pushStatus: "not-attempted",
            },
            { commentRef: deleted, status: "gone" },
          ],
        }),
      },
    );

    expect(completed.status, completed.stderr).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({
      replies: [{ commentRef: surviving, postId: "status-post-1" }],
      gone: [{ commentRef: deleted, reason: "confirmed" }],
    });
    expect(readFakeCalls(fake.log).filter((call) => call.args[1] === "reply")).toHaveLength(1);
    expect(runState(state, "list")).toMatchObject({ pending: [] });
  });

  it("completes after one Repository reply succeeds and another Comment disappears during reply", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-repository-late-gone-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    const first = "rvw://comment/repository-comment-first";
    const lateGone = "rvw://comment/repository-comment-late-gone";
    initializeRepositoryQueuedState(state, [first, lateGone]);
    const claimed = runState(state, "claim", [
      "--context-kind",
      "repository",
      "--context-key",
      "acme/repo",
    ]);
    const outcomes = [first, lateGone].map((commentRef) => ({
      commentRef,
      status: "reply",
      body: `📝 調査結果\n\nOutcome for ${commentRef}.`,
      relatedCommitOid: null,
      references: [],
      pushStatus: "not-attempted",
    }));
    const completed = spawnSync(
      process.execPath,
      [completeRepositoryScript, "--state", state, "--lease", String(claimed.leaseId)],
      {
        encoding: "utf8",
        env: fakeEnvironment(fake, [], [lateGone]),
        input: JSON.stringify({
          leaseId: claimed.leaseId,
          context: {
            kind: "repository",
            repositoryReviewId: "repository:acme/repo",
            repository: "acme/repo",
          },
          outcomes,
        }),
      },
    );

    expect(completed.status, completed.stderr).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({
      replies: [{ commentRef: first, postId: "status-post-1" }],
      gone: [{ commentRef: lateGone, reason: "deleted-during-reply" }],
    });
    expect(readFakeCalls(fake.log).filter((call) => call.args[1] === "reply")).toHaveLength(2);
    expect(runState(state, "status")).toMatchObject({
      batches: { pending: 0, inFlight: 0, completed: 1, quarantined: 0 },
    });
  });

  it("completes recovery when the idempotent Repository reply was deleted", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-repository-deleted-reply-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    const commentRef = "rvw://comment/repository-comment";
    initializeRepositoryQueuedState(state, [commentRef]);
    const claimed = runState(state, "claim", [
      "--context-kind",
      "repository",
      "--context-key",
      "acme/repo",
    ]);
    const completed = spawnSync(
      process.execPath,
      [completeRepositoryScript, "--state", state, "--lease", String(claimed.leaseId)],
      {
        encoding: "utf8",
        env: fakeEnvironment(fake, [], [], [commentRef]),
        input: JSON.stringify({
          leaseId: claimed.leaseId,
          context: {
            kind: "repository",
            repositoryReviewId: "repository:acme/repo",
            repository: "acme/repo",
          },
          outcomes: [
            {
              commentRef,
              status: "reply",
              body: "📝 調査結果\n\nThis reply existed before recovery.",
              relatedCommitOid: null,
              references: [],
              pushStatus: "not-attempted",
            },
          ],
        }),
      },
    );

    expect(completed.status, completed.stderr).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({
      replies: [],
      gone: [
        {
          commentRef,
          status: "gone",
          reason: "reply-deleted-after-crash",
          suppressedPostId: "deleted-status-post",
        },
      ],
      completion: {
        status: "completed",
        suppressedPostIds: ["deleted-status-post"],
      },
    });
    expect(readFakeCalls(fake.log).map((call) => call.args.slice(0, 2))).toEqual([
      ["comment", "get"],
      ["comment", "reply"],
    ]);
    expect(runState(state, "status")).toMatchObject({
      batches: { pending: 0, inFlight: 0, completed: 1, quarantined: 0 },
    });
  });

  it("rejects Repository Review auto-ack before claiming a lease", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-branch-no-ack-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeRepositoryQueuedState(state);

    const result = spawnSync(
      process.execPath,
      [
        autoAckScript,
        "--state",
        state,
        "--context-kind",
        "repository",
        "--context-key",
        "repository:acme/repo",
        "--context-display",
        "acme/repo",
      ],
      { encoding: "utf8", env: fakeEnvironment(fake) },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("auto-ack only accepts Pull Request batches");
    expect(readFakeCalls(fake.log)).toEqual([]);
    expect(runState(state, "status")).toMatchObject({ batches: { inFlight: 0 } });
  });

  it("reuses the Repository Review final-reply idempotency key after recovery", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-branch-restart-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeRepositoryQueuedState(state);
    const firstClaim = runState(state, "claim", [
      "--context-kind",
      "repository",
      "--context-key",
      "acme/repo",
    ]);
    const idempotencyKey = (firstClaim.operations as Array<{ idempotencyKey: string }>)[0]
      ?.idempotencyKey;
    const firstReply = spawnSync(
      process.execPath,
      [fake.script, "comment", "reply", "rvw://comment/repository-comment", "--stdin", "--json"],
      {
        encoding: "utf8",
        env: fakeEnvironment(fake),
        input: JSON.stringify({
          body: "📝 調査結果\n\nRecovered outcome.",
          relatedCommitOid: null,
          references: [],
          idempotencyKey,
        }),
      },
    );
    expect(firstReply.status, firstReply.stderr).toBe(0);
    const firstPostId = (JSON.parse(firstReply.stdout) as { post: { id: string } }).post.id;

    expect(runState(state, "recover")).toMatchObject({ recovered: 1, pending: 1 });
    const recoveredClaim = runState(state, "claim", [
      "--context-kind",
      "repository",
      "--context-key",
      "acme/repo",
    ]);
    expect(
      (recoveredClaim.operations as Array<{ idempotencyKey: string }>)[0]?.idempotencyKey,
    ).toBe(idempotencyKey);
    const completed = spawnSync(
      process.execPath,
      [completeRepositoryScript, "--state", state, "--lease", String(recoveredClaim.leaseId)],
      {
        encoding: "utf8",
        env: fakeEnvironment(fake),
        input: JSON.stringify({
          leaseId: recoveredClaim.leaseId,
          context: {
            kind: "repository",
            repositoryReviewId: "repository:acme/repo",
            repository: "acme/repo",
          },
          outcomes: [
            {
              commentRef: "rvw://comment/repository-comment",
              body: "📝 調査結果\n\nRecovered outcome.",
              relatedCommitOid: null,
              references: [],
              pushStatus: "not-attempted",
            },
          ],
        }),
      },
    );
    expect(completed.status, completed.stderr).toBe(0);
    const result = JSON.parse(completed.stdout) as { replies: Array<{ postId: string }> };
    expect(result.replies[0]?.postId).toBe(firstPostId);
    const replyCalls = readFakeCalls(fake.log).filter((call) => call.args[1] === "reply");
    expect(replyCalls).toHaveLength(2);
    expect(
      new Set(replyCalls.map((call) => (call.input as { idempotencyKey: string }).idempotencyKey)),
    ).toEqual(new Set([idempotencyKey]));
    expect(runState(state, "list")).toMatchObject({ pending: [] });
  });

  it("rejects Repository Review worker outcomes that claim a write", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-branch-write-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeRepositoryQueuedState(state);
    const claimed = runState(state, "claim", [
      "--context-kind",
      "repository",
      "--context-key",
      "acme/repo",
    ]);
    const result = spawnSync(
      process.execPath,
      [completeRepositoryScript, "--state", state, "--lease", String(claimed.leaseId)],
      {
        encoding: "utf8",
        env: fakeEnvironment(fake),
        input: JSON.stringify({
          leaseId: claimed.leaseId,
          context: {
            kind: "repository",
            repositoryReviewId: "repository:acme/repo",
            repository: "acme/repo",
          },
          outcomes: [
            {
              commentRef: "rvw://comment/repository-comment",
              body: "This must not be posted.",
              relatedCommitOid: "a".repeat(40),
              references: [],
              pushStatus: "pushed",
            },
          ],
        }),
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pushStatus: not-attempted");
    expect(readFakeCalls(fake.log)).toEqual([]);
    expect(runState(state, "status").inFlightBatches).toHaveLength(1);
  });

  it("rejects an incomplete Repository Review worker result before posting any reply", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-branch-schema-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeRepositoryQueuedState(state);
    const claimed = runState(state, "claim", [
      "--context-kind",
      "repository",
      "--context-key",
      "acme/repo",
    ]);
    const validOutcome = {
      commentRef: "rvw://comment/repository-comment",
      body: "📝 調査結果\n\nNo repository write was attempted.",
      relatedCommitOid: null,
      references: [],
      pushStatus: "not-attempted",
    };
    const invalidInputs = [
      {
        context: {
          kind: "repository",
          repositoryReviewId: "repository:acme/repo",
          repository: "acme/repo",
        },
        outcomes: [validOutcome],
      },
      { leaseId: claimed.leaseId, outcomes: [validOutcome] },
      {
        leaseId: "different-lease",
        context: {
          kind: "repository",
          repositoryReviewId: "repository:acme/repo",
          repository: "acme/repo",
        },
        outcomes: [validOutcome],
      },
      {
        leaseId: claimed.leaseId,
        context: {
          kind: "repository",
          repositoryReviewId: "repository:acme/other",
          repository: "acme/other",
        },
        outcomes: [validOutcome],
      },
      {
        leaseId: claimed.leaseId,
        context: {
          kind: "repository",
          repositoryReviewId: "repository:acme/repo",
          repository: "acme/repo",
        },
        outcomes: [{ ...validOutcome, relatedCommitOid: undefined }],
      },
      {
        leaseId: claimed.leaseId,
        context: {
          kind: "repository",
          repositoryReviewId: "repository:acme/repo",
          repository: "acme/repo",
        },
        outcomes: [{ ...validOutcome, references: undefined }],
      },
      {
        leaseId: claimed.leaseId,
        context: {
          kind: "repository",
          repositoryReviewId: "repository:acme/repo",
          repository: "acme/repo",
        },
        outcomes: [{ ...validOutcome, pushStatus: undefined }],
      },
      {
        leaseId: claimed.leaseId,
        context: {
          kind: "repository",
          repositoryReviewId: "repository:acme/repo",
          repository: "acme/repo",
        },
        outcomes: [{ ...validOutcome, relatedCommitOid: "A".repeat(40) }],
      },
      {
        leaseId: claimed.leaseId,
        context: {
          kind: "repository",
          repositoryReviewId: "repository:acme/repo",
          repository: "acme/repo",
        },
        outcomes: [{ ...validOutcome, relatedCommitOid: "a".repeat(41) }],
      },
    ];

    for (const input of invalidInputs) {
      const result = spawnSync(
        process.execPath,
        [completeRepositoryScript, "--state", state, "--lease", String(claimed.leaseId)],
        { encoding: "utf8", env: fakeEnvironment(fake), input: JSON.stringify(input) },
      );
      expect(result.status).not.toBe(0);
    }

    expect(readFakeCalls(fake.log)).toEqual([]);
    expect(runState(state, "status").inFlightBatches).toHaveLength(1);
  });

  it("drives RFC 7464 intake and auto-ack without an Agent shell round trip", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-watch-driver-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    runState(state, "init");
    const child = spawn(process.execPath, [driverScript, state, "--auto-ack"], {
      env: fakeEnvironment(fake),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: unknown[] = [];
    let buffered = "";
    const acknowledged = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("driver acknowledgement timed out")), 5000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        const complete = buffered.split("\n");
        buffered = complete.pop() ?? "";
        for (const line of complete.filter(Boolean)) {
          const parsed = JSON.parse(line) as { type?: string };
          lines.push(parsed);
          if (parsed.type === "batch-acknowledged") {
            clearTimeout(timeout);
            resolve();
          }
        }
      });
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await acknowledged;
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    expect(code, stderr).toBe(0);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "watch-ready", cursor: "cursor-0", autoAck: true }),
        expect.objectContaining({
          type: "batch-acknowledged",
          operations: [expect.objectContaining({ statusPostId: "status-post-1" })],
        }),
      ]),
    );
    expect(runState(state, "status")).toMatchObject({
      cursor: "cursor-1",
      batches: { inFlight: 1 },
    });
    const watchCall = readFakeCalls(fake.log).find(
      (call) => call.args[0] === "comment" && call.args[1] === "watch",
    );
    expect(watchCall?.args).toEqual(["comment", "watch", "--interval", "1", "--json-seq"]);
  });

  it("acknowledges a durably ingested event before resuming its cursor", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-watch-driver-recover-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeQueuedState(state);
    const legacy = new DatabaseSync(state);
    legacy.exec(`
      UPDATE events
      SET context_key = pull_request_url, context_display = pull_request_url
      WHERE review_kind = 'pull-request';
    `);
    legacy.close();
    const child = spawn(process.execPath, [driverScript, state, "--auto-ack"], {
      env: fakeEnvironment(fake),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const messages: Array<Record<string, unknown>> = [];
    let buffered = "";
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("driver recovery timed out")), 5000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        const complete = buffered.split("\n");
        buffered = complete.pop() ?? "";
        for (const line of complete.filter(Boolean)) {
          const parsed = JSON.parse(line) as Record<string, unknown> & { type: string };
          messages.push(parsed);
          if (parsed.type === "watch-ready") {
            clearTimeout(timeout);
            resolve();
          }
        }
      });
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await ready;
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    expect(code, stderr).toBe(0);
    expect(messages.slice(0, 2)).toMatchObject([
      {
        type: "batch-acknowledged",
        context: {
          kind: "pull-request",
          pullRequestId: "pull-request:https://github.com/acme/repo/pull/1",
          pullRequestUrl: "https://github.com/acme/repo/pull/1",
        },
      },
      { type: "watch-ready" },
    ]);
    expect(runState(state, "status")).toMatchObject({
      inFlightBatches: [
        {
          context: {
            kind: "pull-request",
            pullRequestId: "pull-request:https://github.com/acme/repo/pull/1",
          },
        },
      ],
    });
    const watchCall = readFakeCalls(fake.log).find(
      (call) => call.args[0] === "comment" && call.args[1] === "watch",
    );
    expect(watchCall?.args).toEqual([
      "comment",
      "watch",
      "--after",
      "cursor-1",
      "--interval",
      "1",
      "--json-seq",
    ]);
  });

  it.each([
    {
      label: "protocol-v4 stable-ID",
      legacyUrlKeyed: false,
      expectedContextKey: "pull-request:https://github.com/acme/repo/pull/1",
    },
    {
      label: "legacy URL-keyed v3",
      legacyUrlKeyed: true,
      expectedContextKey: "https://github.com/acme/repo/pull/1",
    },
  ])(
    "discards an all-gone $label batch and keeps watching without acknowledgement",
    async ({ legacyUrlKeyed, expectedContextKey }) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-watch-all-gone-"));
      const fake = createFakeRvw(directory);
      const state = path.join(directory, "task.db");
      initializeQueuedState(state);
      if (legacyUrlKeyed) {
        const legacy = new DatabaseSync(state);
        legacy.exec(`
          UPDATE events
          SET context_key = pull_request_url, context_display = pull_request_url
          WHERE review_kind = 'pull-request';
        `);
        legacy.close();
      }
      const child = spawn(process.execPath, [driverScript, state, "--auto-ack"], {
        env: fakeEnvironment(fake, ["rvw://comment/comment-1"]),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const output = collectJsonLines(child);
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const discarded = await output.waitFor((message) => message.type === "batch-discarded");
      await output.waitFor((message) => message.type === "watch-ready");

      expect(discarded).toMatchObject({
        ok: true,
        type: "batch-discarded",
        reason: "all-comments-gone",
        context: { kind: "pull-request", pullRequestId: expectedContextKey },
        operations: [
          {
            commentRef: "rvw://comment/comment-1",
            status: "gone",
            acknowledgement: "skipped",
          },
        ],
      });
      expect(child.exitCode, stderr).toBeNull();
      expect(runState(state, "status")).toMatchObject({
        batches: {
          pending: 0,
          inFlight: 0,
          completed: 1,
          quarantined: 0,
          unbatchedEvents: 0,
        },
        inFlightBatches: [],
        quarantinedBatches: [],
      });
      const calls = readFakeCalls(fake.log);
      expect(calls.some((call) => ["reply", "edit"].includes(call.args[1] ?? ""))).toBe(false);

      child.kill("SIGTERM");
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code, stderr).toBe(0);
      const database = new DatabaseSync(state);
      const batch = database
        .prepare("SELECT status, attempts, last_error, context_key FROM batches")
        .get() as Record<string, unknown>;
      database.close();
      expect(batch).toMatchObject({
        status: "completed",
        attempts: 1,
        last_error: null,
        context_key: expectedContextKey,
      });
    },
  );

  it("allows only one driver process to own a task state", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-watch-driver-owner-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    runState(state, "init");
    const canonicalState = realpathSync(state);
    const lockPath = `${canonicalState}.watch-driver.lock`;
    const first = spawn(process.execPath, [driverScript, state], {
      env: fakeEnvironment(fake),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let firstStderr = "";
    first.stderr.setEncoding("utf8");
    first.stderr.on("data", (chunk: string) => {
      firstStderr += chunk;
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("first driver startup timed out")), 5000);
      let buffered = "";
      first.stdout.setEncoding("utf8");
      first.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const parsed = JSON.parse(line) as { type?: string };
          if (parsed.type !== "watch-ready") continue;
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    await ready;
    expect(existsSync(lockPath)).toBe(true);
    const duplicate = spawnSync(process.execPath, [driverScript, state], {
      encoding: "utf8",
      env: fakeEnvironment(fake),
    });
    expect(duplicate.status).toBe(24);
    expect(duplicate.stdout).toBe("");
    expect(JSON.parse(duplicate.stderr)).toMatchObject({
      ok: false,
      error: "Another watch-driver process already owns this task state",
      details: { state: canonicalState, lockPath, ownerPid: first.pid },
      exitCode: 24,
    });
    expect(
      readFakeCalls(fake.log).filter(
        (call) => call.args[0] === "comment" && call.args[1] === "watch",
      ),
    ).toHaveLength(1);

    first.kill("SIGTERM");
    const firstCode = await new Promise<number | null>((resolve, reject) => {
      first.once("error", reject);
      first.once("close", resolve);
    });
    expect(firstCode, firstStderr).toBe(0);
    expect(existsSync(lockPath)).toBe(false);

    const exitedOwner = spawnSync(process.execPath, ["--eval", ""]);
    if (!exitedOwner.pid) throw new Error("could not create a stale owner PID");
    writeFileSync(lockPath, `${JSON.stringify({ pid: exitedOwner.pid, state: canonicalState })}\n`);
    const restarted = spawn(process.execPath, [driverScript, state], {
      env: fakeEnvironment(fake),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let restartedStderr = "";
    restarted.stderr.setEncoding("utf8");
    restarted.stderr.on("data", (chunk: string) => {
      restartedStderr += chunk;
    });
    const restartedReady = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("restarted driver startup timed out")),
        5000,
      );
      let buffered = "";
      restarted.stdout.setEncoding("utf8");
      restarted.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const parsed = JSON.parse(line) as { type?: string };
          if (parsed.type !== "watch-ready") continue;
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    await restartedReady;
    restarted.kill("SIGTERM");
    const restartedCode = await new Promise<number | null>((resolve, reject) => {
      restarted.once("error", reject);
      restarted.once("close", resolve);
    });
    expect(restartedCode, restartedStderr).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("limits acknowledged leases to reserved worker capacity and drains after completion", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-watch-capacity-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    runState(state, "init");
    runState(state, "ingest", [], {
      type: "ready",
      databaseId: "0123456789abcdef0123456789abcdef",
      cursor: "cursor-0",
      anchoredAtCurrent: true,
    });
    for (const sequence of [1, 2]) {
      runState(state, "ingest", [], {
        type: "comment-posted",
        cursor: `cursor-${sequence}`,
        event: {
          sequence,
          postId: `human-post-${sequence}`,
          commentRef: `rvw://comment/comment-${sequence}`,
          pullRequestUrl: `https://github.com/acme/repo/pull/${sequence}`,
          createdAt: `2026-08-20T00:00:0${sequence}.000Z`,
          deleted: false,
        },
      });
    }
    const child = spawn(
      process.execPath,
      [driverScript, state, "--auto-ack", "--max-in-flight", "1"],
      {
        env: { ...fakeEnvironment(fake), RVW_WATCH_AUTO_ACK_POLL_MS: "10" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output = collectJsonLines(child);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const ready = await output.waitFor((message) => message.type === "watch-ready");
    expect(ready).toMatchObject({ autoAck: true, maxInFlight: 1 });
    const firstAcknowledgements = output.messages.filter(
      (message) => message.type === "batch-acknowledged",
    );
    expect(firstAcknowledgements).toHaveLength(1);
    expect(runState(state, "status")).toMatchObject({
      batches: { inFlight: 1, unbatchedEvents: 1 },
    });

    runState(state, "complete", ["--lease", String(firstAcknowledgements[0]?.leaseId)], {
      postIds: [],
    });
    const second = await output.waitFor(
      (message) =>
        message.type === "batch-acknowledged" &&
        message.pullRequest !== firstAcknowledgements[0]?.pullRequest,
    );
    expect(second).toMatchObject({ attempts: 1 });
    expect(runState(state, "status")).toMatchObject({
      batches: { inFlight: 1, unbatchedEvents: 0 },
    });

    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(code, stderr).toBe(0);
  });

  it("acknowledges a same-PR follow-up while an investigate-only lease is active", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-watch-follow-up-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeQueuedState(state);
    const child = spawn(
      process.execPath,
      [driverScript, state, "--auto-ack", "--max-in-flight", "2"],
      {
        env: { ...fakeEnvironment(fake), RVW_WATCH_AUTO_ACK_POLL_MS: "10" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output = collectJsonLines(child);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const first = await output.waitFor(
      (message) => message.type === "batch-acknowledged" && message.attempts === 1,
    );
    await output.waitFor((message) => message.type === "watch-ready");
    runState(state, "ingest", [], {
      type: "comment-posted",
      cursor: "cursor-2",
      event: {
        sequence: 2,
        postId: "human-follow-up",
        commentRef: "rvw://comment/comment-1",
        pullRequestUrl: "https://github.com/acme/repo/pull/1",
        createdAt: "2026-08-20T00:00:02.000Z",
        deleted: false,
      },
    });
    expect(runState(state, "status")).toMatchObject({
      batches: { inFlight: 1, unbatchedEvents: 1 },
    });

    const followUp = await output.waitFor(
      (message) =>
        message.type === "batch-acknowledged" &&
        message.pullRequest === first.pullRequest &&
        message.batchId !== first.batchId,
    );
    expect(followUp).toMatchObject({
      attempts: 1,
      operations: [expect.objectContaining({ acknowledgement: "created" })],
    });
    expect(runState(state, "status")).toMatchObject({
      batches: { inFlight: 2, unbatchedEvents: 0 },
    });

    runState(state, "complete", ["--lease", String(first.leaseId)], { postIds: [] });
    runState(state, "complete", ["--lease", String(followUp.leaseId)], { postIds: [] });

    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(code, stderr).toBe(0);
  });

  it("auto-acknowledges a retry when nextAttemptAt becomes due without another event", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-watch-retry-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeQueuedState(state);
    const child = spawn(
      process.execPath,
      [driverScript, state, "--auto-ack", "--max-in-flight", "1"],
      {
        env: { ...fakeEnvironment(fake), RVW_WATCH_AUTO_ACK_POLL_MS: "10" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output = collectJsonLines(child);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const first = await output.waitFor(
      (message) => message.type === "batch-acknowledged" && message.attempts === 1,
    );
    const failed = runState(state, "fail", ["--lease", String(first.leaseId)], {
      error: "No subagent slot accepted the lease",
      retryable: true,
    });
    expect(failed).toMatchObject({ status: "pending", attempts: 1 });
    expect(runState(state, "list")).toMatchObject({ inFlight: 0, pending: [] });

    const database = new DatabaseSync(state);
    database.exec("PRAGMA busy_timeout = 5000;");
    database
      .prepare("UPDATE batches SET next_attempt_at = ? WHERE id = ?")
      .run("2026-08-20T00:00:00.000Z", String(first.batchId));
    database.close();

    const retried = await output.waitFor(
      (message) => message.type === "batch-acknowledged" && message.attempts === 2,
    );
    expect(retried).toMatchObject({
      batchId: first.batchId,
      operations: [expect.objectContaining({ acknowledgement: "restored" })],
    });

    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(code, stderr).toBe(0);
  });
});
