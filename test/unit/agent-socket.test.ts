import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RvwService } from "../../src/application/rvw-service.js";
import {
  dispatchAgentSocketRequest,
  inspectAgentTransport,
  startAgentSocket,
  tryAgentSocketRequest,
} from "../../src/server/agent-socket.js";

async function waitForChildMessage<T>(
  child: ChildProcess,
  predicate: (message: unknown) => message is T,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Agent socket child response timed out"));
    }, 2_000);
    const onMessage = (message: unknown): void => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Agent socket child exited: ${String(code)}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

interface ChildState {
  type: "ready" | "status" | "unsupported";
  requestId?: number;
  owned: boolean;
  pid: number;
}

function childState(message: unknown): message is ChildState {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Record<string, unknown>;
  return (
    (candidate.type === "ready" ||
      candidate.type === "status" ||
      candidate.type === "unsupported") &&
    (candidate.type === "unsupported" || typeof candidate.owned === "boolean") &&
    typeof candidate.pid === "number"
  );
}

function sendChildMessage(child: ChildProcess, message: Parameters<ChildProcess["send"]>[0]): void {
  if (!child.connected || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.send(message, () => {
      // The child may exit between the liveness check and IPC delivery.
    });
  } catch {
    // Cleanup is already complete when the IPC channel has closed.
  }
}

describe("Agent socket", () => {
  const originalSocketPath = process.env.RVW_AGENT_SOCKET_PATH;

  afterEach(() => {
    if (originalSocketPath === undefined) delete process.env.RVW_AGENT_SOCKET_PATH;
    else process.env.RVW_AGENT_SOCKET_PATH = originalSocketPath;
  });

  it("routes an Agent write through the running rvw service", async () => {
    const setCommentResolved = vi.fn().mockReturnValue({ id: "comment-1", resolved: true });
    const result = await dispatchAgentSocketRequest(
      { setCommentResolved } as unknown as RvwService,
      {
        protocolVersion: 1,
        operation: "comment.resolve",
        input: { uri: "rvw://comment/10000000-0000-4000-8000-000000000001" },
      },
    );

    expect(result).toEqual({ id: "comment-1", resolved: true });
    expect(setCommentResolved).toHaveBeenCalledWith(
      "rvw://comment/10000000-0000-4000-8000-000000000001",
      true,
    );
  });

  it("routes strict comment creation through the running rvw service", async () => {
    const createCommentForReference = vi
      .fn()
      .mockResolvedValue({ ref: "rvw://comment/10000000-0000-4000-8000-000000000008" });
    const input = {
      pullRequest: "https://github.com/acme/review-repo/pull/7",
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: "a".repeat(40),
        path: "src/example.ts",
        startLine: 2,
        endLine: 3,
      },
      body: "The caller cannot observe this failure.",
      authorLabel: "Codex",
    };

    await expect(
      dispatchAgentSocketRequest({ createCommentForReference } as unknown as RvwService, {
        protocolVersion: 1,
        operation: "comment.create",
        input,
      }),
    ).resolves.toEqual({
      ref: "rvw://comment/10000000-0000-4000-8000-000000000008",
    });
    expect(createCommentForReference).toHaveBeenCalledWith(input);

    await expect(
      dispatchAgentSocketRequest({ createCommentForReference } as unknown as RvwService, {
        protocolVersion: 1,
        operation: "comment.create",
        input: {
          ...input,
          target: { ...input.target, endLine: null },
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(createCommentForReference).toHaveBeenCalledOnce();
  });

  it("routes a strict comment post edit through the running rvw service", async () => {
    const editCommentPost = vi.fn().mockResolvedValue({ id: "post-1", body: "✅ Done" });
    const input = {
      uri: "rvw://comment/10000000-0000-4000-8000-000000000008",
      postId: "post-1",
      edit: { body: "✅ Done", relatedCommitOid: "a".repeat(40) },
    };

    await expect(
      dispatchAgentSocketRequest({ editCommentPost } as unknown as RvwService, {
        protocolVersion: 1,
        operation: "comment.edit",
        input,
      }),
    ).resolves.toEqual({ id: "post-1", body: "✅ Done" });
    expect(editCommentPost).toHaveBeenCalledWith(input.uri, input.postId, input.edit);
  });

  it("preserves the enumerable Walkthrough mutation envelope through JSON transport", async () => {
    const publishResult = {
      walkthrough: {
        id: "walkthrough-branch",
        ref: "rvw://walkthrough/70000000-0000-4000-8000-000000000001",
        branchReviewId: "branch-review-1",
      },
      issuesAdded: [{ id: "issue-142", number: 142 }],
    };
    const updateResult = {
      walkthrough: {
        id: "walkthrough-pr",
        ref: "rvw://walkthrough/70000000-0000-4000-8000-000000000002",
        pullRequestId: "pull-request-1",
      },
      issuesAdded: [],
    };
    const publishWalkthrough = vi.fn().mockResolvedValue(publishResult);
    const updateWalkthrough = vi.fn().mockResolvedValue(updateResult);
    const service = { publishWalkthrough, updateWalkthrough } as unknown as RvwService;
    const content = {
      sourceOid: "a".repeat(40),
      title: "Transport parity",
      body: "Read [the source](rvw-ref:source).",
      references: [
        {
          id: "source",
          label: "Source",
          path: "README.md",
          startLine: 1,
          endLine: 1,
          description: null,
        },
      ],
    };

    const published = await dispatchAgentSocketRequest(service, {
      protocolVersion: 1,
      operation: "walkthrough.publish",
      input: { review: { kind: "branch", repository: "acme/review-repo" }, ...content },
    });
    const updated = await dispatchAgentSocketRequest(service, {
      protocolVersion: 1,
      operation: "walkthrough.update",
      input: { uri: updateResult.walkthrough.ref, content },
    });

    expect(JSON.parse(JSON.stringify(published))).toEqual(publishResult);
    expect(JSON.parse(JSON.stringify(updated))).toEqual(updateResult);
    expect(publishWalkthrough).toHaveBeenCalledOnce();
    expect(updateWalkthrough).toHaveBeenCalledOnce();
  });

  it("rejects a different explicit database before dispatching the operation", async () => {
    const setCommentResolved = vi.fn();

    await expect(
      dispatchAgentSocketRequest(
        {
          database: { filePath: "/data/default.db" },
          setCommentResolved,
        } as unknown as RvwService,
        {
          protocolVersion: 1,
          operation: "comment.resolve",
          input: { uri: "rvw://comment/10000000-0000-4000-8000-000000000003" },
          expectedDatabasePath: "/data/other.db",
        },
      ),
    ).rejects.toMatchObject({
      code: "DATABASE_ERROR",
      details: { agentSocketDatabaseMismatch: true },
    });
    expect(setCommentResolved).not.toHaveBeenCalled();
  });

  it("requires server-side confirmation for destructive operations", async () => {
    const resetPullRequest = vi.fn();
    const resetBranchReview = vi.fn();
    const removePullRequestIssue = vi.fn();
    const removeBranchIssue = vi.fn();
    const deleteWalkthroughByUri = vi.fn();
    const service = {
      resolveStoredPullRequest: vi.fn().mockReturnValue({ id: "pr-1" }),
      resetPullRequest,
      resetBranchReview,
      removePullRequestIssue,
      removeBranchIssue,
      deleteWalkthroughByUri,
    } as unknown as RvwService;

    await expect(
      dispatchAgentSocketRequest(service, {
        protocolVersion: 1,
        operation: "pr.reset",
        input: { reference: "1" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      dispatchAgentSocketRequest(service, {
        protocolVersion: 1,
        operation: "pr.issue.remove",
        input: { reference: "1", issueReference: "#142" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      dispatchAgentSocketRequest(service, {
        protocolVersion: 1,
        operation: "branch.issue.remove",
        input: { repositoryPath: "/repo", issueReference: "#142" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      dispatchAgentSocketRequest(service, {
        protocolVersion: 1,
        operation: "branch.reset",
        input: { repositoryPath: "/repo" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      dispatchAgentSocketRequest(service, {
        protocolVersion: 1,
        operation: "walkthrough.delete",
        input: { uri: "rvw://walkthrough/10000000-0000-4000-8000-000000000001" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(resetPullRequest).not.toHaveBeenCalled();
    expect(resetBranchReview).not.toHaveBeenCalled();
    expect(removePullRequestIssue).not.toHaveBeenCalled();
    expect(removeBranchIssue).not.toHaveBeenCalled();
    expect(deleteWalkthroughByUri).not.toHaveBeenCalled();
  });

  it("rejects inherited object property names as unsupported operations", async () => {
    await expect(
      dispatchAgentSocketRequest({} as RvwService, {
        protocolVersion: 1,
        operation: "toString",
        input: {},
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("round-trips a request over a user-owned Unix socket when the environment permits it", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-agent-socket-"));
    process.env.RVW_AGENT_SOCKET_PATH = path.join(directory, "agent.sock");
    const setCommentResolved = vi.fn().mockReturnValue({ id: "comment-2", resolved: true });
    let running: Awaited<ReturnType<typeof startAgentSocket>>;
    try {
      running = await startAgentSocket({
        database: { filePath: "/data/default.db" },
        setCommentResolved,
      } as unknown as RvwService);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    try {
      await expect(
        tryAgentSocketRequest("comment.resolve", {
          uri: "rvw://comment/10000000-0000-4000-8000-000000000002",
        }),
      ).resolves.toEqual({
        available: true,
        result: { id: "comment-2", resolved: true },
      });
      await expect(inspectAgentTransport("/data/default.db")).resolves.toMatchObject({
        explicitSocketPath: true,
        connected: true,
        connectionResult: "connected",
        socketDatabasePath: "/data/default.db",
        socketOwnerPid: process.pid,
        selectedTransport: "agent-socket",
        selectedDatabasePath: "/data/default.db",
        fallbackReason: null,
      });
      await expect(
        tryAgentSocketRequest(
          "comment.resolve",
          { uri: "rvw://comment/10000000-0000-4000-8000-000000000004" },
          { expectedDatabasePath: "/data/other.db" },
        ),
      ).rejects.toMatchObject({
        code: "AGENT_SOCKET_UNAVAILABLE",
        details: {
          agentSocketRequired: true,
          connectionResult: "database-mismatch",
          selectedTransport: "unavailable",
          fallbackReason: null,
        },
      });
      expect(setCommentResolved).toHaveBeenCalledOnce();
    } finally {
      await running.close();
    }
  });

  it("fails closed when an explicit Agent socket path is unavailable", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-agent-explicit-missing-"));
    process.env.RVW_AGENT_SOCKET_PATH = path.join(directory, "missing.sock");

    await expect(
      tryAgentSocketRequest("ping", {}, { expectedDatabasePath: "/data/default.db" }),
    ).rejects.toMatchObject({
      code: "AGENT_SOCKET_UNAVAILABLE",
      details: {
        agentSocketRequired: true,
        socketPath: process.env.RVW_AGENT_SOCKET_PATH,
        connectionResult: "socket-not-found",
        selectedTransport: "unavailable",
        fallbackReason: null,
      },
    });
    await expect(inspectAgentTransport("/data/default.db")).resolves.toMatchObject({
      explicitSocketPath: true,
      connected: false,
      connectionResult: "socket-not-found",
      selectedTransport: "unavailable",
      selectedDatabasePath: "/data/default.db",
      fallbackReason: null,
    });
  });

  it("reports why an implicit socket falls back to the direct database", async () => {
    delete process.env.RVW_AGENT_SOCKET_PATH;
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-agent-implicit-missing-"));
    const databasePath = path.join(directory, "review.db");

    await expect(inspectAgentTransport(databasePath)).resolves.toMatchObject({
      explicitSocketPath: false,
      connected: false,
      connectionResult: "socket-not-found",
      expectedDatabasePath: databasePath,
      selectedTransport: "direct-database",
      selectedDatabasePath: databasePath,
      fallbackReason: "socket-not-found",
    });
  });

  it("keeps structured diagnostics for an unexpected connection error", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-agent-invalid-parent-"));
    const nonDirectory = path.join(directory, "not-a-directory");
    writeFileSync(nonDirectory, "fixture");
    process.env.RVW_AGENT_SOCKET_PATH = path.join(nonDirectory, "agent.sock");

    const status = await inspectAgentTransport("/data/default.db");
    expect(status).toMatchObject({
      explicitSocketPath: true,
      connected: false,
      connectionResult: "connection-error",
      selectedTransport: "unavailable",
      selectedDatabasePath: "/data/default.db",
      fallbackReason: null,
    });
    expect(typeof status.connectionDetails?.code).toBe("string");
    expect(typeof status.connectionDetails?.message).toBe("string");
    const connectionError = await tryAgentSocketRequest(
      "ping",
      {},
      {
        expectedDatabasePath: "/data/default.db",
      },
    ).catch((error: unknown) => error);
    expect(connectionError).toMatchObject({
      code: "AGENT_SOCKET_UNAVAILABLE",
      details: {
        connectionResult: "connection-error",
      },
    });
    const details = connectionError as {
      details?: { causeDetails?: { code?: unknown } };
    };
    expect(typeof details.details?.causeDetails?.code).toBe("string");
  });

  it("isolates a database-specific socket inside a private user directory", async () => {
    delete process.env.RVW_AGENT_SOCKET_PATH;
    const databaseDirectory = mkdtempSync(path.join(os.tmpdir(), "rvw-agent-database-"));
    const databasePath = path.join(databaseDirectory, "review.db");
    const setCommentResolved = vi.fn().mockReturnValue({ id: "private-socket" });
    let running: Awaited<ReturnType<typeof startAgentSocket>>;
    try {
      running = await startAgentSocket({
        database: { filePath: databasePath },
        setCommentResolved,
      } as unknown as RvwService);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    try {
      expect(statSync(path.dirname(running.path)).mode & 0o777).toBe(0o700);
      expect(statSync(running.path).mode & 0o777).toBe(0o600);
      await expect(
        tryAgentSocketRequest(
          "comment.resolve",
          { uri: "rvw://comment/10000000-0000-4000-8000-000000000007" },
          { expectedDatabasePath: databasePath },
        ),
      ).resolves.toEqual({ available: true, result: { id: "private-socket" } });
    } finally {
      await running.close();
    }
  });

  it("rejects an explicit socket path in a non-private directory", async () => {
    if (process.platform === "win32" || process.getuid === undefined) return;
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-agent-insecure-"));
    chmodSync(directory, 0o755);
    process.env.RVW_AGENT_SOCKET_PATH = path.join(directory, "agent.sock");

    await expect(
      startAgentSocket({ database: { filePath: "/data/default.db" } } as unknown as RvwService),
    ).rejects.toMatchObject({
      code: "DATABASE_ERROR",
      details: {
        path: directory,
        mode: "0755",
        expectedMode: "0700",
        owner: process.getuid(),
        expectedOwner: process.getuid(),
      },
    });
  });

  it("does not turn a post-send timeout into a retryable unavailable result", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-agent-slow-"));
    process.env.RVW_AGENT_SOCKET_PATH = path.join(directory, "agent.sock");
    const setCommentResolved = vi
      .fn()
      .mockImplementation(
        async () =>
          await new Promise((resolve) =>
            setTimeout(() => resolve({ id: "comment-slow", resolved: true }), 50),
          ),
      );
    let running: Awaited<ReturnType<typeof startAgentSocket>>;
    try {
      running = await startAgentSocket({
        database: { filePath: "/data/default.db" },
        setCommentResolved,
      } as unknown as RvwService);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    try {
      await expect(
        tryAgentSocketRequest(
          "comment.resolve",
          { uri: "rvw://comment/10000000-0000-4000-8000-000000000005" },
          { operationTimeoutMs: 10 },
        ),
      ).rejects.toMatchObject({
        code: "PROCESS_TIMEOUT",
        details: { agentSocketOutcomeUncertain: true, operation: "comment.resolve" },
      });
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(setCommentResolved).toHaveBeenCalledOnce();
    } finally {
      await running.close();
    }
  });

  it("accepts valid batched input larger than the former one MiB frame", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-agent-large-"));
    process.env.RVW_AGENT_SOCKET_PATH = path.join(directory, "agent.sock");
    const syncPullRequest = vi.fn().mockImplementation((input: { commentUpdates: unknown[] }) => ({
      updates: input.commentUpdates.length,
    }));
    let running: Awaited<ReturnType<typeof startAgentSocket>>;
    try {
      running = await startAgentSocket({
        database: { filePath: "/data/default.db" },
        syncPullRequest,
      } as unknown as RvwService);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const commentUpdates = Array.from({ length: 20 }, (_, index) => ({
      commentRef: `rvw://comment/10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      reply: "x".repeat(60_000),
      resolve: false,
    }));

    try {
      await expect(
        tryAgentSocketRequest("pr.sync", {
          pullRequest: "https://github.com/openai/rvw/pull/1",
          commentUpdates,
          allowUntracked: false,
        }),
      ).resolves.toEqual({ available: true, result: { updates: 20 } });
      expect(syncPullRequest).toHaveBeenCalledOnce();
    } finally {
      await running.close();
    }
  });

  it("lets a follower viewer take over the socket after the owner closes", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-agent-takeover-"));
    process.env.RVW_AGENT_SOCKET_PATH = path.join(directory, "agent.sock");
    const firstService = {
      database: { filePath: "/data/default.db" },
      setCommentResolved: vi.fn().mockReturnValue({ owner: "first" }),
    } as unknown as RvwService;
    const secondService = {
      database: { filePath: "/data/default.db" },
      setCommentResolved: vi.fn().mockReturnValue({ owner: "second" }),
    } as unknown as RvwService;
    let running: Array<Awaited<ReturnType<typeof startAgentSocket>>>;
    try {
      running = await Promise.all([
        startAgentSocket(firstService, { takeoverRetryMs: 20 }),
        startAgentSocket(secondService, { takeoverRetryMs: 20 }),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const ownerIndex = running.findIndex((candidate) => candidate.owned);
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
    expect(running.filter((candidate) => candidate.owned)).toHaveLength(1);
    expect(statSync(`${running[ownerIndex]!.path}.owner`).mode & 0o777).toBe(0o600);
    const followerIndex = ownerIndex === 0 ? 1 : 0;

    try {
      await running[ownerIndex]!.close();
      const deadline = Date.now() + 1_000;
      while (!running[followerIndex]!.owned && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(running[followerIndex]!.owned).toBe(true);
      await expect(
        tryAgentSocketRequest("comment.resolve", {
          uri: "rvw://comment/10000000-0000-4000-8000-000000000006",
        }),
      ).resolves.toEqual({
        available: true,
        result: { owner: followerIndex === 0 ? "first" : "second" },
      });
    } finally {
      await Promise.all(running.map(async (candidate) => await candidate.close()));
      expect(existsSync(`${process.env.RVW_AGENT_SOCKET_PATH}.owner`)).toBe(false);
    }
  });

  it("keeps exactly one socket owner across separate Node processes", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-agent-multiprocess-"));
    const socketPath = path.join(directory, "agent.sock");
    process.env.RVW_AGENT_SOCKET_PATH = socketPath;
    const fixture = path.resolve("test/fixtures/agent-socket-process.ts");
    const children = [
      fork(fixture, ["/data/default.db"], {
        execArgv: ["--import", "tsx"],
        env: { ...process.env, RVW_AGENT_SOCKET_PATH: socketPath },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      }),
      fork(fixture, ["/data/default.db"], {
        execArgv: ["--import", "tsx"],
        env: { ...process.env, RVW_AGENT_SOCKET_PATH: socketPath },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      }),
    ];

    try {
      const ready = await Promise.all(
        children.map(async (child) => await waitForChildMessage(child, childState)),
      );
      if (ready.some((state) => state.type === "unsupported")) return;
      expect(ready.filter((state) => state.owned)).toHaveLength(1);
      const ownerIndex = ready.findIndex((state) => state.owned);
      const followerIndex = ownerIndex === 0 ? 1 : 0;
      sendChildMessage(children[ownerIndex]!, { type: "close" });
      await new Promise<void>((resolve) => {
        if (children[ownerIndex]!.exitCode !== null) resolve();
        else children[ownerIndex]!.once("exit", () => resolve());
      });

      let followerOwned = false;
      for (let requestId = 1; requestId <= 50 && !followerOwned; requestId += 1) {
        sendChildMessage(children[followerIndex]!, { type: "status", requestId });
        const status = await waitForChildMessage(
          children[followerIndex]!,
          (message): message is ChildState =>
            childState(message) && message.type === "status" && message.requestId === requestId,
        );
        followerOwned = Boolean(status?.owned);
        if (!followerOwned) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(followerOwned).toBe(true);
      expect(existsSync(`${socketPath}.owner`)).toBe(true);
    } finally {
      for (const child of children) {
        sendChildMessage(child, { type: "close" });
      }
      await Promise.all(
        children.map(
          async (child) =>
            await new Promise<void>((resolve) => {
              if (child.exitCode !== null) resolve();
              else child.once("exit", () => resolve());
            }),
        ),
      );
      expect(existsSync(`${socketPath}.owner`)).toBe(false);
    }
  });
});
