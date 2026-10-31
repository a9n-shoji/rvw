import { fork, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RvwService } from "../../src/application/rvw-service.js";
import { createRuntime } from "../../src/application/runtime.js";
import {
  closeOwnedRuntime,
  createProgram,
  createRuntimeAgentSocketHandler,
} from "../../src/cli/main.js";
import {
  AGENT_SOCKET_PROTOCOL_VERSION,
  agentSocketPath,
  dispatchAgentSocketRequest,
  RUNTIME_STOP_OPERATION,
  startRuntimeAgentSocket,
  stopRuntime,
  tryAgentSocketRequest,
} from "../../src/server/agent-socket.js";
import { createApp } from "../../src/server/app.js";
import { startServer } from "../../src/server/start-server.js";

const cliPath = path.resolve("src/cli/main.ts");
const fixturePath = path.resolve("test/fixtures/runtime-lifecycle-process.ts");
const stopOptions = { timeoutMs: 2_000, pollIntervalMs: 5 };
const ownerToken = "11111111-1111-4111-8111-111111111111";
const replacementToken = "22222222-2222-4222-8222-222222222222";

async function canListenOnUnixSocket(): Promise<boolean> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-stop-probe-"));
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path.join(directory, "probe.sock"), resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    console.warn(
      "Unix socket integration tests skipped: this environment rejects listen with EPERM.",
    );
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const unixSocketsAvailable = await canListenOnUnixSocket();

function mockConnectionFailure(code: string, beforeError?: () => void): void {
  vi.spyOn(net, "createConnection").mockImplementation(() => {
    const socket = new net.Socket();
    queueMicrotask(() => {
      beforeError?.();
      socket.emit("error", Object.assign(new Error(code), { code }));
    });
    return socket;
  });
}

function mockSocketResponse(response: unknown, beforeResponse?: () => void) {
  const requests: unknown[] = [];
  vi.spyOn(net, "createConnection").mockImplementation(() => {
    const socket = new net.Socket();
    vi.spyOn(socket, "write").mockImplementation((chunk) => {
      requests.push(JSON.parse(String(chunk)) as unknown);
      queueMicrotask(() => {
        beforeResponse?.();
        socket.emit("data", Buffer.from(`${JSON.stringify(response)}\n`));
        socket.emit("close", false);
      });
      return true;
    });
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  return requests;
}

function mockSocketDisconnection(code: string | null, beforeClose?: () => void) {
  const requests: unknown[] = [];
  vi.spyOn(net, "createConnection").mockImplementation(() => {
    const socket = new net.Socket();
    vi.spyOn(socket, "write").mockImplementation((chunk) => {
      requests.push(JSON.parse(String(chunk)) as unknown);
      queueMicrotask(() => {
        beforeClose?.();
        if (code) socket.emit("error", Object.assign(new Error(code), { code }));
        else socket.emit("close", false);
      });
      return true;
    });
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  return requests;
}

function mockSocketListeners(): void {
  vi.spyOn(net, "createServer").mockImplementation(() => {
    const server = new net.Server();
    server.listen = (...args: unknown[]) => {
      const socketPath = args[0];
      if (typeof socketPath !== "string") throw new Error("Expected a Unix socket path");
      // Give ownership cleanup a real filesystem identity without requiring Unix socket access.
      writeFileSync(socketPath, "mock socket", { flag: "wx", mode: 0o600 });
      queueMicrotask(() => server.emit("listening"));
      return server;
    };
    server.close = (callback) => {
      queueMicrotask(() => callback?.());
      return server;
    };
    return server;
  });
}

function childExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function childReady(child: ChildProcess): Promise<{ url?: string; pid?: number }> {
  return await new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Runtime child readiness timed out: ${stderr}`));
    }, 10_000);
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Runtime child exited ${String(code)}: ${stderr}`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== "object") return;
      const value = message as { type?: string; url?: string; pid?: number; error?: unknown };
      if (value.type === "ready") {
        cleanup();
        resolve(value);
      } else if (value.type === "error") {
        cleanup();
        reject(new Error(`Runtime child startup failed: ${JSON.stringify(value.error)}`));
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      child.off("message", onMessage);
    };
    child.on("exit", onExit);
    child.on("error", onError);
    child.on("message", onMessage);
  });
}

describe("explicit runtime stop", () => {
  let directory: string;
  let databasePath: string;
  let socketPath: string;
  const children: ChildProcess[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "rvw-stop-"));
    databasePath = path.join(directory, "review.db");
    socketPath = path.join(directory, "runtime.sock");
    vi.stubEnv("RVW_DATABASE_PATH", databasePath);
    vi.stubEnv("RVW_AGENT_SOCKET_PATH", socketPath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const child of children.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exiting = childExit(child);
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await exiting;
      clearTimeout(timer);
    }
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  function startChild(modulePath: string, args: string[]): ChildProcess {
    const child = fork(modulePath, args, {
      execArgv: ["--import", "tsx"],
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(child);
    return child;
  }

  async function stopCli(env = process.env) {
    const child = spawn(process.execPath, ["--import", "tsx", cliPath, "stop", "--json"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exit = await childExit(child);
    return { ...exit, stdout, stderr, result: JSON.parse(stdout) as unknown };
  }

  async function fakeSocket(response: string): Promise<void> {
    const server = net.createServer((socket) => {
      socket.once("data", () => socket.end(response));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
  }

  it.skipIf(!unixSocketsAvailable)(
    "is idempotent without creating a database or its directory",
    async () => {
      const missingDatabase = path.join(directory, "never-created", "review.db");
      vi.stubEnv("RVW_DATABASE_PATH", missingDatabase);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await stopCli();
        expect(result.code, result.stderr).toBe(0);
        expect(result.result).toEqual({ ok: true, stopped: false, databasePath: missingDatabase });
      }
      expect(existsSync(path.dirname(missingDatabase))).toBe(false);
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(`${socketPath}.owner`)).toBe(false);
    },
    15_000,
  );

  it("uses the selected database for the default socket without initializing it", async () => {
    mockConnectionFailure("ENOENT");
    vi.stubEnv("RVW_AGENT_SOCKET_PATH", undefined);
    const missingDatabase = path.join(directory, "not-created", "custom.db");
    const defaultSocket = agentSocketPath(missingDatabase);
    expect(defaultSocket).not.toBe(agentSocketPath(path.join(directory, "other.db")));
    await expect(stopRuntime(missingDatabase, stopOptions)).resolves.toEqual({
      ok: true,
      stopped: false,
      databasePath: missingDatabase,
    });
    expect(existsSync(path.dirname(missingDatabase))).toBe(false);
    expect(existsSync(defaultSocket)).toBe(false);
  });

  it.skipIf(!unixSocketsAvailable)(
    "stops a real background CLI runtime and releases HTTP, SQLite, socket, and ownership",
    async () => {
      const worker = startChild(cliPath, [
        "__open-worker",
        "--list",
        "--port",
        "0",
        "--requested-port",
        "0",
      ]);
      const ready = await childReady(worker);
      expect(ready.url).toBeDefined();
      worker.disconnect();
      const origin = new URL(ready.url!).origin;
      expect(existsSync(databasePath)).toBe(true);
      expect(existsSync(`${socketPath}.owner`)).toBe(true);
      expect((await fetch(`${origin}/api/meta/change-sequence`)).status).toBe(200);

      // Even same-origin JSON requests cannot stop a runtime through HTTP.
      for (const endpoint of ["/api/runtime/stop", "/api/stop"]) {
        const response = await fetch(`${origin}${endpoint}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: "{}",
        });
        expect(response.status).toBe(404);
        await response.text();
      }
      expect(worker.exitCode).toBeNull();
      const stopped = await stopCli();
      expect(stopped.code, stopped.stderr).toBe(0);
      expect(stopped.result).toEqual({ ok: true, stopped: true, databasePath });
      await expect(childExit(worker)).resolves.toEqual({ code: 0, signal: null });
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(`${socketPath}.owner`)).toBe(false);
      expect(existsSync(databasePath)).toBe(true);
      expect(existsSync(`${databasePath}-wal`)).toBe(false);
      expect(existsSync(`${databasePath}-shm`)).toBe(false);
      await expect(fetch(`${origin}/api/meta/change-sequence`)).rejects.toThrow();
      expect((await stopCli()).result).toEqual({ ok: true, stopped: false, databasePath });
    },
    20_000,
  );

  it.skipIf(!unixSocketsAvailable)(
    "rejects a mismatched configured database without stopping or mutating its owner",
    async () => {
      const running = await startRuntimeAgentSocket(databasePath);
      cleanups.push(() => running.close());
      const lockBefore = statSync(`${socketPath}.owner`);
      const wrongDatabase = path.join(directory, "wrong.db");
      await expect(stopRuntime(wrongDatabase, stopOptions)).rejects.toMatchObject({
        code: "AGENT_SOCKET_UNAVAILABLE",
        details: { reason: "database-mismatch" },
      });
      expect(statSync(`${socketPath}.owner`).ino).toBe(lockBefore.ino);
      expect(existsSync(wrongDatabase)).toBe(false);
      await expect(
        tryAgentSocketRequest("ping", {}, { expectedDatabasePath: databasePath }),
      ).resolves.toMatchObject({
        available: true,
        result: { ownerPid: process.pid, databasePath },
      });
    },
  );

  it.skipIf(!unixSocketsAvailable)(
    "requires an explicit matching database and strict input for stop requests",
    async () => {
      const running = await startRuntimeAgentSocket(databasePath);
      cleanups.push(() => running.close());
      const { dev, ino } = statSync(`${socketPath}.owner`);
      const { token } = JSON.parse(readFileSync(`${socketPath}.owner`, "utf8")) as {
        token: string;
      };
      await expect(
        tryAgentSocketRequest(RUNTIME_STOP_OPERATION, { ownerIdentity: { dev, ino, token } }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      await expect(
        tryAgentSocketRequest(
          RUNTIME_STOP_OPERATION,
          { force: true },
          { expectedDatabasePath: databasePath },
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        tryAgentSocketRequest(
          RUNTIME_STOP_OPERATION,
          { ownerIdentity: { dev, ino: ino + 1, token } },
          { expectedDatabasePath: databasePath },
        ),
      ).rejects.toMatchObject({ code: "PROCESS_FAILED", details: { reason: "owner-changed" } });
      await expect(
        tryAgentSocketRequest(
          RUNTIME_STOP_OPERATION,
          { ownerIdentity: null },
          { expectedDatabasePath: databasePath },
        ),
      ).rejects.toMatchObject({ code: "PROCESS_FAILED", details: { reason: "owner-changed" } });
      await expect(
        tryAgentSocketRequest(
          RUNTIME_STOP_OPERATION,
          { ownerIdentity: { dev, ino, token: replacementToken } },
          { expectedDatabasePath: databasePath },
        ),
      ).rejects.toMatchObject({ code: "PROCESS_FAILED", details: { reason: "owner-changed" } });
      await expect(
        tryAgentSocketRequest(
          RUNTIME_STOP_OPERATION,
          { ownerIdentity: { dev, ino, token: null } },
          { expectedDatabasePath: databasePath },
        ),
      ).rejects.toMatchObject({ code: "PROCESS_FAILED", details: { reason: "owner-changed" } });
      await expect(
        tryAgentSocketRequest("ping", {}, { expectedDatabasePath: databasePath }),
      ).resolves.toMatchObject({ available: true });
    },
  );

  it.skipIf(!unixSocketsAvailable)(
    "lets concurrent stop commands converge on the same runtime shutdown",
    async () => {
      const worker = startChild(cliPath, [
        "__open-worker",
        "--list",
        "--port",
        "0",
        "--requested-port",
        "0",
      ]);
      await childReady(worker);
      worker.disconnect();
      const results = await Promise.all([stopCli(), stopCli(), stopCli()]);
      for (const result of results) {
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(result.result).toMatchObject({ ok: true, databasePath });
      }
      expect(results.some((result) => (result.result as { stopped: boolean }).stopped)).toBe(true);
      await expect(childExit(worker)).resolves.toEqual({ code: 0, signal: null });
      expect(existsSync(`${socketPath}.owner`)).toBe(false);
    },
    20_000,
  );

  it.skipIf(!unixSocketsAvailable)(
    "waits for an in-flight agent request and runtime cleanup before returning success",
    async () => {
      const runtime = createRuntime({ database: { filePath: databasePath } });
      const server = await startServer(runtime.service, { port: 0 });
      const running = await startRuntimeAgentSocket(databasePath);
      running.setHandler(createRuntimeAgentSocketHandler(runtime, server));
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      vi.spyOn(runtime.service, "doctor").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return { completed: true } as unknown as Awaited<ReturnType<RvwService["doctor"]>>;
      });
      const close = vi.spyOn(runtime, "close");
      const cleanupState: { closing?: Promise<void> } = {};
      cleanups.push(async () => {
        release.resolve();
        await (cleanupState.closing ?? closeOwnedRuntime(running, server, runtime));
      });
      const request = tryAgentSocketRequest(
        "doctor",
        { cwd: directory },
        { expectedDatabasePath: databasePath },
      );
      await entered.promise;
      let settled = false;
      const stopping = stopRuntime(databasePath, stopOptions).then((result) => {
        settled = true;
        return result;
      });
      await running.stopRequested;
      cleanupState.closing = closeOwnedRuntime(running, server, runtime);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      expect(close).not.toHaveBeenCalled();
      expect(existsSync(`${socketPath}.owner`)).toBe(true);
      release.resolve();
      await expect(request).resolves.toEqual({ available: true, result: { completed: true } });
      await expect(stopping).resolves.toEqual({ ok: true, stopped: true, databasePath });
      await cleanupState.closing;
      expect(close).toHaveBeenCalledOnce();
      expect(existsSync(`${socketPath}.owner`)).toBe(false);
    },
  );

  it.skipIf(!unixSocketsAvailable)(
    "drains an accepted agent operation even after its client disconnects",
    async () => {
      const runtime = createRuntime({ database: { filePath: databasePath } });
      const server = await startServer(runtime.service, { port: 0 });
      const running = await startRuntimeAgentSocket(databasePath);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let operationFinished = false;
      running.setHandler({
        service: runtime.service,
        openViewer: async () => {
          entered.resolve();
          await release.promise;
          runtime.database.getRevisionSnapshot();
          operationFinished = true;
          return {
            url: server.origin,
            origin: server.origin,
            port: server.port,
            pullRequestId: null,
            ownerPid: process.pid,
          };
        },
      });
      const cleanupState: { closing?: Promise<void> } = {};
      const client = net.createConnection(socketPath);
      client.on("error", () => undefined);
      cleanups.push(async () => {
        client.destroy();
        release.resolve();
        await (cleanupState.closing ?? closeOwnedRuntime(running, server, runtime));
      });
      client.once("connect", () => {
        client.write(
          `${JSON.stringify({ protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION, operation: "viewer.open", input: { list: true, cwd: directory, requestedPort: 0 }, expectedDatabasePath: databasePath })}\n`,
        );
      });
      await entered.promise;
      const disconnected = new Promise<void>((resolve) => client.once("close", () => resolve()));
      client.destroy();
      await disconnected;
      const close = vi.spyOn(runtime, "close");
      let settled = false;
      const stopping = stopRuntime(databasePath, stopOptions).then((result) => {
        settled = true;
        return result;
      });
      await running.stopRequested;
      cleanupState.closing = closeOwnedRuntime(running, server, runtime);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      expect(operationFinished).toBe(false);
      expect(close).not.toHaveBeenCalled();
      expect(existsSync(`${socketPath}.owner`)).toBe(true);
      release.resolve();
      await expect(stopping).resolves.toEqual({ ok: true, stopped: true, databasePath });
      await cleanupState.closing;
      expect(operationFinished).toBe(true);
      expect(close).toHaveBeenCalledOnce();
      expect(existsSync(`${socketPath}.owner`)).toBe(false);
    },
  );

  it("does not signal an unrelated live process recorded in an owner lock", async () => {
    mockConnectionFailure("ENOENT");
    const unrelated = startChild(fixturePath, ["idle"]);
    const ready = await childReady(unrelated);
    const owner = `${JSON.stringify({ pid: ready.pid, token: ownerToken })}\n`;
    writeFileSync(`${socketPath}.owner`, owner, { mode: 0o600 });
    const kill = vi.spyOn(process, "kill");
    await expect(
      stopRuntime(databasePath, { timeoutMs: 40, pollIntervalMs: 5 }),
    ).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
    expect(unrelated.exitCode).toBeNull();
    expect(readFileSync(`${socketPath}.owner`, "utf8")).toBe(owner);
    expect(kill).toHaveBeenCalled();
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(existsSync(databasePath)).toBe(false);
  }, 15_000);

  it.skipIf(!unixSocketsAvailable)(
    "reclaims an abandoned Unix socket and dead owner without opening the database",
    async () => {
      const stale = startChild(fixturePath, ["stale-socket", socketPath]);
      await childReady(stale);
      const exiting = childExit(stale);
      stale.kill("SIGKILL");
      await exiting;
      expect(existsSync(socketPath)).toBe(true);
      expect(existsSync(`${socketPath}.owner`)).toBe(true);
      await expect(stopRuntime(databasePath, stopOptions)).resolves.toEqual({
        ok: true,
        stopped: false,
        databasePath,
      });
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(`${socketPath}.owner`)).toBe(false);
      expect(existsSync(databasePath)).toBe(false);
    },
    15_000,
  );

  it("preserves an unreadable owner record and a non-socket file", async () => {
    mockConnectionFailure("ECONNREFUSED");
    writeFileSync(`${socketPath}.owner`, "not JSON", { mode: 0o600 });
    await expect(stopRuntime(databasePath, stopOptions)).rejects.toMatchObject({
      code: "AGENT_SOCKET_UNAVAILABLE",
      details: { reason: "unreadable-owner" },
    });
    expect(readFileSync(`${socketPath}.owner`, "utf8")).toBe("not JSON");
    rmSync(`${socketPath}.owner`);
    writeFileSync(socketPath, "unrelated file");
    await expect(stopRuntime(databasePath, stopOptions)).rejects.toMatchObject({
      code: "AGENT_SOCKET_UNAVAILABLE",
      details: { reason: "not-a-socket" },
    });
    expect(readFileSync(socketPath, "utf8")).toBe("unrelated file");
  });

  it("fails closed on permission errors without deleting an owner or creating a database", async () => {
    writeFileSync(`${socketPath}.owner`, JSON.stringify({ pid: process.pid, token: ownerToken }), {
      mode: 0o600,
    });
    const ownerBefore = readFileSync(`${socketPath}.owner`, "utf8");
    vi.spyOn(net, "createConnection").mockImplementation(() => {
      const socket = new net.Socket();
      queueMicrotask(() =>
        socket.emit("error", Object.assign(new Error("denied"), { code: "EACCES" })),
      );
      return socket;
    });
    await expect(stopRuntime(databasePath, stopOptions)).rejects.toMatchObject({
      code: "AGENT_SOCKET_UNAVAILABLE",
      details: { reason: "permission-denied" },
    });
    expect(readFileSync(`${socketPath}.owner`, "utf8")).toBe(ownerBefore);
    expect(existsSync(databasePath)).toBe(false);
  });

  it.skipIf(!unixSocketsAvailable).each([
    ["empty response without a known owner", "", "PROCESS_FAILED"],
    ["malformed response", "not JSON\n", "PROCESS_FAILED"],
    ["invalid stop acknowledgement", '{"ok":true,"result":{}}\n', "AGENT_SOCKET_UNAVAILABLE"],
    [
      "old protocol",
      JSON.stringify({
        ok: false,
        error: { code: "STALE_PROTOCOL", message: "old runtime", suggestions: [] },
      }) + "\n",
      "STALE_PROTOCOL",
    ],
  ])("rejects a %s without removing the listening socket", async (_name, response, code) => {
    await fakeSocket(response);
    const before = statSync(socketPath);
    await expect(stopRuntime(databasePath, stopOptions)).rejects.toMatchObject({ code });
    expect(statSync(socketPath).ino).toBe(before.ino);
    expect(existsSync(databasePath)).toBe(false);
  });

  it("does not expose runtime stop as an ordinary agent operation", async () => {
    const service = { database: { filePath: databasePath } } as unknown as RvwService;
    await expect(
      dispatchAgentSocketRequest(service, {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        operation: RUNTIME_STOP_OPERATION,
        input: {},
        expectedDatabasePath: databasePath,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("runs the stop CLI action without initializing a runtime or creating directories", async () => {
    mockConnectionFailure("ENOENT");
    const missingDatabase = path.join(directory, "never-created", "review.db");
    vi.stubEnv("RVW_DATABASE_PATH", missingDatabase);
    const runtimeFactory = vi.fn(() => {
      throw new Error("stop must not create a runtime");
    });
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await createProgram(runtimeFactory).parseAsync(["node", "rvw", "stop", "--json"]);
    }
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(output.mock.calls).toEqual([
      [JSON.stringify({ ok: true, stopped: false, databasePath: missingDatabase }) + "\n"],
      [JSON.stringify({ ok: true, stopped: false, databasePath: missingDatabase }) + "\n"],
    ]);
    expect(existsSync(path.dirname(missingDatabase))).toBe(false);
  });

  it("accepts a concurrently removed owner lock without treating it as unreadable", async () => {
    writeFileSync(`${socketPath}.owner`, JSON.stringify({ pid: process.pid, token: ownerToken }), {
      mode: 0o600,
    });
    mockConnectionFailure("ENOENT", () => rmSync(`${socketPath}.owner`));
    await expect(stopRuntime(databasePath, stopOptions)).resolves.toEqual({
      ok: true,
      stopped: false,
      databasePath,
    });
    expect(existsSync(databasePath)).toBe(false);
  });

  it.each([null, "ECONNRESET", "EPIPE"])(
    "waits for the pinned owner to disappear after a response-less disconnect (%s)",
    async (code) => {
      writeFileSync(
        `${socketPath}.owner`,
        JSON.stringify({ pid: process.pid, token: ownerToken }),
        {
          mode: 0o600,
        },
      );
      const requests = mockSocketDisconnection(code);
      let settled = false;
      const stopping = stopRuntime(databasePath, stopOptions).then((result) => {
        settled = true;
        return result;
      });
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      expect(settled).toBe(false);
      rmSync(`${socketPath}.owner`);
      await expect(stopping).resolves.toEqual({ ok: true, stopped: false, databasePath });
      expect(requests).toHaveLength(1);
      expect(existsSync(databasePath)).toBe(false);
    },
  );

  it("times out rather than claiming success when a disconnected owner remains live", async () => {
    writeFileSync(`${socketPath}.owner`, JSON.stringify({ pid: process.pid, token: ownerToken }), {
      mode: 0o600,
    });
    const requests = mockSocketDisconnection(null);
    await expect(
      stopRuntime(databasePath, { timeoutMs: 40, pollIntervalMs: 5 }),
    ).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
    expect(requests).toHaveLength(1);
    expect(existsSync(`${socketPath}.owner`)).toBe(true);
  });

  it("rejects a replacement owner after a response-less disconnect without resending stop", async () => {
    writeFileSync(`${socketPath}.owner`, JSON.stringify({ pid: process.pid, token: ownerToken }), {
      mode: 0o600,
    });
    const requests = mockSocketDisconnection(null, () => {
      writeFileSync(
        `${socketPath}.owner`,
        JSON.stringify({ pid: process.pid, token: replacementToken }),
      );
    });
    await expect(stopRuntime(databasePath, stopOptions)).rejects.toMatchObject({
      code: "AGENT_SOCKET_UNAVAILABLE",
      details: { reason: "owner-changed" },
    });
    expect(requests).toHaveLength(1);
    expect(JSON.parse(readFileSync(`${socketPath}.owner`, "utf8"))).toEqual({
      pid: process.pid,
      token: replacementToken,
    });
  });

  it("rejects a response-less disconnect when a socket remains after its owner disappears", async () => {
    writeFileSync(`${socketPath}.owner`, JSON.stringify({ pid: process.pid, token: ownerToken }));
    writeFileSync(socketPath, "remaining socket path");
    const requests = mockSocketDisconnection(null, () => rmSync(`${socketPath}.owner`));
    await expect(stopRuntime(databasePath, stopOptions)).rejects.toMatchObject({
      code: "PROCESS_FAILED",
      details: { agentSocketOutcomeUncertain: true },
    });
    expect(requests).toHaveLength(1);
    expect(readFileSync(socketPath, "utf8")).toBe("remaining socket path");
  });

  it("still rejects malformed responses from a known owner", async () => {
    writeFileSync(`${socketPath}.owner`, JSON.stringify({ pid: process.pid, token: ownerToken }));
    mockSocketResponse("malformed");
    await expect(stopRuntime(databasePath, stopOptions)).rejects.toMatchObject({
      code: "PROCESS_FAILED",
      details: { agentSocketOutcomeUncertain: true },
    });
    expect(existsSync(`${socketPath}.owner`)).toBe(true);
  });

  it("pins the owner in the stop request and waits for its exact lock to be released", async () => {
    writeFileSync(`${socketPath}.owner`, JSON.stringify({ pid: process.pid, token: ownerToken }), {
      mode: 0o600,
    });
    const { dev, ino } = statSync(`${socketPath}.owner`);
    const requests = mockSocketResponse({
      ok: true,
      result: {
        databasePath,
        ownerPid: process.pid,
        ownerIdentity: { dev, ino, token: ownerToken },
      },
    });
    let settled = false;
    const stopping = stopRuntime(databasePath, stopOptions).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(settled).toBe(false);
    expect(requests).toEqual([
      {
        protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        operation: RUNTIME_STOP_OPERATION,
        input: { ownerIdentity: { dev, ino, token: ownerToken } },
        expectedDatabasePath: databasePath,
      },
    ]);
    rmSync(`${socketPath}.owner`);
    await expect(stopping).resolves.toEqual({ ok: true, stopped: true, databasePath });
  });

  it("rejects an acknowledgement from a different owner inode without releasing the owner", async () => {
    writeFileSync(`${socketPath}.owner`, JSON.stringify({ pid: process.pid, token: ownerToken }), {
      mode: 0o600,
    });
    const { dev, ino } = statSync(`${socketPath}.owner`);
    mockSocketResponse({
      ok: true,
      result: {
        databasePath,
        ownerPid: process.pid,
        ownerIdentity: { dev, ino: ino + 1, token: ownerToken },
      },
    });
    await expect(stopRuntime(databasePath, stopOptions)).rejects.toMatchObject({
      code: "AGENT_SOCKET_UNAVAILABLE",
      details: { reason: "invalid-stop-response" },
    });
    expect(statSync(`${socketPath}.owner`).ino).toBe(ino);
  });

  it("does not stop or remove a replacement owner after the original owner acknowledges", async () => {
    writeFileSync(`${socketPath}.owner`, JSON.stringify({ pid: process.pid, token: ownerToken }), {
      mode: 0o600,
    });
    const { dev, ino } = statSync(`${socketPath}.owner`);
    const replacement = `${socketPath}.replacement`;
    writeFileSync(replacement, JSON.stringify({ pid: process.pid, token: ownerToken }), {
      mode: 0o600,
    });
    const replacementInode = statSync(replacement).ino;
    const requests = mockSocketResponse(
      {
        ok: true,
        result: {
          databasePath,
          ownerPid: process.pid,
          ownerIdentity: { dev, ino, token: ownerToken },
        },
      },
      () => renameSync(replacement, `${socketPath}.owner`),
    );
    await expect(stopRuntime(databasePath, stopOptions)).resolves.toEqual({
      ok: true,
      stopped: true,
      databasePath,
    });
    expect(statSync(`${socketPath}.owner`).ino).toBe(replacementInode);
    expect(requests).toHaveLength(1);
  });

  it("fails closed when the owner is replaced during a failed connection", async () => {
    writeFileSync(`${socketPath}.owner`, JSON.stringify({ pid: process.pid, token: ownerToken }), {
      mode: 0o600,
    });
    const replacement = `${socketPath}.replacement`;
    writeFileSync(replacement, JSON.stringify({ pid: process.pid, token: ownerToken }), {
      mode: 0o600,
    });
    const replacementInode = statSync(replacement).ino;
    mockConnectionFailure("ECONNREFUSED", () => renameSync(replacement, `${socketPath}.owner`));
    await expect(stopRuntime(databasePath, stopOptions)).rejects.toMatchObject({
      code: "AGENT_SOCKET_UNAVAILABLE",
      details: { reason: "owner-changed" },
    });
    expect(statSync(`${socketPath}.owner`).ino).toBe(replacementInode);
    expect(net.createConnection).toHaveBeenCalledOnce();
  });

  it("recognizes a replacement token even when the owner file keeps the same device and inode", async () => {
    writeFileSync(`${socketPath}.owner`, JSON.stringify({ pid: process.pid, token: ownerToken }), {
      mode: 0o600,
    });
    const { dev, ino } = statSync(`${socketPath}.owner`);
    const requests = mockSocketResponse(
      {
        ok: true,
        result: {
          databasePath,
          ownerPid: process.pid,
          ownerIdentity: { dev, ino, token: ownerToken },
        },
      },
      () =>
        writeFileSync(
          `${socketPath}.owner`,
          JSON.stringify({ pid: process.pid, token: replacementToken }),
        ),
    );
    await expect(stopRuntime(databasePath, stopOptions)).resolves.toEqual({
      ok: true,
      stopped: true,
      databasePath,
    });
    expect(statSync(`${socketPath}.owner`)).toMatchObject({ dev, ino });
    expect(JSON.parse(readFileSync(`${socketPath}.owner`, "utf8"))).toEqual({
      pid: process.pid,
      token: replacementToken,
    });
    expect(requests).toHaveLength(1);
  });

  it("fails closed when only the token changes during a failed connection", async () => {
    writeFileSync(`${socketPath}.owner`, JSON.stringify({ pid: process.pid, token: ownerToken }), {
      mode: 0o600,
    });
    const { dev, ino } = statSync(`${socketPath}.owner`);
    mockConnectionFailure("ECONNREFUSED", () =>
      writeFileSync(
        `${socketPath}.owner`,
        JSON.stringify({ pid: process.pid, token: replacementToken }),
      ),
    );
    await expect(stopRuntime(databasePath, stopOptions)).rejects.toMatchObject({
      code: "AGENT_SOCKET_UNAVAILABLE",
      details: { reason: "owner-changed" },
    });
    expect(statSync(`${socketPath}.owner`)).toMatchObject({ dev, ino });
    expect(JSON.parse(readFileSync(`${socketPath}.owner`, "utf8"))).toEqual({
      pid: process.pid,
      token: replacementToken,
    });
    expect(net.createConnection).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "UUID owners", token: ownerToken, nextToken: replacementToken },
    { label: "legacy owners", token: undefined, nextToken: undefined },
  ])(
    "preserves a same-inode replacement after stop's dead-PID probe ($label)",
    async ({ token, nextToken }) => {
      const deadPid = process.pid + 1;
      const nextPid = token === undefined ? process.pid : deadPid;
      const lockPath = `${socketPath}.owner`;
      writeFileSync(lockPath, JSON.stringify({ pid: deadPid, token }), { mode: 0o600 });
      const { dev, ino } = statSync(lockPath);
      mockConnectionFailure("ECONNREFUSED");
      let probes = 0;
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        expect(pid).toBe(deadPid);
        expect(signal).toBe(0);
        // Model inode reuse by another runtime after the observed owner's liveness check.
        // Legacy owners also receive an earlier probe before the socket request.
        probes += 1;
        if (probes === (token === undefined ? 2 : 1)) {
          writeFileSync(lockPath, JSON.stringify({ pid: nextPid, token: nextToken }));
        }
        throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      });

      await expect(stopRuntime(databasePath, stopOptions)).resolves.toEqual({
        ok: true,
        stopped: false,
        databasePath,
      });
      expect(statSync(lockPath)).toMatchObject({ dev, ino });
      expect(readFileSync(lockPath, "utf8")).toBe(
        JSON.stringify({ pid: nextPid, token: nextToken }),
      );
      expect(kill).toHaveBeenCalledTimes(token === undefined ? 2 : 1);
      expect(net.createConnection).toHaveBeenCalledOnce();
      expect(existsSync(databasePath)).toBe(false);
    },
  );

  it("preserves a same-inode live replacement during startup's dead-owner recovery", async () => {
    const deadPid = process.pid + 1;
    const lockPath = `${socketPath}.owner`;
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, token: ownerToken }), { mode: 0o600 });
    const { dev, ino } = statSync(lockPath);
    mockSocketListeners();
    let replacementPublished = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(signal).toBe(0);
      expect(pid).toBe(deadPid);
      if (replacementPublished) return true;
      replacementPublished = true;
      // Reuse the PID as well as the inode, requiring the UUID to distinguish this owner.
      writeFileSync(lockPath, JSON.stringify({ pid: deadPid, token: replacementToken }));
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });

    const contender = await startRuntimeAgentSocket(databasePath);
    cleanups.push(() => contender.close());
    expect(contender.owned).toBe(false);
    expect(statSync(lockPath)).toMatchObject({ dev, ino });
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual({
      pid: deadPid,
      token: replacementToken,
    });
    expect(kill).toHaveBeenCalledWith(deadPid, 0);
    expect(net.createServer).not.toHaveBeenCalled();
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(databasePath)).toBe(false);
  });

  it("preserves a same-inode replacement owner when the previous runtime releases ownership", async () => {
    mockSocketListeners();
    const runtime = await startRuntimeAgentSocket(databasePath);
    cleanups.push(() => runtime.close());
    expect(runtime.owned).toBe(true);
    const lockPath = `${socketPath}.owner`;
    const { dev, ino } = statSync(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: replacementToken }));

    await runtime.releaseOwnership();

    expect(runtime.owned).toBe(false);
    expect(statSync(lockPath)).toMatchObject({ dev, ino });
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual({
      pid: process.pid,
      token: replacementToken,
    });
    expect(existsSync(databasePath)).toBe(false);
  });

  it("lets only one concurrent startup reclaim the same stale owner", async () => {
    const deadPid = process.pid + 1;
    const lockPath = `${socketPath}.owner`;
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, token: ownerToken }), { mode: 0o600 });
    mockSocketListeners();
    let competingStartup: ReturnType<typeof startRuntimeAgentSocket> | undefined;
    let startingCompetitor = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(signal).toBe(0);
      if (pid === process.pid) return true;
      expect(pid).toBe(deadPid);
      if (!startingCompetitor) {
        startingCompetitor = true;
        // Both contenders have observed the dead PID before either can finish reclamation.
        competingStartup = startRuntimeAgentSocket(databasePath);
      }
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });

    const first = await startRuntimeAgentSocket(databasePath);
    cleanups.push(() => first.close());
    expect(competingStartup).toBeDefined();
    const second = await competingStartup!;
    cleanups.push(() => second.close());
    expect(kill.mock.calls.filter(([pid]) => pid === deadPid)).toHaveLength(2);
    expect(first.owned).toBe(false);
    expect(second.owned).toBe(true);
    expect(net.createServer).toHaveBeenCalledOnce();
    const winningRecord = readFileSync(lockPath, "utf8");
    expect(JSON.parse(winningRecord)).toMatchObject({ pid: process.pid });
    expect(JSON.parse(winningRecord)).not.toMatchObject({ token: ownerToken });

    await first.close();
    expect(readFileSync(lockPath, "utf8")).toBe(winningRecord);
    await second.close();
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(databasePath)).toBe(false);
  });

  it("rejects an acknowledgement with the correct inode but a different token", async () => {
    writeFileSync(`${socketPath}.owner`, JSON.stringify({ pid: process.pid, token: ownerToken }), {
      mode: 0o600,
    });
    const { dev, ino } = statSync(`${socketPath}.owner`);
    mockSocketResponse({
      ok: true,
      result: {
        databasePath,
        ownerPid: process.pid,
        ownerIdentity: { dev, ino, token: replacementToken },
      },
    });
    await expect(stopRuntime(databasePath, stopOptions)).rejects.toMatchObject({
      code: "AGENT_SOCKET_UNAVAILABLE",
      details: { reason: "invalid-stop-response" },
    });
    expect(JSON.parse(readFileSync(`${socketPath}.owner`, "utf8"))).toEqual({
      pid: process.pid,
      token: ownerToken,
    });
  });

  it.each([undefined, "malformed-token"])(
    "preserves a live owner with an invalid token (%s)",
    async (token) => {
      mockConnectionFailure("ENOENT");
      const record = JSON.stringify({ pid: process.pid, token });
      writeFileSync(`${socketPath}.owner`, record, { mode: 0o600 });
      await expect(stopRuntime(databasePath, stopOptions)).rejects.toMatchObject({
        code: "AGENT_SOCKET_UNAVAILABLE",
        details: { reason: "missing-owner-token" },
      });
      expect(net.createConnection).not.toHaveBeenCalled();
      expect(readFileSync(`${socketPath}.owner`, "utf8")).toBe(record);
      expect(existsSync(databasePath)).toBe(false);
    },
  );

  it("reclaims a dead legacy owner without a token", async () => {
    mockConnectionFailure("ENOENT");
    const legacy = startChild(fixturePath, ["idle"]);
    const ready = await childReady(legacy);
    const exiting = childExit(legacy);
    legacy.kill("SIGTERM");
    await exiting;
    writeFileSync(`${socketPath}.owner`, JSON.stringify({ pid: ready.pid }), { mode: 0o600 });
    await expect(stopRuntime(databasePath, stopOptions)).resolves.toEqual({
      ok: true,
      stopped: false,
      databasePath,
    });
    expect(existsSync(`${socketPath}.owner`)).toBe(false);
    expect(existsSync(databasePath)).toBe(false);
  });

  it("has no same-origin HTTP stop endpoint", async () => {
    const runtime = createRuntime({ database: { filePath: ":memory:" } });
    const origin = "http://127.0.0.1:4321";
    const app = createApp(runtime.service, {
      security: { expectedHost: "127.0.0.1:4321", expectedOrigin: origin },
    });
    try {
      for (const endpoint of ["/api/runtime/stop", "/api/stop"]) {
        const response = await app.request(`${origin}${endpoint}`, {
          method: "POST",
          headers: { host: "127.0.0.1:4321", "content-type": "application/json", origin },
          body: "{}",
        });
        expect(response.status).toBe(404);
      }
      expect(runtime.database.getRevisionSnapshot()).toBeDefined();
    } finally {
      runtime.close();
    }
  });
});
