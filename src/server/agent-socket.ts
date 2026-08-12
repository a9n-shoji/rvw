import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import envPaths from "env-paths";
import { z } from "zod";
import {
  agentCommandInputSchemas,
  type AgentCommandOperation,
} from "../application/agent-command-schemas.js";
import type { RvwService } from "../application/rvw-service.js";
import type { SerializedRvwError } from "../shared/errors.js";
import { asRvwError, RvwError } from "../shared/errors.js";

// pr sync may contain hundreds of valid 64 KiB replies. Reserve framing space above the stdin cap.
export const MAX_CLI_STDIN_BYTES = 40 * 1024 * 1024;
export const MAX_AGENT_MESSAGE_BYTES = MAX_CLI_STDIN_BYTES + 64 * 1024;
const AGENT_SOCKET_PROTOCOL_VERSION = 1;
const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 180_000;
const DEFAULT_TAKEOVER_RETRY_MS = 1_000;
const REQUEST_IDLE_TIMEOUT_MS = 30_000;

export interface AgentRequest {
  protocolVersion: number;
  operation: string;
  input: unknown;
  expectedDatabasePath?: string;
}

type AgentResponse = { ok: true; result: unknown } | { ok: false; error: SerializedRvwError };

export interface AgentSocketResult<T> {
  available: boolean;
  result?: T;
}

export interface RunningAgentSocket {
  path: string;
  readonly owned: boolean;
  close(): Promise<void>;
}

interface AgentSocketClientOptions {
  expectedDatabasePath?: string;
  connectTimeoutMs?: number;
  operationTimeoutMs?: number;
  socketPath?: string;
}

interface AgentSocketServerOptions {
  takeoverRetryMs?: number;
}

interface SocketIdentity {
  dev: number;
  ino: number;
}

const agentRequestEnvelopeSchema = z
  .object({
    protocolVersion: z.number().int(),
    operation: z.string().min(1),
    input: z.unknown(),
    expectedDatabasePath: z.string().min(1).optional(),
  })
  .strict();

export function agentSocketPath(databaseFilePath?: string): string {
  if (process.env.RVW_AGENT_SOCKET_PATH) return path.resolve(process.env.RVW_AGENT_SOCKET_PATH);
  const user = process.getuid?.() ?? os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, "_");
  const databasePath = path.resolve(databaseFilePath ?? path.join(envPaths("rvw").data, "rvw.db"));
  const databaseKey = createHash("sha256").update(databasePath).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `rvw-agent-${user}`, `${databaseKey}.sock`);
}

function ensurePrivateSocketDirectory(socketPath: string): void {
  const directory = path.dirname(socketPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  const currentUid = process.getuid?.();
  const mode = stat.mode & 0o777;
  if (
    !stat.isDirectory() ||
    (process.platform !== "win32" &&
      (mode !== 0o700 || (currentUid !== undefined && stat.uid !== currentUid)))
  ) {
    throw new RvwError("DATABASE_ERROR", "Agent socket directoryが安全ではありません。", {
      details: {
        path: directory,
        mode: mode.toString(8).padStart(4, "0"),
        expectedMode: "0700",
        owner: stat.uid,
        expectedOwner: currentUid,
      },
      suggestions: [`${directory} のownerと権限を確認してください。`],
    });
  }
}

function invalidSocketInput(error: z.ZodError): RvwError {
  return new RvwError("INVALID_INPUT", "Agent socket inputがschemaに一致しません。", {
    details: { issues: error.issues },
  });
}

function parseRequest(value: unknown): AgentRequest {
  const parsed = agentRequestEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw invalidSocketInput(parsed.error);
  return {
    protocolVersion: parsed.data.protocolVersion,
    operation: parsed.data.operation,
    input: parsed.data.input,
    ...(parsed.data.expectedDatabasePath === undefined
      ? {}
      : { expectedDatabasePath: parsed.data.expectedDatabasePath }),
  };
}

type AgentCommandInput<Operation extends AgentCommandOperation> = z.output<
  (typeof agentCommandInputSchemas)[Operation]
>;

function parseOperationInput<Operation extends AgentCommandOperation>(
  operation: Operation,
  value: unknown,
): AgentCommandInput<Operation> {
  const parsed = agentCommandInputSchemas[operation].safeParse(value);
  if (!parsed.success) throw invalidSocketInput(parsed.error);
  return parsed.data as AgentCommandInput<Operation>;
}

export async function dispatchAgentSocketRequest(
  service: RvwService,
  rawRequest: AgentRequest,
): Promise<unknown> {
  const request = parseRequest(rawRequest);
  if (request.protocolVersion !== AGENT_SOCKET_PROTOCOL_VERSION) {
    throw new RvwError("STALE_PROTOCOL", "Agent socket protocol versionが一致しません。");
  }
  if (
    request.expectedDatabasePath !== undefined &&
    path.resolve(request.expectedDatabasePath) !== path.resolve(service.database.filePath)
  ) {
    throw new RvwError("DATABASE_ERROR", "Agent socketが別のdatabaseを使用しています。", {
      details: {
        agentSocketDatabaseMismatch: true,
        expectedDatabasePath: path.resolve(request.expectedDatabasePath),
        actualDatabasePath: path.resolve(service.database.filePath),
      },
    });
  }
  if (request.operation === "ping") {
    const ping = z.object({}).strict().safeParse(request.input);
    if (!ping.success) throw invalidSocketInput(ping.error);
    return { protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION };
  }
  if (!Object.hasOwn(agentCommandInputSchemas, request.operation)) {
    throw new RvwError("INVALID_INPUT", `未対応のAgent socket operationです: ${request.operation}`);
  }
  const operation = request.operation as AgentCommandOperation;
  switch (operation) {
    case "doctor": {
      const input = parseOperationInput("doctor", request.input);
      return await service.doctor(input.cwd);
    }
    case "pr.refresh": {
      const input = parseOperationInput("pr.refresh", request.input);
      return await service.refreshByReference(input.reference);
    }
    case "pr.sync": {
      const input = parseOperationInput("pr.sync", request.input);
      return await service.syncPullRequest(
        input as unknown as Parameters<RvwService["syncPullRequest"]>[0],
      );
    }
    case "pr.attach": {
      const input = parseOperationInput("pr.attach", request.input);
      return await service.attachPullRequest(input.reference, input.repositoryPath);
    }
    case "pr.reset.preview": {
      const input = parseOperationInput("pr.reset.preview", request.input);
      const pullRequest = service.resolveStoredPullRequest(input.reference);
      return await service.getResetPreview(pullRequest.id);
    }
    case "pr.reset": {
      const input = parseOperationInput("pr.reset", request.input);
      const pullRequest = service.resolveStoredPullRequest(input.reference);
      return await service.resetPullRequest(pullRequest.id);
    }
    case "comment.list": {
      const input = parseOperationInput("comment.list", request.input);
      return await service.listCommentReviewContexts(input.reference, input.resolved, {
        limit: input.limit,
        offset: input.offset,
      });
    }
    case "comment.get": {
      const input = parseOperationInput("comment.get", request.input);
      return await service.getCommentReviewContext(input.uri, { live: input.live });
    }
    case "comment.reply": {
      const input = parseOperationInput("comment.reply", request.input);
      return await service.replyToComment(
        input.uri,
        input.reply as unknown as Parameters<RvwService["replyToComment"]>[1],
      );
    }
    case "comment.resolve": {
      const input = parseOperationInput("comment.resolve", request.input);
      return service.setCommentResolved(input.uri, true);
    }
    case "comment.reopen": {
      const input = parseOperationInput("comment.reopen", request.input);
      return service.setCommentResolved(input.uri, false);
    }
    case "walkthrough.get": {
      const input = parseOperationInput("walkthrough.get", request.input);
      return service.getWalkthroughByUri(input.uri);
    }
    case "walkthrough.publish": {
      const input = parseOperationInput("walkthrough.publish", request.input);
      return await service.publishWalkthrough(
        input as Parameters<RvwService["publishWalkthrough"]>[0],
      );
    }
    case "walkthrough.update": {
      const input = parseOperationInput("walkthrough.update", request.input);
      return await service.updateWalkthrough(
        input.uri,
        input.content as unknown as Parameters<RvwService["updateWalkthrough"]>[1],
      );
    }
    case "walkthrough.delete.preview": {
      const input = parseOperationInput("walkthrough.delete.preview", request.input);
      return service.getWalkthroughDeletePreview(input.uri);
    }
    case "walkthrough.delete": {
      const input = parseOperationInput("walkthrough.delete", request.input);
      return service.deleteWalkthroughByUri(input.uri);
    }
  }
}

function parseResponse(value: string): AgentResponse {
  const parsed = JSON.parse(value) as AgentResponse;
  if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") {
    throw new Error("invalid agent socket response");
  }
  return parsed;
}

function uncertainOutcome(operation: string, cause: unknown, timedOut = false): RvwError {
  return new RvwError(
    timedOut ? "PROCESS_TIMEOUT" : "PROCESS_FAILED",
    `Agent socket operation ${operation} の完了結果を確認できません。自動再実行はしていません。`,
    {
      cause,
      details: { agentSocketOutcomeUncertain: true, operation },
      suggestions: [
        "現在のコメント・Walkthrough・PR同期状態を読み直し、未反映の場合だけ再実行してください。",
      ],
    },
  );
}

export async function tryAgentSocketRequest<T>(
  operation: string,
  input: unknown,
  options: AgentSocketClientOptions = {},
): Promise<AgentSocketResult<T>> {
  const socketPath = options.socketPath ?? agentSocketPath(options.expectedDatabasePath);
  return await new Promise<AgentSocketResult<T>>((resolve, reject) => {
    let settled = false;
    let connected = false;
    let requestSent = false;
    let operationTimer: NodeJS.Timeout | undefined;
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let bytes = 0;
    const clearTimers = (): void => {
      clearTimeout(connectTimer);
      if (operationTimer) clearTimeout(operationTimer);
    };
    const finishUnavailable = (): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      socket.destroy();
      resolve({ available: false });
    };
    const rejectUncertain = (cause: unknown, timedOut = false): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      socket.destroy();
      reject(uncertainOutcome(operation, cause, timedOut));
    };
    const connectTimer = setTimeout(
      finishUnavailable,
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
    socket.on("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      operationTimer = setTimeout(
        () => rejectUncertain(new Error("agent socket operation timed out"), true),
        options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      );
      let payload: string;
      try {
        payload = `${JSON.stringify({
          protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
          operation,
          input,
          ...(options.expectedDatabasePath === undefined
            ? {}
            : { expectedDatabasePath: options.expectedDatabasePath }),
        })}\n`;
      } catch (error) {
        settled = true;
        clearTimers();
        socket.destroy();
        reject(
          new RvwError("INVALID_INPUT", "Agent socket requestをJSONへ変換できません。", {
            cause: error,
          }),
        );
        return;
      }
      requestSent = true;
      socket.write(payload);
    });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_AGENT_MESSAGE_BYTES) {
        rejectUncertain(new Error("agent socket response is too large"));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (!connected && ["ENOENT", "ECONNREFUSED", "EACCES", "EPERM"].includes(error.code ?? "")) {
        finishUnavailable();
        return;
      }
      if (requestSent || connected) rejectUncertain(error);
      else if (!settled) {
        settled = true;
        clearTimers();
        reject(error);
      }
    });
    socket.on("close", () => {
      if (settled) return;
      clearTimers();
      if (!connected || !requestSent) {
        finishUnavailable();
        return;
      }
      try {
        const response = parseResponse(Buffer.concat(chunks).toString("utf8").trim());
        settled = true;
        if (!response.ok) {
          const errorDetails = response.error.details as Record<string, unknown> | null | undefined;
          if (errorDetails?.agentSocketDatabaseMismatch === true) {
            resolve({ available: false });
            return;
          }
          reject(
            new RvwError(response.error.code, response.error.message, {
              suggestions: response.error.suggestions,
              details: response.error.details,
            }),
          );
          return;
        }
        resolve({ available: true, result: response.result as T });
      } catch (error) {
        reject(uncertainOutcome(operation, error));
      }
    });
  });
}

async function activeSocketExists(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  try {
    return (
      await tryAgentSocketRequest(
        "ping",
        {},
        {
          connectTimeoutMs: 500,
          operationTimeoutMs: 1_000,
          socketPath,
        },
      )
    ).available;
  } catch {
    // A connected peer that returns an error (including an older protocol) still owns the path.
    return true;
  }
}

function socketIdentity(socketPath: string): SocketIdentity | null {
  try {
    const stat = lstatSync(socketPath);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function unlinkIfOwned(socketPath: string, identity: SocketIdentity | null): void {
  const current = socketIdentity(socketPath);
  if (!identity || !current || current.dev !== identity.dev || current.ino !== identity.ino) return;
  try {
    unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function createAgentServer(service: RvwService): net.Server {
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let handled = false;
    socket.on("error", () => {
      // Client disconnects must not terminate the viewer process.
    });
    socket.setTimeout(REQUEST_IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      bytes += chunk.length;
      if (bytes > MAX_AGENT_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      // Every earlier chunk was already checked before it was retained.
      if (!chunk.includes(10)) return;
      handled = true;
      socket.setTimeout(0);
      void (async () => {
        let response: AgentResponse;
        try {
          const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          response = {
            ok: true,
            result: await dispatchAgentSocketRequest(service, parseRequest(request)),
          };
        } catch (error) {
          response = { ok: false, error: asRvwError(error).toJSON() };
        }
        socket.end(`${JSON.stringify(response)}\n`);
      })();
    });
  });
  server.maxConnections = 16;
  return server;
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

export async function startAgentSocket(
  service: RvwService,
  options: AgentSocketServerOptions = {},
): Promise<RunningAgentSocket> {
  const socketPath = agentSocketPath(service.database.filePath);
  ensurePrivateSocketDirectory(socketPath);
  const retryDelay = options.takeoverRetryMs ?? DEFAULT_TAKEOVER_RETRY_MS;
  let server: net.Server | null = null;
  let identity: SocketIdentity | null = null;
  let retryTimer: NodeJS.Timeout | undefined;
  let acquisition: Promise<void> | null = null;
  let closed = false;

  const scheduleTakeover = (): void => {
    if (closed || server || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void acquire().catch(() => scheduleTakeover());
    }, retryDelay);
    retryTimer.unref();
  };

  const acquire = async (): Promise<void> => {
    if (closed || server || acquisition) return await (acquisition ?? Promise.resolve());
    acquisition = (async () => {
      const observedIdentity = socketIdentity(socketPath);
      if (observedIdentity) {
        if (await activeSocketExists(socketPath)) {
          scheduleTakeover();
          return;
        }
        // Only remove the exact stale inode that was probed. A concurrent owner may have replaced it.
        unlinkIfOwned(socketPath, observedIdentity);
      }
      const candidate = createAgentServer(service);
      try {
        await listen(candidate, socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          scheduleTakeover();
          return;
        }
        throw error;
      }
      if (closed) {
        const candidateIdentity = socketIdentity(socketPath);
        await new Promise<void>((resolve) => candidate.close(() => resolve()));
        unlinkIfOwned(socketPath, candidateIdentity);
        return;
      }
      try {
        chmodSync(socketPath, 0o600);
      } catch (error) {
        const candidateIdentity = socketIdentity(socketPath);
        await new Promise<void>((resolve) => candidate.close(() => resolve()));
        unlinkIfOwned(socketPath, candidateIdentity);
        throw error;
      }
      server = candidate;
      identity = socketIdentity(socketPath);
      candidate.on("error", () => {
        if (server !== candidate) return;
        const failedIdentity = identity;
        server = null;
        identity = null;
        candidate.close(() => {
          unlinkIfOwned(socketPath, failedIdentity);
          scheduleTakeover();
        });
      });
    })();
    try {
      await acquisition;
    } finally {
      acquisition = null;
    }
  };

  await acquire();
  return {
    path: socketPath,
    get owned() {
      return server !== null;
    },
    close: async () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      await acquisition;
      const ownedServer = server;
      const ownedIdentity = identity;
      server = null;
      identity = null;
      if (!ownedServer) return;
      await new Promise<void>((resolve, reject) =>
        ownedServer.close((error) => (error ? reject(error) : resolve())),
      );
      unlinkIfOwned(socketPath, ownedIdentity);
    },
  };
}
