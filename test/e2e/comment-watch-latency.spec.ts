import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { RvwDatabase } from "../../src/infrastructure/db/database.js";

const stateScript = path.resolve("skills/rvw-watch-comments/scripts/watch-state.mjs");
const driverScript = path.resolve("skills/rvw-watch-comments/scripts/watch-driver.mjs");
const preflightScript = path.resolve("skills/rvw-watch-comments/scripts/preflight.mjs");
const cli = path.resolve("dist/cli.mjs");
const pullRequestUrl = "https://github.com/acme/review-repo/pull/77";

function runState(state: string, command: string, args: string[] = [], input?: unknown) {
  const result = spawnSync(process.execPath, [stateScript, command, "--state", state, ...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function childEnvironment(databasePath: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.RVW_AGENT_SOCKET_PATH;
  return {
    ...environment,
    RVW_DATABASE_PATH: databasePath,
    RVW_BIN: process.execPath,
    RVW_BIN_ARGS_JSON: JSON.stringify([cli]),
  };
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
        }, 10_000);
      });
    },
  };
}

test("watch startup, auto-ack, and final replacement stay on the fast path", async () => {
  test.setTimeout(30_000);
  const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-watch-e2e-"));
  const databasePath = path.join(directory, "rvw.db");
  const state = path.join(directory, "watch-state.db");
  const database = new RvwDatabase({ filePath: databasePath, migrationsDirectory: "./migrations" });
  const headOid = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const baseOid = headOid;
  const pullRequest = database.upsertPullRequest(
    {
      host: "github.com",
      owner: "acme",
      repository: "review-repo",
      number: 77,
      url: pullRequestUrl,
      authorLogin: "review-author",
      headRepositoryOwner: "acme",
      headRepositoryName: "review-repo",
      title: "Measure comment acknowledgement latency",
      body: "Keep the watcher feedback loop short.",
      baseRefName: "main",
      baseOid,
      headRefName: "feature/watch-latency",
      headOid,
      updatedAt: "2026-08-20T00:00:00.000Z",
      state: "OPEN",
      isDraft: false,
    },
    { localRepositoryPath: process.cwd(), gitCommonDir: path.resolve(".git") },
    baseOid,
  );
  database.close();
  runState(state, "init");

  const startedAt = performance.now();
  const preflight = spawnSync(process.execPath, [preflightScript], {
    encoding: "utf8",
    env: childEnvironment(databasePath),
  });
  expect(preflight.status, preflight.stderr).toBe(0);
  expect(JSON.parse(preflight.stdout)).toMatchObject({
    ok: true,
    rvw: { protocolVersion: 2, missingCapabilities: [] },
    checks: { agentStatus: true, agentPingInspected: true },
  });
  const driver = spawn(process.execPath, [driverScript, state, "--auto-ack"], {
    env: childEnvironment(databasePath),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = collectJsonLines(driver);
  const driverExit = new Promise<number | null>((resolve) => driver.once("close", resolve));
  let stderr = "";
  driver.stderr.setEncoding("utf8");
  driver.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    await output.waitFor((message) => message.type === "watch-ready");
    const startupMs = performance.now() - startedAt;
    const postedAt = performance.now();
    const writer = new RvwDatabase({ filePath: databasePath, migrationsDirectory: "./migrations" });
    const comment = writer.createComment({
      pullRequestId: pullRequest.id,
      createdHeadOid: headOid,
      target: { kind: "pull-request" },
      body: "Please confirm that the acknowledgement is immediate.",
      authorLabel: "Reviewer",
    });
    writer.close();

    const acknowledged = await output.waitFor((message) => message.type === "batch-acknowledged");
    const acknowledgementMs = performance.now() - postedAt;
    const leaseId = String(acknowledged.leaseId);
    const operation = (
      acknowledged.operations as Array<{ commentRef: string; statusPostId: string }>
    )[0];
    expect(operation).toBeDefined();
    if (!operation) throw new Error("auto-ack did not return an operation");
    expect(operation.commentRef).toBe(comment.ref);
    const finalBody = "📝 調査結果\n\nWatcher fast path verified.";
    const edited = spawnSync(
      process.execPath,
      [
        cli,
        "comment",
        "edit",
        operation.commentRef,
        "--post",
        operation.statusPostId,
        "--stdin",
        "--json",
      ],
      {
        encoding: "utf8",
        env: childEnvironment(databasePath),
        input: JSON.stringify({ body: finalBody, relatedCommitOid: null }),
      },
    );
    expect(edited.status, edited.stderr).toBe(0);
    runState(state, "complete", ["--lease", leaseId], { postIds: [] });

    const verified = new RvwDatabase({
      filePath: databasePath,
      migrationsDirectory: "./migrations",
    });
    expect(verified.getComment(comment.id)?.posts).toMatchObject([
      { isRoot: true, body: "Please confirm that the acknowledgement is immediate." },
      { id: operation.statusPostId, isRoot: false, body: finalBody },
    ]);
    verified.close();
    expect(startupMs).toBeLessThan(5_000);
    expect(acknowledgementMs).toBeLessThan(5_000);
    console.log(
      JSON.stringify({
        latency: {
          before: { startupMs: 175_000, acknowledgementMs: 61_000 },
          after: {
            startupMs: Math.round(startupMs),
            acknowledgementMs: Math.round(acknowledgementMs),
          },
        },
      }),
    );
  } finally {
    if (driver.exitCode === null && driver.signalCode === null) driver.kill("SIGTERM");
    const exitCode = await driverExit;
    expect(exitCode, stderr).toBe(0);
  }
});
