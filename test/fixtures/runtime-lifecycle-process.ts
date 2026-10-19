import { writeFileSync } from "node:fs";
import net from "node:net";

if (!process.send) throw new Error("IPC is required");

const mode = process.argv[2];
if (mode === "stale-socket") {
  const socketPath = process.argv[3];
  if (!socketPath) throw new Error("socket path is required");
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  writeFileSync(`${socketPath}.owner`, `${JSON.stringify({ pid: process.pid })}\n`, {
    mode: 0o600,
  });
  process.once("SIGTERM", () => server.close(() => process.disconnect?.()));
} else if (mode === "idle") {
  // The IPC channel deliberately keeps an unrelated process alive.
  process.once("SIGTERM", () => process.disconnect?.());
  process.once("disconnect", () => undefined);
} else {
  throw new Error(`Unsupported fixture mode: ${String(mode)}`);
}

process.send({ type: "ready", pid: process.pid });
