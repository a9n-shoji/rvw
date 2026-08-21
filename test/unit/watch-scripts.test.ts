import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scripts = path.resolve("skills/rvw-watch-comments/scripts");
const stateScript = path.join(scripts, "watch-state.mjs");
const preflightScript = path.join(scripts, "preflight.mjs");
const autoAckScript = path.join(scripts, "auto-ack.mjs");
const completeBranchScript = path.join(scripts, "complete-branch.mjs");
const driverScript = path.join(scripts, "watch-driver.mjs");

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
  const result = spawnSync(process.execPath, [stateScript, command, "--state", state, ...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
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
    "comment.edit", "comment.codeReferences", "pullRequest.sync", "branchReview.read"
  ] });
} else if (args[0] === "agent" && args[1] === "status") {
  json({ ok: true, connected: true, selectedTransport: "agent-socket" });
} else if (args[0] === "agent" && args[1] === "ping") {
  json({ ok: true, connected: true, selectedTransport: "agent-socket" });
} else if (args[0] === "comment" && args[1] === "get") {
  json({ ok: true, pullRequest: { url: "https://github.com/acme/repo/pull/1" }, comment: { ref: args[2], posts: [] } });
} else if (args[0] === "comment" && args[1] === "reply") {
  const priorReplyIndex = priorCalls.findIndex((call) =>
    call.args[0] === "comment" && call.args[1] === "reply" &&
    call.input?.idempotencyKey === parsedInput.idempotencyKey
  );
  const replyCount = priorReplyIndex >= 0
    ? priorCalls.slice(0, priorReplyIndex + 1).filter((call) => call.args[0] === "comment" && call.args[1] === "reply").length
    : priorCalls.filter((call) => call.args[0] === "comment" && call.args[1] === "reply").length + 1;
  json({ ok: true, post: { id: "status-post-" + replyCount, body: parsedInput.body } });
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
        pullRequestUrl: "https://github.com/acme/repo/pull/1",
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

function fakeEnvironment(fake: { script: string; log: string }) {
  return {
    ...process.env,
    RVW_BIN: process.execPath,
    RVW_BIN_ARGS_JSON: JSON.stringify([fake.script]),
    FAKE_RVW_LOG: fake.log,
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

function initializeBranchQueuedState(state: string) {
  runState(state, "init", ["--own-mode", "fix-and-push"]);
  runState(state, "ingest", [], {
    type: "ready",
    databaseId: "fedcba9876543210fedcba9876543210",
    cursor: "cursor-0",
    anchoredAtCurrent: true,
  });
  runState(state, "ingest", [], {
    type: "comment-posted",
    cursor: "cursor-1",
    event: {
      sequence: 1,
      postId: "branch-human-post",
      commentRef: "rvw://comment/branch-comment",
      context: { kind: "branch", repository: "acme/repo" },
      createdAt: "2026-08-20T00:00:00.000Z",
      deleted: false,
    },
  });
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
      [autoAckScript, "--state", state, "--pull-request", "https://github.com/acme/repo/pull/1"],
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
    expect(replyCall?.input).toMatchObject({ body: "🔎 確認中です…" });
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
      [autoAckScript, "--state", state, "--pull-request", "https://github.com/acme/repo/pull/1"],
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

  it("posts one Branch final reply and durably suppresses its later event", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-branch-complete-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeBranchQueuedState(state);
    const claimed = runState(state, "claim", [
      "--context-kind",
      "branch",
      "--context-key",
      "acme/repo",
    ]);
    const input = {
      leaseId: claimed.leaseId,
      context: { kind: "branch", repository: "acme/repo" },
      outcomes: [
        {
          commentRef: "rvw://comment/branch-comment",
          body: "📝 調査結果\n\nThe Branch review is complete.",
          relatedCommitOid: null,
          pushStatus: "not-attempted",
        },
      ],
    };
    const completed = spawnSync(
      process.execPath,
      [completeBranchScript, "--state", state, "--lease", String(claimed.leaseId)],
      { encoding: "utf8", env: fakeEnvironment(fake), input: JSON.stringify(input) },
    );

    expect(completed.status, completed.stderr).toBe(0);
    const result = JSON.parse(completed.stdout) as {
      replies: Array<{ idempotencyKey: string; postId: string }>;
    };
    expect(result).toMatchObject({
      type: "branch-completed",
      context: { kind: "branch", repository: "acme/repo" },
      replies: [{ postId: "status-post-1" }],
    });
    expect(result.replies[0]?.idempotencyKey).toBe(
      (claimed.operations as Array<{ idempotencyKey: string }>)[0]?.idempotencyKey,
    );
    expect(runState(state, "list")).toMatchObject({ pending: [] });
    expect(
      runState(state, "ingest", [], {
        type: "comment-posted",
        cursor: "cursor-2",
        event: {
          sequence: 2,
          postId: result.replies[0]?.postId,
          commentRef: "rvw://comment/branch-comment",
          context: { kind: "branch", repository: "acme/repo" },
          createdAt: "2026-08-20T00:00:01.000Z",
          deleted: false,
        },
      }),
    ).toMatchObject({ status: "suppressed" });
  });

  it("reuses the Branch final-reply idempotency key after recovery", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-branch-restart-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeBranchQueuedState(state);
    const firstClaim = runState(state, "claim", [
      "--context-kind",
      "branch",
      "--context-key",
      "acme/repo",
    ]);
    const idempotencyKey = (firstClaim.operations as Array<{ idempotencyKey: string }>)[0]
      ?.idempotencyKey;
    const firstReply = spawnSync(
      process.execPath,
      [fake.script, "comment", "reply", "rvw://comment/branch-comment", "--stdin", "--json"],
      {
        encoding: "utf8",
        env: fakeEnvironment(fake),
        input: JSON.stringify({
          body: "📝 調査結果\n\nRecovered outcome.",
          idempotencyKey,
        }),
      },
    );
    expect(firstReply.status, firstReply.stderr).toBe(0);
    const firstPostId = (JSON.parse(firstReply.stdout) as { post: { id: string } }).post.id;

    expect(runState(state, "recover")).toMatchObject({ recovered: 1, pending: 1 });
    const recoveredClaim = runState(state, "claim", [
      "--context-kind",
      "branch",
      "--context-key",
      "acme/repo",
    ]);
    expect(
      (recoveredClaim.operations as Array<{ idempotencyKey: string }>)[0]?.idempotencyKey,
    ).toBe(idempotencyKey);
    const completed = spawnSync(
      process.execPath,
      [completeBranchScript, "--state", state, "--lease", String(recoveredClaim.leaseId)],
      {
        encoding: "utf8",
        env: fakeEnvironment(fake),
        input: JSON.stringify({
          leaseId: recoveredClaim.leaseId,
          context: { kind: "branch", repository: "acme/repo" },
          outcomes: [
            {
              commentRef: "rvw://comment/branch-comment",
              body: "📝 調査結果\n\nRecovered outcome.",
              relatedCommitOid: null,
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

  it("rejects Branch worker outcomes that claim a write", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-branch-write-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeBranchQueuedState(state);
    const claimed = runState(state, "claim", [
      "--context-kind",
      "branch",
      "--context-key",
      "acme/repo",
    ]);
    const result = spawnSync(
      process.execPath,
      [completeBranchScript, "--state", state, "--lease", String(claimed.leaseId)],
      {
        encoding: "utf8",
        env: fakeEnvironment(fake),
        input: JSON.stringify({
          outcomes: [
            {
              commentRef: "rvw://comment/branch-comment",
              body: "This must not be posted.",
              relatedCommitOid: "a".repeat(40),
              pushStatus: "pushed",
            },
          ],
        }),
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot include a related commit");
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
    const child = spawn(process.execPath, [driverScript, state, "--auto-ack"], {
      env: fakeEnvironment(fake),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const types: string[] = [];
    let buffered = "";
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("driver recovery timed out")), 5000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        const complete = buffered.split("\n");
        buffered = complete.pop() ?? "";
        for (const line of complete.filter(Boolean)) {
          const parsed = JSON.parse(line) as { type: string };
          types.push(parsed.type);
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
    expect(types.slice(0, 2)).toEqual(["batch-acknowledged", "watch-ready"]);
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
});
