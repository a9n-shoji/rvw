import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import type { RvwService } from "../application/rvw-service.js";
import { createApp, type ServerSecurityContext } from "./app.js";
import { ViewerLifecycle } from "./viewer-lifecycle.js";

export interface RunningServer {
  server: ServerType;
  host: "127.0.0.1";
  port: number;
  origin: string;
  allViewersClosed: Promise<void> | null;
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
  const allViewersClosed = options.autoCloseWhenNoViewers
    ? new Promise<void>((resolve) => {
        resolveAllViewersClosed = resolve;
      })
    : null;
  const viewerLifecycle = resolveAllViewersClosed
    ? new ViewerLifecycle({ onAllViewersClosed: resolveAllViewersClosed })
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
          allViewersClosed,
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
