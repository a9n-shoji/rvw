import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import type { RvwService } from "../application/rvw-service.js";
import { RvwError } from "../shared/errors.js";
import { createApp, type ServerSecurityContext } from "./app.js";

export const RUNTIME_STOPPING_REASON = "runtime-stopping";

export interface RunningServer {
  server: ServerType;
  host: "127.0.0.1";
  port: number;
  origin: string;
  close(): Promise<void>;
}

export async function startServer(
  service: RvwService,
  options: {
    port?: number;
    staticDirectory?: string;
  } = {},
): Promise<RunningServer> {
  const host = "127.0.0.1" as const;
  const security: ServerSecurityContext = { expectedHost: null, expectedOrigin: null };
  const app = createApp(service, {
    security,
    ...(options.staticDirectory === undefined ? {} : { staticDirectory: options.staticDirectory }),
  });
  const pendingRequests = new Set<Promise<Response>>();
  return await new Promise<RunningServer>((resolve, reject) => {
    const server = serve(
      {
        fetch: (request, environment) => {
          const pending = Promise.resolve(app.fetch(request, environment));
          pendingRequests.add(pending);
          const completed = (): void => {
            pendingRequests.delete(pending);
          };
          void pending.then(completed, completed);
          return pending;
        },
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
          close: () =>
            (closePromise ??= (async () => {
              await new Promise<void>((closeResolve, closeReject) => {
                server.close((error?: Error) => (error ? closeReject(error) : closeResolve()));
              });
              // Aborting a tab's connection does not cancel its in-flight application operation.
              while (pendingRequests.size > 0) await Promise.allSettled(pendingRequests);
            })()),
        });
      },
    );
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE" || (options.port ?? 0) === 0) {
        reject(error);
        return;
      }
      reject(
        new RvwError("PROCESS_FAILED", `port ${options.port}を使用できません。`, {
          cause: error,
          details: { port: options.port, reason: "address-in-use" },
          suggestions: [
            "起動中のprocessを停止するか、別の--portを指定してください。",
            "一時的に空きportを自動選択する場合は--port 0を指定してください。",
          ],
        }),
      );
    });
  });
}
