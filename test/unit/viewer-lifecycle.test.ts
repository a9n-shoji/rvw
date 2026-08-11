import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForServerShutdown } from "../../src/cli/main.js";
import { ViewerLifecycle } from "../../src/server/viewer-lifecycle.js";

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
