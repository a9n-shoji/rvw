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
const driverScript = path.join(scripts, "watch-driver.mjs");

interface FakeRvwCall {
  args: string[];
  input: unknown;
}

function readFakeCalls(log: string): FakeRvwCall[] {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown as FakeRvwCall);
}

function runState(
  state: string,
  command: string,
  args: string[] = [],
  input?: unknown,
  env?: NodeJS.ProcessEnv,
) {
  const result = spawnSync(process.execPath, [stateScript, command, "--state", state, ...args], {
    encoding: "utf8",
    ...(env === undefined ? {} : { env }),
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
    "agent.transport", "comment.watch", "comment.watchOwnership", "comment.read", "comment.reply",
    "comment.edit", "comment.codeReferences", "pullRequest.sync"
  ] });
} else if (args[0] === "agent" && args[1] === "status") {
  json({ ok: true, connected: true, selectedTransport: "agent-socket" });
} else if (args[0] === "agent" && args[1] === "ping") {
  json({ ok: true, connected: true, selectedTransport: "agent-socket" });
} else if (args[0] === "comment" && args[1] === "watch-task") {
  const taskIndex = args.indexOf("--task-id");
  const generationIndex = args.indexOf("--generation");
  const priorVerifications = priorCalls.filter(
    (call) => call.args[0] === "comment" && call.args[1] === "watch-task" && call.args[2] === "verify"
  ).length;
  if (args[2] === "verify" && Number(process.env.FAKE_RVW_VERIFY_LIMIT ?? "999999") <= priorVerifications) {
    json({ ok: false, error: { code: "WATCH_TASK_SUPERSEDED", message: "superseded" } }, 2);
  } else json({
    ok: true,
    databaseId: "0123456789abcdef0123456789abcdef",
    taskId: args[taskIndex + 1],
    generation: generationIndex < 0 ? 1 : Number(args[generationIndex + 1]),
    status: args[2] === "activate" ? "activated" : "active"
  });
} else if (args[0] === "comment" && args[1] === "get") {
  const gone = JSON.parse(process.env.FAKE_RVW_GONE_REFS ?? "[]");
  const resolved = JSON.parse(process.env.FAKE_RVW_RESOLVED_REFS ?? "[]");
  if (gone.includes(args[2])) {
    json({ ok: false, error: { code: "COMMENT_NOT_FOUND", message: "gone" } }, 2);
  } else {
    json({ ok: true, pullRequest: { url: "https://github.com/acme/repo/pull/1" }, comment: { ref: args[2], resolved: resolved.includes(args[2]), posts: [] } });
  }
} else if (args[0] === "comment" && args[1] === "reply") {
  if (process.env.FAKE_RVW_REPLY_NON_ACTIONABLE === "1") {
    json({ ok: false, error: { code: "COMMENT_NOT_ACTIONABLE", message: "resolved" } }, 2);
  } else {
  const priorReplies = priorCalls.filter((call) => call.args[0] === "comment" && call.args[1] === "reply");
  const replayIndex = priorReplies.findIndex(
    (call) => call.input?.idempotencyKey === parsedInput?.idempotencyKey
  );
  const replyNumber = replayIndex >= 0 ? replayIndex + 1 : priorReplies.length + 1;
  json({ ok: true, post: { id: "status-post-" + replyNumber, body: parsedInput.body } });
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

function activateState(state: string, fake: { script: string; log: string }) {
  const result = spawnSync(process.execPath, [stateScript, "activate", "--state", state], {
    encoding: "utf8",
    env: fakeEnvironment(fake),
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

function initializeQueuedState(state: string, fake: { script: string; log: string }) {
  runState(state, "init");
  activateState(state, fake);
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
    initializeQueuedState(state, fake);

    const result = spawnSync(
      process.execPath,
      [
        autoAckScript,
        "--state",
        state,
        "--pull-request",
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
        "--pull-request",
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

  it("completes resolved and gone historical operations without acknowledgement or dispatch", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-auto-ack-skipped-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    const pullRequest = "https://github.com/acme/repo/pull/1";
    const resolvedRef = "rvw://comment/resolved-comment";
    const goneRef = "rvw://comment/gone-comment";
    runState(state, "init");
    activateState(state, fake);
    runState(state, "ingest", [], {
      type: "ready",
      databaseId: "0123456789abcdef0123456789abcdef",
      cursor: "cursor-0",
      anchoredAtCurrent: false,
    });
    for (const [sequence, commentRef] of [resolvedRef, goneRef].entries()) {
      runState(state, "ingest", [], {
        type: "comment-posted",
        cursor: `cursor-${sequence + 1}`,
        event: {
          sequence: sequence + 1,
          postId: `historical-post-${sequence + 1}`,
          commentRef,
          pullRequestUrl: pullRequest,
          createdAt: "2026-08-20T00:00:00.000Z",
          deleted: false,
        },
      });
    }

    const result = spawnSync(
      process.execPath,
      [autoAckScript, "--state", state, "--pull-request", pullRequest],
      {
        encoding: "utf8",
        env: {
          ...fakeEnvironment(fake),
          FAKE_RVW_RESOLVED_REFS: JSON.stringify([resolvedRef]),
          FAKE_RVW_GONE_REFS: JSON.stringify([goneRef]),
        },
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      type: "skipped",
      events: [],
      operations: [],
      skippedOperations: [
        { commentRef: goneRef, status: "skipped", skipReason: "gone" },
        { commentRef: resolvedRef, status: "skipped", skipReason: "resolved" },
      ],
    });
    expect(runState(state, "list")).toMatchObject({ inFlight: 0, pending: [] });
    expect(runState(state, "status")).toMatchObject({
      batches: { completed: 1, inFlight: 0, unbatchedEvents: 0 },
    });
    expect(
      readFakeCalls(fake.log).filter((call) => ["reply", "edit"].includes(call.args[1]!)),
    ).toEqual([]);
  });

  it("acknowledges only the unresolved operation in a mixed historical batch", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-auto-ack-mixed-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    const pullRequest = "https://github.com/acme/repo/pull/1";
    const resolvedRef = "rvw://comment/comment-a-resolved";
    const unresolvedRef = "rvw://comment/comment-b-unresolved";
    runState(state, "init");
    activateState(state, fake);
    runState(state, "ingest", [], {
      type: "ready",
      databaseId: "0123456789abcdef0123456789abcdef",
      cursor: "cursor-0",
      anchoredAtCurrent: false,
    });
    for (const [sequence, commentRef] of [resolvedRef, unresolvedRef].entries()) {
      runState(state, "ingest", [], {
        type: "comment-posted",
        cursor: `cursor-${sequence + 1}`,
        event: {
          sequence: sequence + 1,
          postId: `historical-post-${sequence + 1}`,
          commentRef,
          pullRequestUrl: pullRequest,
          createdAt: "2026-08-20T00:00:00.000Z",
          deleted: false,
        },
      });
    }

    const result = spawnSync(
      process.execPath,
      [autoAckScript, "--state", state, "--pull-request", pullRequest],
      {
        encoding: "utf8",
        env: {
          ...fakeEnvironment(fake),
          FAKE_RVW_RESOLVED_REFS: JSON.stringify([resolvedRef]),
        },
      },
    );

    expect(result.status).toBe(0);
    const acknowledged = JSON.parse(result.stdout) as {
      leaseId: string;
      events: Array<{ commentRef: string }>;
    };
    expect(acknowledged).toMatchObject({
      ok: true,
      type: "acknowledged",
      operations: [{ commentRef: unresolvedRef, acknowledgement: "created" }],
      skippedOperations: [{ commentRef: resolvedRef, status: "skipped", skipReason: "resolved" }],
    });
    expect(acknowledged.events.map((event) => event.commentRef)).toEqual([unresolvedRef]);
    const replyCalls = readFakeCalls(fake.log).filter((call) => call.args[1] === "reply");
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]?.args[2]).toBe(unresolvedRef);
    runState(state, "complete", ["--lease", acknowledged.leaseId], { postIds: [] });
    expect(runState(state, "list")).toMatchObject({ pending: [] });
  });

  it("turns a resolve race at the fenced acknowledgement write into a durable skip", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-auto-ack-resolve-race-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeQueuedState(state, fake);

    const result = spawnSync(
      process.execPath,
      [autoAckScript, "--state", state, "--pull-request", "https://github.com/acme/repo/pull/1"],
      {
        encoding: "utf8",
        env: { ...fakeEnvironment(fake), FAKE_RVW_REPLY_NON_ACTIONABLE: "1" },
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: "skipped",
      operations: [],
      skippedOperations: [{ skipReason: "resolved", acknowledgement: "skipped" }],
    });
    expect(runState(state, "list")).toMatchObject({ inFlight: 0, pending: [] });
  });

  it("pins the acknowledgement author before reply and rejects a changed or omitted restart label", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-auto-ack-author-recovery-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeQueuedState(state, fake);
    const pullRequest = "https://github.com/acme/repo/pull/1";
    const claimed = runState(
      state,
      "claim",
      ["--pull-request", pullRequest, "--author-label", "Codex"],
      undefined,
      fakeEnvironment(fake),
    ) as {
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

    const mismatchedRestart = spawnSync(
      process.execPath,
      [
        autoAckScript,
        "--state",
        state,
        "--pull-request",
        pullRequest,
        "--author-label",
        "Claude Code",
      ],
      { encoding: "utf8", env: fakeEnvironment(fake) },
    );
    expect(mismatchedRestart.status).toBe(1);
    expect(JSON.parse(mismatchedRestart.stdout)).toMatchObject({
      ok: false,
      error: "watch-state claim failed",
    });
    expect(
      readFakeCalls(fake.log).filter((call) => ["get", "reply", "edit"].includes(call.args[1]!)),
    ).toHaveLength(1);

    const unlabeledRestart = spawnSync(
      process.execPath,
      [autoAckScript, "--state", state, "--pull-request", pullRequest],
      { encoding: "utf8", env: fakeEnvironment(fake) },
    );
    expect(unlabeledRestart.status).toBe(1);
    expect(JSON.parse(unlabeledRestart.stdout)).toMatchObject({
      ok: false,
      error: "watch-state claim failed",
    });
    expect(
      readFakeCalls(fake.log).filter((call) => ["get", "reply", "edit"].includes(call.args[1]!)),
    ).toHaveLength(1);

    const resumed = spawnSync(
      process.execPath,
      [autoAckScript, "--state", state, "--pull-request", pullRequest, "--author-label", "Codex"],
      { encoding: "utf8", env: fakeEnvironment(fake) },
    );
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      ok: true,
      attempts: 2,
      operations: [
        {
          statusPostId: "status-post-1",
          acknowledgement: "created",
        },
      ],
    });
    const replyCalls = readFakeCalls(fake.log).filter(
      (call) => call.args[0] === "comment" && call.args[1] === "reply",
    );
    expect(replyCalls).toHaveLength(2);
    expect(replyCalls[1]?.input).toMatchObject(replyCalls[0]?.input as Record<string, unknown>);
    expect(replyCalls[1]?.input).toMatchObject({
      watchTask: { generation: 1 },
    });
  });

  it("rejects a changed author label before an empty watcher starts", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-watch-driver-author-startup-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeQueuedState(state, fake);
    const claimed = runState(
      state,
      "claim",
      ["--pull-request", "https://github.com/acme/repo/pull/1", "--author-label", "Codex"],
      undefined,
      fakeEnvironment(fake),
    ) as { leaseId: string };
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
    expect(
      readFakeCalls(fake.log).some((call) =>
        ["watch", "get", "reply", "edit"].includes(call.args[1]!),
      ),
    ).toBe(false);
  });

  it("stops a live driver before claiming pending work after its generation is superseded", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-watch-superseded-live-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    runState(state, "init");
    activateState(state, fake);

    const result = spawnSync(process.execPath, [driverScript, state, "--auto-ack"], {
      encoding: "utf8",
      env: { ...fakeEnvironment(fake), FAKE_RVW_VERIFY_LIMIT: "4" },
    });

    expect(result.status).toBe(22);
    expect(result.stderr).toContain("watch-state verify failed");
    expect(
      readFakeCalls(fake.log).some(
        (call) => call.args[0] === "comment" && call.args[1] === "watch",
      ),
    ).toBe(true);
    expect(
      readFakeCalls(fake.log).some((call) => ["get", "reply", "edit"].includes(call.args[1]!)),
    ).toBe(false);
    expect(runState(state, "status")).toMatchObject({
      cursor: "cursor-1",
      batches: { inFlight: 0, unbatchedEvents: 1 },
    });
  });

  it("drives RFC 7464 intake and auto-ack without an Agent shell round trip", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-watch-driver-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    runState(state, "init");
    activateState(state, fake);
    const child = spawn(
      process.execPath,
      [driverScript, state, "--auto-ack", "--author-label", "Codex"],
      {
        env: fakeEnvironment(fake),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
        expect.objectContaining({
          type: "watch-ready",
          cursor: "cursor-0",
          autoAck: true,
          authorLabel: "Codex",
        }),
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
    const replyCall = readFakeCalls(fake.log).find(
      (call) => call.args[0] === "comment" && call.args[1] === "reply",
    );
    expect(replyCall?.input).toMatchObject({ authorLabel: "Codex" });
  });

  it("acknowledges a durably ingested event before resuming its cursor", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-watch-driver-recover-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    initializeQueuedState(state, fake);
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

  it("allows only one driver process to own a task state", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-watch-driver-owner-"));
    const fake = createFakeRvw(directory);
    const state = path.join(directory, "task.db");
    runState(state, "init");
    activateState(state, fake);
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
    activateState(state, fake);
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
      [driverScript, state, "--auto-ack", "--max-in-flight", "1", "--author-label", "Codex"],
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
    initializeQueuedState(state, fake);
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
    initializeQueuedState(state, fake);
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
    const editCall = readFakeCalls(fake.log).find(
      (call) => call.args[0] === "comment" && call.args[1] === "edit",
    );
    expect(editCall?.input).toMatchObject({
      body: "🔎 確認中です…",
      relatedCommitOid: null,
      watchTask: { generation: 1 },
    });

    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(code, stderr).toBe(0);
  });
});
