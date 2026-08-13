export const DEFAULT_VIEWER_LEASE_TIMEOUT_MS = 120_000;
export const DEFAULT_VIEWER_CLOSE_GRACE_MS = 5_000;
export const DEFAULT_TIMER_LATENESS_TOLERANCE_MS = 2_000;
export const DEFAULT_VIEWER_STARTUP_TIMEOUT_MS = 30_000;

export interface ViewerLifecycleOptions {
  onAllViewersClosed(): void;
  onFirstViewerConnected?(): void;
  leaseTimeoutMs?: number;
  closeGraceMs?: number;
  timerLatenessToleranceMs?: number;
}

type TimerKind = "lease" | "empty";

export class ViewerLifecycle {
  private readonly viewers = new Map<string, number>();
  // A poll already in flight can arrive after its pagehide release. Keep that document closed.
  private readonly releasedViewers = new Set<string>();
  private readonly leaseTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly timerLatenessToleranceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private viewerHasConnected = false;

  constructor(private readonly options: ViewerLifecycleOptions) {
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? DEFAULT_VIEWER_LEASE_TIMEOUT_MS;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_VIEWER_CLOSE_GRACE_MS;
    this.timerLatenessToleranceMs =
      options.timerLatenessToleranceMs ?? DEFAULT_TIMER_LATENESS_TOLERANCE_MS;
  }

  get activeViewerCount(): number {
    return this.viewers.size;
  }

  heartbeat(viewerId: string): void {
    if (this.stopped || this.releasedViewers.has(viewerId)) return;
    if (!this.viewerHasConnected) {
      this.viewerHasConnected = true;
      this.options.onFirstViewerConnected?.();
    }
    this.viewers.set(viewerId, Date.now());
    this.scheduleLeaseCheck();
  }

  release(viewerId: string): void {
    if (this.stopped) return;
    this.releasedViewers.add(viewerId);
    if (!this.viewers.delete(viewerId)) return;
    if (this.viewers.size === 0) this.scheduleEmptyShutdown();
    else this.scheduleLeaseCheck();
  }

  close(): void {
    this.stopped = true;
    this.clearTimer();
    this.viewers.clear();
    this.releasedViewers.clear();
  }

  private scheduleLeaseCheck(): void {
    if (this.stopped || this.viewers.size === 0) return;
    const earliestHeartbeat = Math.min(...this.viewers.values());
    this.schedule("lease", earliestHeartbeat + this.leaseTimeoutMs);
  }

  private scheduleEmptyShutdown(): void {
    if (this.stopped || this.viewers.size > 0) return;
    this.schedule("empty", Date.now() + this.closeGraceMs);
  }

  private schedule(kind: TimerKind, deadline: number): void {
    this.clearTimer();
    const delay = Math.max(0, deadline - Date.now());
    this.timer = setTimeout(() => this.onTimer(kind, deadline), delay);
  }

  private onTimer(kind: TimerKind, deadline: number): void {
    this.timer = null;
    if (this.stopped) return;

    const now = Date.now();
    if (now - deadline > this.timerLatenessToleranceMs) {
      for (const viewerId of this.viewers.keys()) this.viewers.set(viewerId, now);
      if (this.viewers.size === 0) this.scheduleEmptyShutdown();
      else this.scheduleLeaseCheck();
      return;
    }

    if (kind === "lease") {
      for (const [viewerId, lastHeartbeat] of this.viewers) {
        if (now - lastHeartbeat >= this.leaseTimeoutMs) this.viewers.delete(viewerId);
      }
      if (this.viewers.size > 0) this.scheduleLeaseCheck();
      else this.scheduleEmptyShutdown();
      return;
    }

    if (this.viewers.size === 0) {
      this.stopped = true;
      this.options.onAllViewersClosed();
    } else {
      this.scheduleLeaseCheck();
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
