import { EventEmitter } from "node:events";
import { createServer as createNetServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireRuntimeOrReuseExisting,
  closeOwnedRuntime,
  completeBackgroundOpen,
  createRuntimeAgentSocketHandler,
  startBackgroundOpen,
  waitForServerShutdown,
  type BackgroundOpenChild,
} from "../../src/cli/main.js";
import type { Runtime } from "../../src/application/runtime.js";
import { DEFAULT_VIEWER_PORT } from "../../src/shared/constants.js";
import { RvwError } from "../../src/shared/errors.js";
import type { RunningRuntimeAgentSocket } from "../../src/server/agent-socket.js";
import { startServer, type RunningServer } from "../../src/server/start-server.js";

function backgroundChild(): BackgroundOpenChild & {
  emit(event: string, ...args: unknown[]): boolean;
  kill: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    connected: true,
    kill: vi.fn(() => true),
    disconnect: vi.fn(() => {
      child.connected = false;
    }),
    unref: vi.fn(),
  });
  return child;
}

afterEach(() => vi.useRealTimers());

describe("waitForServerShutdown", () => {
  it("resolves from an explicit stop request and removes process signal listeners", async () => {
    const listenersBefore = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    const stopRequested = Promise.withResolvers<void>();
    const waiting = waitForServerShutdown(stopRequested.promise);

    stopRequested.resolve();
    await expect(waiting).resolves.toBe("stop-command");
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(listenersBefore.sigterm);
  });
});

describe("completeBackgroundOpen", () => {
  it("returns after browser launch without waiting for a viewer connection", async () => {
    const child = backgroundChild();
    const launchBrowser = vi.fn().mockResolvedValue(undefined);
    const opening = completeBackgroundOpen(child, launchBrowser, {
      readyTimeoutMs: 1_000,
      browserTimeoutMs: 1_000,
    });

    child.emit("message", { type: "ready", url: "http://127.0.0.1:4321/?pullRequestId=pr-1" });
    await vi.waitFor(() => expect(launchBrowser).toHaveBeenCalledOnce());

    await expect(opening).resolves.toBe("http://127.0.0.1:4321/?pullRequestId=pr-1");
    expect(child.disconnect.mock.calls).toHaveLength(1);
    expect(child.unref.mock.calls).toHaveLength(1);
    expect(child.kill.mock.calls).toHaveLength(0);
  });

  it("stops the worker when browser launch fails", async () => {
    const child = backgroundChild();
    const opening = completeBackgroundOpen(
      child,
      vi.fn().mockRejectedValue(new Error("browser launch failed")),
      { readyTimeoutMs: 1_000, browserTimeoutMs: 1_000 },
    );

    child.emit("message", { type: "ready", url: "http://127.0.0.1:4321/" });

    await expect(opening).rejects.toThrow("browser launch failed");
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(child.unref.mock.calls).toHaveLength(0);
  });

  it("propagates worker startup errors and stops the worker", async () => {
    const child = backgroundChild();
    const opening = completeBackgroundOpen(child, vi.fn().mockResolvedValue(undefined), {
      readyTimeoutMs: 1_000,
      browserTimeoutMs: 1_000,
    });

    child.emit("message", {
      type: "error",
      error: {
        code: "GH_NOT_AUTHENTICATED",
        message: "GitHub CLIの認証が必要です。",
        suggestions: ["gh auth login"],
        status: 400,
      },
    });

    await expect(opening).rejects.toMatchObject({
      code: "GH_NOT_AUTHENTICATED",
      suggestions: ["gh auth login"],
      status: 400,
    });
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  });

  it("times out and stops a worker that never becomes ready", async () => {
    vi.useFakeTimers();
    const child = backgroundChild();
    const opening = completeBackgroundOpen(child, vi.fn().mockResolvedValue(undefined), {
      readyTimeoutMs: 100,
      browserTimeoutMs: 100,
    });

    const rejection = expect(opening).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  });

  it("stops a ready worker when the OS browser launch does not complete", async () => {
    vi.useFakeTimers();
    const child = backgroundChild();
    const launchBrowser = vi.fn(() => new Promise<void>(() => {}));
    const opening = completeBackgroundOpen(child, launchBrowser, {
      readyTimeoutMs: 1_000,
      browserTimeoutMs: 100,
    });

    child.emit("message", { type: "ready", url: "http://127.0.0.1:4321/" });
    await vi.waitFor(() => expect(launchBrowser).toHaveBeenCalledOnce());
    const rejection = expect(opening).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  });
});

describe("database-scoped viewer runtime reuse", () => {
  beforeEach(() => vi.useRealTimers());

  it("opens the saved PR list in an active runtime without selecting a PR or forking", async () => {
    const forkWorker = vi.fn();
    const launchBrowser = vi.fn().mockResolvedValue(undefined);
    const tryRuntimeOpen = vi.fn().mockResolvedValue({
      available: true,
      result: {
        url: "http://127.0.0.1:4321/",
        origin: "http://127.0.0.1:4321",
        port: 4321,
        pullRequestId: null,
        ownerPid: 123,
      },
    });

    await expect(
      startBackgroundOpen(
        undefined,
        undefined,
        { forkWorker, launchBrowser, tryRuntimeOpen },
        true,
      ),
    ).resolves.toBe("http://127.0.0.1:4321/");

    expect(tryRuntimeOpen).toHaveBeenCalledWith({
      list: true,
      cwd: process.cwd(),
      requestedPort: 0,
    });
    expect(launchBrowser).toHaveBeenCalledWith("http://127.0.0.1:4321/");
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it("passes list mode to the first background worker on the stable default port", async () => {
    const child = backgroundChild();
    const forkWorker = vi.fn(() => {
      setTimeout(() => {
        child.emit("message", {
          type: "ready",
          url: `http://127.0.0.1:${DEFAULT_VIEWER_PORT}/`,
        });
      }, 0);
      return child;
    });
    const tryRuntimeOpen = vi.fn().mockResolvedValue({
      available: false,
      reason: "socket-not-found",
    });

    await expect(
      startBackgroundOpen(
        undefined,
        undefined,
        { forkWorker, launchBrowser: vi.fn().mockResolvedValue(undefined), tryRuntimeOpen },
        true,
      ),
    ).resolves.toBe(`http://127.0.0.1:${DEFAULT_VIEWER_PORT}/`);

    expect(tryRuntimeOpen).toHaveBeenCalledWith({
      list: true,
      cwd: process.cwd(),
      requestedPort: 0,
    });
    expect(forkWorker).toHaveBeenCalledWith(undefined, DEFAULT_VIEWER_PORT, 0, true);
  });

  it("opens an additional viewer in an active runtime without forking a worker", async () => {
    const forkWorker = vi.fn();
    const launchBrowser = vi.fn().mockResolvedValue(undefined);
    const tryRuntimeOpen = vi.fn().mockResolvedValue({
      available: true,
      result: {
        url: "http://127.0.0.1:4321/?pullRequestId=pr-45",
        origin: "http://127.0.0.1:4321",
        port: 4321,
        pullRequestId: "pr-45",
        ownerPid: 123,
      },
    });

    await expect(
      startBackgroundOpen("45", undefined, { forkWorker, launchBrowser, tryRuntimeOpen }),
    ).resolves.toBe("http://127.0.0.1:4321/?pullRequestId=pr-45");

    expect(tryRuntimeOpen).toHaveBeenCalledWith({
      reference: "45",
      cwd: process.cwd(),
      requestedPort: 0,
    });
    expect(launchBrowser).toHaveBeenCalledWith("http://127.0.0.1:4321/?pullRequestId=pr-45");
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it("forks the first background worker when no runtime is active", async () => {
    const child = backgroundChild();
    const forkWorker = vi.fn(() => {
      setTimeout(() => {
        child.emit("message", { type: "ready", url: "http://127.0.0.1:4321/" });
      }, 0);
      return child;
    });

    await expect(
      startBackgroundOpen(undefined, 4321, {
        forkWorker,
        launchBrowser: vi.fn().mockResolvedValue(undefined),
        tryRuntimeOpen: vi.fn().mockResolvedValue({
          available: false,
          reason: "socket-not-found",
        }),
      }),
    ).resolves.toBe("http://127.0.0.1:4321/");
    expect(forkWorker).toHaveBeenCalledWith(undefined, 4321, 4321, false);
  });

  it("starts the first runtime on the stable default port while treating an omitted port as reusable", async () => {
    const child = backgroundChild();
    const forkWorker = vi.fn(() => {
      setTimeout(() => {
        child.emit("message", {
          type: "ready",
          url: `http://127.0.0.1:${DEFAULT_VIEWER_PORT}/`,
        });
      }, 0);
      return child;
    });
    const tryRuntimeOpen = vi.fn().mockResolvedValue({
      available: false,
      reason: "socket-not-found",
    });

    await expect(
      startBackgroundOpen(undefined, undefined, {
        forkWorker,
        launchBrowser: vi.fn().mockResolvedValue(undefined),
        tryRuntimeOpen,
      }),
    ).resolves.toBe(`http://127.0.0.1:${DEFAULT_VIEWER_PORT}/`);

    expect(tryRuntimeOpen).toHaveBeenCalledWith({ cwd: process.cwd(), requestedPort: 0 });
    expect(forkWorker).toHaveBeenCalledWith(undefined, DEFAULT_VIEWER_PORT, 0, false);
  });

  it("hands a stopping runtime off to a background worker", async () => {
    const child = backgroundChild();
    const forkWorker = vi.fn(() => {
      setTimeout(() => {
        child.emit("message", { type: "ready", url: "http://127.0.0.1:4321/" });
      }, 0);
      return child;
    });

    await expect(
      startBackgroundOpen(undefined, 0, {
        forkWorker,
        launchBrowser: vi.fn().mockResolvedValue(undefined),
        tryRuntimeOpen: vi.fn().mockRejectedValue(
          new RvwError("PROCESS_FAILED", "runtime stopping", {
            details: { reason: "runtime-stopping" },
          }),
        ),
      }),
    ).resolves.toBe("http://127.0.0.1:4321/");
    expect(forkWorker).toHaveBeenCalledWith(undefined, 0, 0, false);
  });

  it("opens the saved PR list without browser leases or resolving a repository or PR", async () => {
    const openPullRequest = vi.fn().mockRejectedValue(new Error("not a Git repository"));
    const handler = createRuntimeAgentSocketHandler(
      { service: { openPullRequest } } as unknown as Runtime,
      {
        origin: "http://127.0.0.1:4321",
        port: 4321,
      } as unknown as RunningServer,
    );

    await expect(
      handler.openViewer({ list: true, cwd: "/not-a-repository", requestedPort: 0 }),
    ).resolves.toEqual({
      url: "http://127.0.0.1:4321/",
      origin: "http://127.0.0.1:4321",
      port: 4321,
      pullRequestId: null,
      ownerPid: process.pid,
    });
    expect(openPullRequest).not.toHaveBeenCalled();
  });

  it("reuses the active origin and rejects a conflicting explicit port before opening a PR", async () => {
    const openPullRequest = vi.fn().mockResolvedValue({ pullRequest: { id: "pr-45" } });
    const handler = createRuntimeAgentSocketHandler(
      { service: { openPullRequest } } as unknown as Runtime,
      {
        origin: "http://127.0.0.1:4321",
        port: 4321,
      } as unknown as RunningServer,
    );

    await expect(
      handler.openViewer({ reference: "45", cwd: "/repo", requestedPort: 5000 }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { activePort: 4321, requestedPort: 5000 },
    });
    expect(openPullRequest).not.toHaveBeenCalled();

    await expect(
      handler.openViewer({ reference: "45", cwd: "/repo", requestedPort: 4321 }),
    ).resolves.toEqual({
      url: "http://127.0.0.1:4321/?pullRequestId=pr-45",
      origin: "http://127.0.0.1:4321",
      port: 4321,
      pullRequestId: "pr-45",
      ownerPid: process.pid,
    });
    expect(openPullRequest).toHaveBeenCalledWith("45", "/repo");
  });

  it("propagates PR resolution failures without a browser reservation", async () => {
    const failure = new Error("unknown PR");
    const handler = createRuntimeAgentSocketHandler(
      {
        service: { openPullRequest: vi.fn().mockRejectedValue(failure) },
      } as unknown as Runtime,
      {
        origin: "http://127.0.0.1:4321",
        port: 4321,
      } as unknown as RunningServer,
    );

    await expect(
      handler.openViewer({ reference: "999", cwd: "/repo", requestedPort: 0 }),
    ).rejects.toBe(failure);
  });
});

describe("viewer port startup", () => {
  it("reports an actionable error when a fixed port is already occupied", async () => {
    const blocker = createNetServer();
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(0, "127.0.0.1", resolve);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("test port was not assigned");

    try {
      try {
        await startServer({} as Parameters<typeof startServer>[0], { port: address.port });
        expect.unreachable("occupied viewer port should fail");
      } catch (error) {
        expect(error).toBeInstanceOf(RvwError);
        if (!(error instanceof RvwError)) throw error;
        expect(error).toMatchObject({
          code: "PROCESS_FAILED",
          details: { port: address.port, reason: "address-in-use" },
        });
        expect(error.suggestions).toContain(
          "一時的に空きportを自動選択する場合は--port 0を指定してください。",
        );
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("runtime shutdown sequencing", () => {
  it("stops Agent requests, drains HTTP, closes SQLite, and releases ownership last", async () => {
    const calls: string[] = [];
    const agentSocket = {
      stopAccepting: vi.fn(() => {
        calls.push("agent-stop");
        return Promise.resolve();
      }),
      releaseOwnership: vi.fn(() => {
        calls.push("owner-release");
        return Promise.resolve();
      }),
    };
    const running = {
      close: vi.fn(() => {
        calls.push("http-close");
        return Promise.resolve();
      }),
    };
    const runtime = { close: vi.fn(() => calls.push("runtime-close")) };

    await closeOwnedRuntime(
      agentSocket as unknown as Parameters<typeof closeOwnedRuntime>[0],
      running as unknown as Parameters<typeof closeOwnedRuntime>[1],
      runtime as unknown as Parameters<typeof closeOwnedRuntime>[2],
    );

    expect(calls).toEqual(["agent-stop", "http-close", "runtime-close", "owner-release"]);
  });

  it("drains an accepted HTTP operation even after its browser connection is aborted", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let operationCompleted = false;
    const service = {
      refreshPullRequestStatuses: async () => {
        entered.resolve();
        await release.promise;
        operationCompleted = true;
        return { updated: [], failures: [] };
      },
    } as unknown as Parameters<typeof startServer>[0];
    const running = await startServer(service);
    const abort = new AbortController();
    const request = fetch(`${running.origin}/api/pull-requests/refresh-statuses`, {
      method: "POST",
      headers: { origin: running.origin, "content-type": "application/json" },
      body: "{}",
      signal: abort.signal,
    }).catch(() => undefined);
    const runtimeClose = vi.fn();
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      abort.abort();
      await request;
      closing = closeOwnedRuntime(undefined, running, {
        close: runtimeClose,
      } as unknown as Runtime);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(operationCompleted).toBe(false);
      expect(runtimeClose).not.toHaveBeenCalled();
      release.resolve();
      await closing;
      expect(operationCompleted).toBe(true);
      expect(runtimeClose).toHaveBeenCalledOnce();
      await running.close();
    } finally {
      release.resolve();
      abort.abort();
      await request;
      await closing;
      await running.close();
    }
  });

  it("retries ownership after a draining runtime disappears", async () => {
    const closeFollower = vi.fn().mockResolvedValue(undefined);
    const follower = {
      owned: false,
      close: closeFollower,
    } as unknown as RunningRuntimeAgentSocket;
    const owner = {
      owned: true,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as RunningRuntimeAgentSocket;
    const startSocket = vi.fn().mockResolvedValueOnce(follower).mockResolvedValueOnce(owner);
    const tryRuntimeOpen = vi.fn().mockResolvedValue({
      available: false,
      reason: "socket-not-found",
    });

    await expect(
      acquireRuntimeOrReuseExisting({ cwd: "/repo", requestedPort: 0 }, "/data/review.db", 1_000, {
        startSocket,
        tryRuntimeOpen,
        wait: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toEqual({ kind: "owned", agentSocket: owner });
    expect(closeFollower).toHaveBeenCalledOnce();
    expect(startSocket).toHaveBeenCalledTimes(2);
  });

  it("retries ownership when viewer.open reports that its runtime is stopping", async () => {
    const follower = {
      owned: false,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as RunningRuntimeAgentSocket;
    const owner = {
      owned: true,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as RunningRuntimeAgentSocket;
    const startSocket = vi.fn().mockResolvedValueOnce(follower).mockResolvedValueOnce(owner);
    const tryRuntimeOpen = vi.fn().mockRejectedValue(
      new RvwError("PROCESS_FAILED", "runtime stopping", {
        details: { reason: "runtime-stopping" },
      }),
    );

    await expect(
      acquireRuntimeOrReuseExisting({ cwd: "/repo", requestedPort: 0 }, "/data/review.db", 1_000, {
        startSocket,
        tryRuntimeOpen,
        wait: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toEqual({ kind: "owned", agentSocket: owner });
    expect(startSocket).toHaveBeenCalledTimes(2);
  });
});
