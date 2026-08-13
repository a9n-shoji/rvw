import type { RvwService } from "../../src/application/rvw-service.js";
import { startAgentSocket } from "../../src/server/agent-socket.js";

const databasePath = process.argv[2];
if (!databasePath || !process.send) throw new Error("database path and IPC are required");

let running: Awaited<ReturnType<typeof startAgentSocket>> | null = null;
try {
  running = await startAgentSocket(
    {
      database: { filePath: databasePath },
    } as unknown as RvwService,
    { takeoverRetryMs: 20 },
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  process.send?.({ type: "unsupported", code: "EPERM", pid: process.pid });
  process.disconnect?.();
}

if (running) {
  process.send?.({ type: "ready", owned: running.owned, pid: process.pid });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await running?.close();
    process.disconnect?.();
  };

  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const command = message as { type?: unknown; requestId?: unknown };
    if (command.type === "status" && typeof command.requestId === "number") {
      process.send?.({
        type: "status",
        requestId: command.requestId,
        owned: running?.owned ?? false,
        pid: process.pid,
      });
    } else if (command.type === "close") {
      void close();
    }
  });
  process.once("disconnect", () => void close());
}
