export const DEFAULT_VIEWER_LEASE_TIMEOUT_MS = 120_000;
export const DEFAULT_VIEWER_CLOSE_GRACE_MS = 5_000;
export const DEFAULT_TIMER_LATENESS_TOLERANCE_MS = 2_000;
export const DEFAULT_VIEWER_STARTUP_TIMEOUT_MS = 30_000;

export interface ViewerLifecycleOptions {
  onAllViewersClosed(): void;
  onFirstViewerConnected?(): void;
  leaseTimeoutMs?: number;
  startupTimeoutMs?: number;
  closeGraceMs?: number;
  timerLatenessToleranceMs?: number;
}

type TimerKind = "activity" | "empty";

interface PendingViewer {
  deadline: number;
  timeoutMs: number;
}

export class ViewerLifecycle {
  private readonly viewers = new Map<string, number>();
  private readonly pendingViewers = new Map<string, PendingViewer>();
  // A poll already in flight can arrive after its pagehide release. Keep that document closed.
  private readonly releasedViewers = new Set<string>();
  private readonly leaseTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly timerLatenessToleranceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private viewerHasConnected = false;

  constructor(private readonly options: ViewerLifecycleOptions) {
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? DEFAULT_VIEWER_LEASE_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_VIEWER_STARTUP_TIMEOUT_MS;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_VIEWER_CLOSE_GRACE_MS;
    this.timerLatenessToleranceMs =
      options.timerLatenessToleranceMs ?? DEFAULT_TIMER_LATENESS_TOLERANCE_MS;
  }

  get activeViewerCount(): number {
    return this.viewers.size;
  }

  get pendingViewerCount(): number {
    return this.pendingViewers.size;
  }

  reserveViewer(leaseId: string): boolean {
    if (this.stopped) return false;
    this.pendingViewers.set(leaseId, {
      deadline: Date.now() + this.startupTimeoutMs,
      timeoutMs: this.startupTimeoutMs,
    });
    this.scheduleActivityCheck();
    return true;
  }

  cancelViewerReservation(leaseId: string): void {
    if (this.stopped || !this.pendingViewers.delete(leaseId)) return;
    this.scheduleNext();
  }

  heartbeat(viewerId: string, pendingLeaseId?: string): void {
    if (this.stopped || this.releasedViewers.has(viewerId)) return;
    if (pendingLeaseId !== undefined) this.pendingViewers.delete(pendingLeaseId);
    if (!this.viewerHasConnected) {
      this.viewerHasConnected = true;
      this.options.onFirstViewerConnected?.();
    }
    this.viewers.set(viewerId, Date.now());
    this.scheduleActivityCheck();
  }

  release(viewerId: string): void {
    if (this.stopped) return;
    this.releasedViewers.add(viewerId);
    if (!this.viewers.delete(viewerId)) return;
    this.scheduleNext();
  }

  close(): void {
    this.stopped = true;
    this.clearTimer();
    this.viewers.clear();
    this.pendingViewers.clear();
    this.releasedViewers.clear();
  }

  private scheduleNext(): void {
    if (this.viewers.size > 0 || this.pendingViewers.size > 0) this.scheduleActivityCheck();
    else this.scheduleEmptyShutdown();
  }

  private scheduleActivityCheck(): void {
    if (this.stopped) return;
    const deadlines = [
      ...Array.from(this.viewers.values(), (heartbeat) => heartbeat + this.leaseTimeoutMs),
      ...Array.from(this.pendingViewers.values(), (pending) => pending.deadline),
    ];
    if (deadlines.length === 0) return;
    this.schedule("activity", Math.min(...deadlines));
  }

  private scheduleEmptyShutdown(): void {
    if (this.stopped || this.viewers.size > 0 || this.pendingViewers.size > 0) return;
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
      for (const [leaseId, pending] of this.pendingViewers) {
        this.pendingViewers.set(leaseId, {
          deadline: now + pending.timeoutMs,
          timeoutMs: pending.timeoutMs,
        });
      }
      this.scheduleNext();
      return;
    }

    if (kind === "activity") {
      for (const [viewerId, lastHeartbeat] of this.viewers) {
        if (now - lastHeartbeat >= this.leaseTimeoutMs) this.viewers.delete(viewerId);
      }
      for (const [leaseId, pending] of this.pendingViewers) {
        if (now >= pending.deadline) this.pendingViewers.delete(leaseId);
      }
      this.scheduleNext();
      return;
    }

    if (this.viewers.size === 0 && this.pendingViewers.size === 0) {
      this.stopped = true;
      this.options.onAllViewersClosed();
    } else {
      this.scheduleActivityCheck();
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
