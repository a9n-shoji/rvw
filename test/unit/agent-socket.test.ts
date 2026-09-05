import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RvwService } from "../../src/application/rvw-service.js";
import { acquireRuntimeOrReuseExisting } from "../../src/cli/main.js";
import {
  AGENT_SOCKET_PROTOCOL_VERSION,
  dispatchAgentSocketRequest,
  inspectAgentTransport,
  startAgentSocket,
  startRuntimeAgentSocket,
  tryAgentSocketRequest,
  tryRuntimeViewerOpen,
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
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
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

  it("routes comment watch activation and verification through the shared service", async () => {
    const taskId = "11111111-1111-4111-8111-111111111111";
    const leaseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const activateCommentWatchTask = vi.fn().mockReturnValue({ taskId, generation: 1 });
    const verifyCommentWatchTask = vi.fn().mockReturnValue({ taskId, generation: 1 });
    const reserveCommentWatchWriter = vi.fn().mockReturnValue({
      taskId,
      generation: 1,
      leaseId,
      writeKey: "acme/repo",
      status: "reserved",
    });
    const releaseCommentWatchWriter = vi.fn().mockReturnValue({
      taskId,
      generation: 1,
      leaseId,
      writeKey: "acme/repo",
      status: "released",
    });
    const service = {
      activateCommentWatchTask,
      verifyCommentWatchTask,
      reserveCommentWatchWriter,
      releaseCommentWatchWriter,
    } as unknown as RvwService;

    await expect(
      dispatchAgentSocketRequest(service, {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        operation: "comment.watch.activate",
        input: { taskId },
      }),
    ).resolves.toEqual({ taskId, generation: 1 });
    await expect(
      dispatchAgentSocketRequest(service, {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        operation: "comment.watch.verify",
        input: { taskId, generation: 1 },
      }),
    ).resolves.toEqual({ taskId, generation: 1 });
    await expect(
      dispatchAgentSocketRequest(service, {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        operation: "comment.watch.reserveWrite",
        input: { taskId, generation: 1, leaseId, writeKey: "acme/repo" },
      }),
    ).resolves.toMatchObject({ leaseId, writeKey: "acme/repo", status: "reserved" });
    await expect(
      dispatchAgentSocketRequest(service, {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        operation: "comment.watch.releaseWrite",
        input: { taskId, generation: 1, leaseId },
      }),
    ).resolves.toMatchObject({ leaseId, status: "released" });
    expect(activateCommentWatchTask).toHaveBeenCalledWith(taskId);
    expect(verifyCommentWatchTask).toHaveBeenCalledWith(taskId, 1);
    expect(reserveCommentWatchWriter).toHaveBeenCalledWith(taskId, 1, leaseId, "acme/repo");
    expect(releaseCommentWatchWriter).toHaveBeenCalledWith(taskId, 1, leaseId);
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
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        operation: "comment.create",
        input,
      }),
    ).resolves.toEqual({
      ref: "rvw://comment/10000000-0000-4000-8000-000000000008",
    });
    expect(createCommentForReference).toHaveBeenCalledWith(input);

    await expect(
      dispatchAgentSocketRequest({ createCommentForReference } as unknown as RvwService, {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
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
      edit: {
        body: "✅ Done",
        relatedCommitOid: "a".repeat(40),
        watchTask: {
          taskId: "11111111-1111-4111-8111-111111111111",
          generation: 3,
        },
      },
    };

    await expect(
      dispatchAgentSocketRequest({ editCommentPost } as unknown as RvwService, {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        operation: "comment.edit",
        input,
      }),
    ).resolves.toEqual({ id: "post-1", body: "✅ Done" });
    expect(editCommentPost).toHaveBeenCalledWith(input.uri, input.postId, {
      ...input.edit,
      lastModifiedBy: "agent",
    });
  });

  it("routes Structure publication through the shared Agent transport", async () => {
    const publishStructure = vi.fn().mockResolvedValue({
      ref: "rvw://structure/70000000-0000-4000-8000-000000000001",
    });
    const input = {
      idempotencyKey: "structure-publish-auth-boundary",
      pullRequest: "https://github.com/acme/review-repo/pull/7",
      sourceOid: "a".repeat(40),
      title: "Authorization boundary",
      scope: "Relationships around authorization.",
      originNodeId: "entry",
      nodes: [
        {
          id: "entry",
          label: "Entry",
          anchor: { path: "src/entry.ts", startLine: 1, endLine: 1 },
        },
      ],
      edges: [],
    };
    await expect(
      dispatchAgentSocketRequest({ publishStructure } as unknown as RvwService, {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        operation: "structure.publish",
        input,
      }),
    ).resolves.toEqual({
      ref: "rvw://structure/70000000-0000-4000-8000-000000000001",
    });
    expect(publishStructure).toHaveBeenCalledWith(
      expect.objectContaining({
        ...input,
        nodes: [expect.objectContaining({ description: null, kind: null, notation: "plain" })],
      }),
    );
  });

  it("lists Structure references through the shared Agent transport", async () => {
    const listStructuresByReference = vi.fn().mockReturnValue({
      pullRequest: { id: "pr-7" },
      structures: [
        {
          ref: "rvw://structure/70000000-0000-4000-8000-000000000001",
          title: "Authorization boundary",
        },
      ],
    });

    await expect(
      dispatchAgentSocketRequest({ listStructuresByReference } as unknown as RvwService, {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        operation: "structure.list",
        input: { reference: "https://github.com/acme/review-repo/pull/7" },
      }),
    ).resolves.toMatchObject({
      pullRequest: { id: "pr-7" },
      structures: [{ ref: "rvw://structure/70000000-0000-4000-8000-000000000001" }],
    });
    expect(listStructuresByReference).toHaveBeenCalledWith(
      "https://github.com/acme/review-repo/pull/7",
    );
  });

  it("rejects mixed socket protocol versions and tells the caller to restart the viewer", async () => {
    const setCommentResolved = vi.fn();
    await expect(
      dispatchAgentSocketRequest({ setCommentResolved } as unknown as RvwService, {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION - 1,
        operation: "comment.resolve",
        input: { uri: "rvw://comment/10000000-0000-4000-8000-000000000001" },
      }),
    ).rejects.toMatchObject({
      code: "STALE_PROTOCOL",
      details: {
        expectedProtocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        receivedProtocolVersion: AGENT_SOCKET_PROTOCOL_VERSION - 1,
      },
      suggestions: [expect.stringMatching(/viewer.*再起動/)],
    });
    expect(setCommentResolved).not.toHaveBeenCalled();

    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-agent-old-protocol-"));
    const socketPath = path.join(directory, "agent.sock");
    let receivedProtocolVersion: number | null = null;
    const server = net.createServer((socket) => {
      let request = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        request += chunk;
        if (!request.includes("\n")) return;
        receivedProtocolVersion = (JSON.parse(request) as { protocolVersion: number })
          .protocolVersion;
        socket.end(
          `${JSON.stringify({
            ok: false,
            error: {
              code: "STALE_PROTOCOL",
              message: "Agent socket protocol versionが一致しません。",
              suggestions: [],
            },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(
        tryAgentSocketRequest(
          "comment.get",
          { uri: "rvw://comment/10000000-0000-4000-8000-000000000001", live: false },
          { socketPath, requireSocket: true },
        ),
      ).rejects.toMatchObject({
        code: "STALE_PROTOCOL",
        suggestions: [expect.stringMatching(/viewer.*再起動/)],
      });
      expect(receivedProtocolVersion).toBe(AGENT_SOCKET_PROTOCOL_VERSION);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
          protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
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
    const deleteStructureByUri = vi.fn();
    const service = {
      resolveStoredPullRequest: vi.fn().mockReturnValue({ id: "pr-1" }),
      resetPullRequest,
      deleteWalkthroughByUri,
      deleteStructureByUri,
    } as unknown as RvwService;

    await expect(
      dispatchAgentSocketRequest(service, {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        operation: "pr.reset",
        input: { reference: "1" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      dispatchAgentSocketRequest(service, {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        operation: "structure.delete",
        input: { uri: "rvw://structure/10000000-0000-4000-8000-000000000001" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      dispatchAgentSocketRequest(service, {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        operation: "walkthrough.delete",
        input: { uri: "rvw://walkthrough/10000000-0000-4000-8000-000000000001" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(resetPullRequest).not.toHaveBeenCalled();
    expect(deleteWalkthroughByUri).not.toHaveBeenCalled();
    expect(deleteStructureByUri).not.toHaveBeenCalled();
  });

  it("rejects inherited object property names as unsupported operations", async () => {
    await expect(
      dispatchAgentSocketRequest({} as RvwService, {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
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

  it("accepts lifecycle requests before Runtime initialization and dispatches after setup", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-runtime-dispatch-"));
    process.env.RVW_AGENT_SOCKET_PATH = path.join(directory, "agent.sock");
    const databasePath = path.join(directory, "review.db");
    let running: Awaited<ReturnType<typeof startRuntimeAgentSocket>>;
    try {
      running = await startRuntimeAgentSocket(databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const openViewer = vi.fn().mockResolvedValue({
      url: "http://127.0.0.1:4321/?pullRequestId=pr-1",
      origin: "http://127.0.0.1:4321",
      port: 4321,
      pullRequestId: "pr-1",
      ownerPid: process.pid,
    });
    try {
      expect(running.owned).toBe(true);
      const requested = tryRuntimeViewerOpen(
        { reference: "45", cwd: directory, requestedPort: 0 },
        databasePath,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(openViewer).not.toHaveBeenCalled();

      running.setHandler({
        service: { database: { filePath: databasePath } } as unknown as RvwService,
        openViewer,
      });

      await expect(requested).resolves.toEqual({
        available: true,
        result: {
          url: "http://127.0.0.1:4321/?pullRequestId=pr-1",
          origin: "http://127.0.0.1:4321",
          port: 4321,
          pullRequestId: "pr-1",
          ownerPid: process.pid,
        },
      });
      expect(openViewer).toHaveBeenCalledWith({
        reference: "45",
        cwd: directory,
        requestedPort: 0,
      });
    } finally {
      await running.close();
    }
  });

  it("gives concurrent runtime contenders one owner without follower takeover", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-runtime-owner-"));
    process.env.RVW_AGENT_SOCKET_PATH = path.join(directory, "agent.sock");
    const databasePath = path.join(directory, "review.db");
    let running: Array<Awaited<ReturnType<typeof startRuntimeAgentSocket>>>;
    try {
      running = await Promise.all([
        startRuntimeAgentSocket(databasePath),
        startRuntimeAgentSocket(databasePath),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const ownerIndex = running.findIndex((candidate) => candidate.owned);
    const followerIndex = ownerIndex === 0 ? 1 : 0;
    try {
      expect(ownerIndex).toBeGreaterThanOrEqual(0);
      expect(running.filter((candidate) => candidate.owned)).toHaveLength(1);
      await running[ownerIndex]!.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(running[followerIndex]!.owned).toBe(false);
    } finally {
      await Promise.all(running.map(async (candidate) => await candidate.close()));
    }
  });

  it("keeps runtime ownership while the Agent listener is draining", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-runtime-drain-"));
    process.env.RVW_AGENT_SOCKET_PATH = path.join(directory, "agent.sock");
    const databasePath = path.join(directory, "review.db");
    let owner: Awaited<ReturnType<typeof startRuntimeAgentSocket>>;
    try {
      owner = await startRuntimeAgentSocket(databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    let contender: Awaited<ReturnType<typeof startRuntimeAgentSocket>> | undefined;
    let successor: Awaited<ReturnType<typeof startRuntimeAgentSocket>> | undefined;
    try {
      await owner.stopAccepting();
      expect(owner.owned).toBe(true);
      expect(existsSync(`${owner.path}.owner`)).toBe(true);

      contender = await startRuntimeAgentSocket(databasePath);
      expect(contender.owned).toBe(false);

      await owner.releaseOwnership();
      expect(owner.owned).toBe(false);
      successor = await startRuntimeAgentSocket(databasePath);
      expect(successor.owned).toBe(true);
    } finally {
      await Promise.all([owner.close(), contender?.close(), successor?.close()]);
    }
  });

  it("hands ownership to a new open after a draining runtime releases its lock", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-runtime-handoff-"));
    process.env.RVW_AGENT_SOCKET_PATH = path.join(directory, "agent.sock");
    const databasePath = path.join(directory, "review.db");
    let owner: Awaited<ReturnType<typeof startRuntimeAgentSocket>>;
    try {
      owner = await startRuntimeAgentSocket(databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    let successor: Awaited<ReturnType<typeof startRuntimeAgentSocket>> | undefined;
    const firstOwnershipLoss = Promise.withResolvers<void>();
    const startSocket = vi.fn(async (filePath: string) => {
      const candidate = await startRuntimeAgentSocket(filePath);
      if (!candidate.owned) firstOwnershipLoss.resolve();
      return candidate;
    });
    try {
      await owner.stopAccepting();
      const handoff = acquireRuntimeOrReuseExisting(
        { cwd: "/repo", requestedPort: 0 },
        databasePath,
        2_000,
        { startSocket },
      );
      await firstOwnershipLoss.promise;

      await owner.releaseOwnership();
      const result = await handoff;
      expect(result.kind).toBe("owned");
      if (result.kind === "owned") successor = result.agentSocket;
      expect(startSocket).toHaveBeenCalledTimes(2);
    } finally {
      await Promise.all([owner.close(), successor?.close()]);
    }
  });

  it("keeps one runtime owner across processes and does not promote the loser", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-runtime-multiprocess-"));
    const socketPath = path.join(directory, "agent.sock");
    const databasePath = path.join(directory, "review.db");
    process.env.RVW_AGENT_SOCKET_PATH = socketPath;
    const fixture = path.resolve("test/fixtures/agent-socket-process.ts");
    const children = [
      fork(fixture, [databasePath, "runtime"], {
        execArgv: ["--import", "tsx"],
        env: { ...process.env, RVW_AGENT_SOCKET_PATH: socketPath },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      }),
      fork(fixture, [databasePath, "runtime"], {
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
      await new Promise((resolve) => setTimeout(resolve, 50));
      const requestId = Date.now();
      sendChildMessage(children[followerIndex]!, { type: "status", requestId });
      const follower = await waitForChildMessage(
        children[followerIndex]!,
        (message): message is ChildState =>
          childState(message) && message.type === "status" && message.requestId === requestId,
      );
      expect(follower.owned).toBe(false);
      expect(existsSync(`${socketPath}.owner`)).toBe(false);
    } finally {
      for (const child of children) sendChildMessage(child, { type: "close" });
      await Promise.all(
        children.map(
          async (child) =>
            await new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) resolve();
              else child.once("exit", () => resolve());
            }),
        ),
      );
    }
  });

  it("recovers a dead owner lock and stale socket before claiming runtime ownership", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-runtime-stale-"));
    const socketPath = path.join(directory, "agent.sock");
    process.env.RVW_AGENT_SOCKET_PATH = socketPath;
    writeFileSync(`${socketPath}.owner`, `${JSON.stringify({ pid: 2_147_483_647 })}\n`, {
      mode: 0o600,
    });
    writeFileSync(socketPath, "stale", { mode: 0o600 });
    let running: Awaited<ReturnType<typeof startRuntimeAgentSocket>>;
    try {
      running = await startRuntimeAgentSocket(path.join(directory, "review.db"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    try {
      expect(running.owned).toBe(true);
      expect(statSync(`${socketPath}.owner`).mode & 0o777).toBe(0o600);
    } finally {
      await running.close();
    }
  });

  it("allows independent runtime owners for different databases", async () => {
    delete process.env.RVW_AGENT_SOCKET_PATH;
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-runtime-databases-"));
    let running: Array<Awaited<ReturnType<typeof startRuntimeAgentSocket>>>;
    try {
      running = await Promise.all([
        startRuntimeAgentSocket(path.join(directory, "first.db")),
        startRuntimeAgentSocket(path.join(directory, "second.db")),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    try {
      expect(running[0]!.path).not.toBe(running[1]!.path);
      expect(running.every((candidate) => candidate.owned)).toBe(true);
    } finally {
      await Promise.all(running.map(async (candidate) => await candidate.close()));
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
