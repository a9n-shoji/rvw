import { randomUUID } from "node:crypto";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import type { RvwService } from "../application/rvw-service.js";
import { RvwError } from "../shared/errors.js";
import { createApp, type ServerSecurityContext } from "./app.js";
import { ViewerLifecycle } from "./viewer-lifecycle.js";

export const RUNTIME_STOPPING_REASON = "runtime-stopping";

export interface RunningServer {
  server: ServerType;
  host: "127.0.0.1";
  port: number;
  origin: string;
  firstViewerConnected: Promise<void> | null;
  allViewersClosed: Promise<void> | null;
  reserveViewer(): string | null;
  armViewerReservation(leaseId: string): void;
  cancelViewerReservation(leaseId: string): void;
  close(): Promise<void>;
}

export async function startServer(
  service: RvwService,
  options: {
    port?: number;
    staticDirectory?: string;
    autoCloseWhenNoViewers?: boolean;
  } = {},
): Promise<RunningServer> {
  const host = "127.0.0.1" as const;
  const security: ServerSecurityContext = { expectedHost: null, expectedOrigin: null };
  let resolveAllViewersClosed: (() => void) | undefined;
  let resolveFirstViewerConnected: (() => void) | undefined;
  const firstViewerConnected = options.autoCloseWhenNoViewers
    ? new Promise<void>((resolve) => {
        resolveFirstViewerConnected = resolve;
      })
    : null;
  const allViewersClosed = options.autoCloseWhenNoViewers
    ? new Promise<void>((resolve) => {
        resolveAllViewersClosed = resolve;
      })
    : null;
  const viewerLifecycle = resolveAllViewersClosed
    ? new ViewerLifecycle({
        onAllViewersClosed: resolveAllViewersClosed,
        ...(resolveFirstViewerConnected === undefined
          ? {}
          : { onFirstViewerConnected: resolveFirstViewerConnected }),
      })
    : undefined;
  const app = createApp(service, {
    security,
    ...(options.staticDirectory === undefined ? {} : { staticDirectory: options.staticDirectory }),
    ...(viewerLifecycle === undefined ? {} : { viewerLifecycle }),
  });
  return await new Promise<RunningServer>((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: host,
        port: options.port ?? 0,
      },
      (info) => {
        const origin = `http://${host}:${info.port}`;
        security.expectedHost = `${host}:${info.port}`;
        security.expectedOrigin = origin;
        let closePromise: Promise<void> | null = null;
        resolve({
          server,
          host,
          port: info.port,
          origin,
          firstViewerConnected,
          allViewersClosed,
          reserveViewer: () => {
            if (!viewerLifecycle) return null;
            const leaseId = randomUUID();
            if (!viewerLifecycle.reserveViewer(leaseId)) {
              throw new RvwError(
                "PROCESS_FAILED",
                "rvw runtimeは停止処理中のためviewerを追加できません。",
                {
                  details: { reason: RUNTIME_STOPPING_REASON },
                  suggestions: ["rvw openを再実行してください。"],
                },
              );
            }
            return leaseId;
          },
          armViewerReservation: (leaseId) => {
            if (!viewerLifecycle || viewerLifecycle.armViewerReservation(leaseId)) return;
            throw new RvwError(
              "PROCESS_FAILED",
              "rvw runtimeは停止処理中のためviewerを追加できません。",
              {
                details: { reason: RUNTIME_STOPPING_REASON },
                suggestions: ["rvw openを再実行してください。"],
              },
            );
          },
          cancelViewerReservation: (leaseId) => viewerLifecycle?.cancelViewerReservation(leaseId),
          close: () =>
            (closePromise ??= (async () => {
              viewerLifecycle?.close();
              await new Promise<void>((closeResolve, closeReject) => {
                server.close((error?: Error) => (error ? closeReject(error) : closeResolve()));
              });
            })()),
        });
      },
    );
    server.on("error", reject);
  });
}
