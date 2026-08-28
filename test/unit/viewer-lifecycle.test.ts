import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeBackgroundOpen,
  createRuntimeAgentSocketHandler,
  startBackgroundOpen,
  waitForServerShutdown,
  type BackgroundOpenChild,
} from "../../src/cli/main.js";
import type { Runtime } from "../../src/application/runtime.js";
import type { RunningServer } from "../../src/server/start-server.js";
import { ViewerLifecycle } from "../../src/server/viewer-lifecycle.js";

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

describe("ViewerLifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops only after the last viewer is released and the reload grace has elapsed", async () => {
    vi.useFakeTimers();
    const onAllViewersClosed = vi.fn();
    const lifecycle = new ViewerLifecycle({
      onAllViewersClosed,
      leaseTimeoutMs: 10_000,
      closeGraceMs: 500,
    });

    lifecycle.heartbeat("viewer-a");
    lifecycle.heartbeat("viewer-b");
    lifecycle.release("viewer-a");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onAllViewersClosed).not.toHaveBeenCalled();

    lifecycle.release("viewer-b");
    await vi.advanceTimersByTimeAsync(499);
    expect(onAllViewersClosed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onAllViewersClosed).toHaveBeenCalledOnce();
  });

  it("reports the first viewer connection exactly once", () => {
    const onFirstViewerConnected = vi.fn();
    const lifecycle = new ViewerLifecycle({
      onAllViewersClosed: vi.fn(),
      onFirstViewerConnected,
    });

    lifecycle.heartbeat("viewer-a");
    lifecycle.heartbeat("viewer-a");
    lifecycle.heartbeat("viewer-b");

    expect(onFirstViewerConnected).toHaveBeenCalledOnce();
  });

  it("cancels shutdown when a reloaded viewer reconnects during the grace period", async () => {
    vi.useFakeTimers();
    const onAllViewersClosed = vi.fn();
    const lifecycle = new ViewerLifecycle({
      onAllViewersClosed,
      leaseTimeoutMs: 10_000,
      closeGraceMs: 500,
    });

    lifecycle.heartbeat("old-document");
    lifecycle.release("old-document");
    await vi.advanceTimersByTimeAsync(250);
    lifecycle.heartbeat("reloaded-document");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(lifecycle.activeViewerCount).toBe(1);
    expect(onAllViewersClosed).not.toHaveBeenCalled();
  });

  it("ignores an in-flight heartbeat that arrives after the viewer release", async () => {
    vi.useFakeTimers();
    const onAllViewersClosed = vi.fn();
    const lifecycle = new ViewerLifecycle({
      onAllViewersClosed,
      leaseTimeoutMs: 10_000,
      closeGraceMs: 500,
    });

    lifecycle.heartbeat("closing-document");
    lifecycle.release("closing-document");
    lifecycle.heartbeat("closing-document");
    await vi.advanceTimersByTimeAsync(500);

    expect(lifecycle.activeViewerCount).toBe(0);
    expect(onAllViewersClosed).toHaveBeenCalledOnce();
  });

  it("uses lease expiry when a browser cannot send its release beacon", async () => {
    vi.useFakeTimers();
    const onAllViewersClosed = vi.fn();
    const lifecycle = new ViewerLifecycle({
      onAllViewersClosed,
      leaseTimeoutMs: 1_000,
      closeGraceMs: 100,
    });

    lifecycle.heartbeat("crashed-viewer");
    await vi.advanceTimersByTimeAsync(999);
    expect(lifecycle.activeViewerCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(lifecycle.activeViewerCount).toBe(0);
    expect(onAllViewersClosed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(onAllViewersClosed).toHaveBeenCalledOnce();
  });

  it("does not interpret a suspended event loop as a dead viewer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
    const onAllViewersClosed = vi.fn();
    const lifecycle = new ViewerLifecycle({
      onAllViewersClosed,
      leaseTimeoutMs: 1_000,
      closeGraceMs: 100,
      timerLatenessToleranceMs: 100,
    });

    lifecycle.heartbeat("sleeping-machine");
    vi.setSystemTime(new Date("2026-08-08T00:01:00.000Z"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(lifecycle.activeViewerCount).toBe(1);
    expect(onAllViewersClosed).not.toHaveBeenCalled();
  });

  it("does not auto-stop before any viewer has connected", async () => {
    vi.useFakeTimers();
    const onAllViewersClosed = vi.fn();
    new ViewerLifecycle({
      onAllViewersClosed,
      leaseTimeoutMs: 100,
      closeGraceMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onAllViewersClosed).not.toHaveBeenCalled();
  });
});

describe("waitForServerShutdown", () => {
  it("resolves from viewer shutdown and removes process signal listeners", async () => {
    const listenersBefore = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    const viewersClosed = Promise.withResolvers<void>();
    const waiting = waitForServerShutdown(viewersClosed.promise);

    viewersClosed.resolve();
    await expect(waiting).resolves.toBe("viewers-closed");
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(listenersBefore.sigterm);
  });
});

describe("completeBackgroundOpen", () => {
  it("returns only after the browser opens and its first viewer connects", async () => {
    const child = backgroundChild();
    const launchBrowser = vi.fn().mockResolvedValue(undefined);
    const opening = completeBackgroundOpen(child, launchBrowser, {
      readyTimeoutMs: 1_000,
      viewerTimeoutMs: 1_000,
    });

    child.emit("message", { type: "ready", url: "http://127.0.0.1:4321/?pullRequestId=pr-1" });
    await vi.waitFor(() => expect(launchBrowser).toHaveBeenCalledOnce());
    child.emit("message", { type: "viewer-connected" });

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
      { readyTimeoutMs: 1_000, viewerTimeoutMs: 1_000 },
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
      viewerTimeoutMs: 1_000,
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
      viewerTimeoutMs: 100,
    });

    const rejection = expect(opening).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  });

  it("stops a ready worker when no browser viewer connects", async () => {
    vi.useFakeTimers();
    const child = backgroundChild();
    const launchBrowser = vi.fn().mockResolvedValue(undefined);
    const opening = completeBackgroundOpen(child, launchBrowser, {
      readyTimeoutMs: 1_000,
      viewerTimeoutMs: 100,
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
      startBackgroundOpen("45", 0, { forkWorker, launchBrowser, tryRuntimeOpen }),
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
        child.emit("message", { type: "viewer-connected" });
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
    expect(forkWorker).toHaveBeenCalledWith(undefined, 4321);
  });

  it("reuses the active origin and rejects a conflicting explicit port before opening a PR", async () => {
    const openPullRequest = vi.fn().mockResolvedValue({ pullRequest: { id: "pr-45" } });
    const handler = createRuntimeAgentSocketHandler(
      { service: { openPullRequest } } as unknown as Runtime,
      { origin: "http://127.0.0.1:4321", port: 4321 } as RunningServer,
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
});
