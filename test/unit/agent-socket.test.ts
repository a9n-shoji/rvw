import { chmodSync, mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RvwService } from "../../src/application/rvw-service.js";
import {
  dispatchAgentSocketRequest,
  startAgentSocket,
  tryAgentSocketRequest,
} from "../../src/server/agent-socket.js";

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
    const deleteWalkthroughByUri = vi.fn();
    const service = {
      resolveStoredPullRequest: vi.fn().mockReturnValue({ id: "pr-1" }),
      resetPullRequest,
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
        operation: "walkthrough.delete",
        input: { uri: "rvw://walkthrough/10000000-0000-4000-8000-000000000001" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(resetPullRequest).not.toHaveBeenCalled();
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
      await expect(
        tryAgentSocketRequest(
          "comment.resolve",
          { uri: "rvw://comment/10000000-0000-4000-8000-000000000004" },
          { expectedDatabasePath: "/data/other.db" },
        ),
      ).resolves.toEqual({ available: false });
      expect(setCommentResolved).toHaveBeenCalledOnce();
    } finally {
      await running.close();
    }
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
    }
  });
});
