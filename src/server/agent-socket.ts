import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  agentCommandInputSchemas,
  type AgentCommandOperation,
} from "../application/agent-command-schemas.js";
import type { RvwService } from "../application/rvw-service.js";
import { databasePathConfiguration } from "../infrastructure/db/database.js";
import type { SerializedRvwError } from "../shared/errors.js";
import { asRvwError, RvwError } from "../shared/errors.js";

// pr sync may contain hundreds of valid 64 KiB replies. Reserve framing space above the stdin cap.
export const MAX_CLI_STDIN_BYTES = 40 * 1024 * 1024;
export const MAX_AGENT_MESSAGE_BYTES = MAX_CLI_STDIN_BYTES + 64 * 1024;
export const AGENT_SOCKET_PROTOCOL_VERSION = 8;
export const RUNTIME_VIEWER_OPEN_OPERATION = "viewer.open";
export const RUNTIME_STOP_OPERATION = "runtime.stop";
const AGENT_SOCKET_RESTART_SUGGESTION =
  "起動中のrvw viewerを停止し、更新後のrvw openで再起動してください。";
const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 180_000;
const DEFAULT_TAKEOVER_RETRY_MS = 1_000;
const REQUEST_IDLE_TIMEOUT_MS = 30_000;
const OWNER_LOCK_SUFFIX = ".owner";

export interface AgentRequest {
  protocolVersion: number;
  operation: string;
  input: unknown;
  expectedDatabasePath?: string;
}

type AgentResponse = { ok: true; result: unknown } | { ok: false; error: SerializedRvwError };

export type AgentSocketUnavailableReason =
  | "socket-not-found"
  | "connection-refused"
  | "permission-denied"
  | "connection-error"
  | "connect-timeout"
  | "connection-closed"
  | "database-mismatch";

export type AgentSocketResult<T> =
  | { available: true; result: T }
  | {
      available: false;
      reason: AgentSocketUnavailableReason;
      details?: unknown;
    };

export interface AgentPingResult {
  protocolVersion: number;
  databasePath: string;
  ownerPid: number;
}

export interface AgentTransportStatus {
  socketPath: string;
  socketPathSource: "default" | "configured";
  explicitSocketPath: boolean;
  connectionResult: "connected" | AgentSocketUnavailableReason;
  connected: boolean;
  expectedDatabasePath: string;
  socketDatabasePath: string | null;
  socketOwnerPid: number | null;
  selectedTransport: "agent-socket" | "direct-database" | "unavailable";
  selectedDatabasePath: string;
  fallbackReason: AgentSocketUnavailableReason | null;
  connectionDetails: Record<string, unknown> | null;
}

export interface RunningAgentSocket {
  path: string;
  readonly owned: boolean;
  close(): Promise<void>;
}

export interface RuntimeViewerOpenInput {
  reference?: string;
  list?: boolean;
  cwd: string;
  requestedPort: number;
}

export interface RuntimeViewerOpenResult {
  url: string;
  origin: string;
  port: number;
  pullRequestId: string | null;
  ownerPid: number;
}

export interface RuntimeAgentSocketHandler {
  service: RvwService;
  openViewer(input: RuntimeViewerOpenInput): Promise<RuntimeViewerOpenResult>;
}

export interface RunningRuntimeAgentSocket extends RunningAgentSocket {
  readonly stopRequested: Promise<void>;
  requestStop(): void;
  setHandler(handler: RuntimeAgentSocketHandler): void;
  stopAccepting(): Promise<void>;
  releaseOwnership(): Promise<void>;
}

interface AgentSocketClientOptions {
  expectedDatabasePath?: string;
  connectTimeoutMs?: number;
  operationTimeoutMs?: number;
  socketPath?: string;
  requireSocket?: boolean;
}

interface AgentSocketServerOptions {
  takeoverRetryMs?: number;
}

interface AgentSocketListenerOptions extends AgentSocketServerOptions {
  retryOwnership: boolean;
}

interface RunningAgentSocketListener extends RunningAgentSocket {
  readonly ownerIdentity: SocketOwnerIdentity | null;
  stopAccepting(): Promise<void>;
  releaseOwnership(): Promise<void>;
}

interface SocketIdentity {
  dev: number;
  ino: number;
}

interface SocketOwnerIdentity extends SocketIdentity {
  token: string | null;
}

interface SocketOwnerLock {
  identity: SocketIdentity;
  path: string;
  token: string;
}

const agentRequestEnvelopeSchema = z
  .object({
    protocolVersion: z.number().int(),
    operation: z.string().min(1),
    input: z.unknown(),
    expectedDatabasePath: z.string().min(1).optional(),
  })
  .strict();

const runtimeViewerOpenInputSchema = z
  .object({
    reference: z.string().min(1).optional(),
    list: z.boolean().optional(),
    cwd: z.string().min(1),
    requestedPort: z.number().int().min(0).max(65_535),
  })
  .strict()
  .refine((input) => !input.list || input.reference === undefined, {
    message: "一覧起動にはPRを指定できません。",
  });

const runtimeViewerOpenResultSchema = z
  .object({
    url: z.string().url(),
    origin: z.string().url(),
    port: z.number().int().min(1).max(65_535),
    pullRequestId: z.string().min(1).nullable(),
    ownerPid: z.number().int().positive(),
  })
  .strict();

export function explicitAgentSocketPath(): string | null {
  const configuredPath = process.env.RVW_AGENT_SOCKET_PATH;
  if (configuredPath === undefined) return null;
  if (configuredPath.trim().length === 0) {
    throw new RvwError("INVALID_INPUT", "RVW_AGENT_SOCKET_PATHは空にできません。");
  }
  return path.resolve(configuredPath);
}

export function agentSocketPath(databaseFilePath?: string): string {
  const configuredPath = explicitAgentSocketPath();
  if (configuredPath) return configuredPath;
  const user = process.getuid?.() ?? os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, "_");
  const databasePath = path.resolve(databaseFilePath ?? databasePathConfiguration().filePath);
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

function resolveDatabaseIdentity(databaseFilePath: string): string {
  return databaseFilePath === ":memory:" ? databaseFilePath : path.resolve(databaseFilePath);
}

function validateAgentRequest(rawRequest: AgentRequest, databaseFilePath?: string): AgentRequest {
  const request = parseRequest(rawRequest);
  if (request.protocolVersion !== AGENT_SOCKET_PROTOCOL_VERSION) {
    throw new RvwError("STALE_PROTOCOL", "Agent socket protocol versionが一致しません。", {
      details: {
        expectedProtocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
        receivedProtocolVersion: request.protocolVersion,
      },
      suggestions: [AGENT_SOCKET_RESTART_SUGGESTION],
    });
  }
  if (
    request.expectedDatabasePath !== undefined &&
    databaseFilePath !== undefined &&
    resolveDatabaseIdentity(request.expectedDatabasePath) !==
      resolveDatabaseIdentity(databaseFilePath)
  ) {
    throw new RvwError("DATABASE_ERROR", "Agent socketが別のdatabaseを使用しています。", {
      details: {
        agentSocketDatabaseMismatch: true,
        expectedDatabasePath: resolveDatabaseIdentity(request.expectedDatabasePath),
        actualDatabasePath: resolveDatabaseIdentity(databaseFilePath),
      },
    });
  }
  return request;
}

function pingResult(databaseFilePath: string): AgentPingResult {
  return {
    protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
    databasePath: resolveDatabaseIdentity(databaseFilePath),
    ownerPid: process.pid,
  };
}

export async function dispatchAgentSocketRequest(
  service: RvwService,
  rawRequest: AgentRequest,
): Promise<unknown> {
  const request = validateAgentRequest(rawRequest, service.database?.filePath);
  if (request.operation === "ping") {
    const ping = z.object({}).strict().safeParse(request.input);
    if (!ping.success) throw invalidSocketInput(ping.error);
    return pingResult(service.database.filePath);
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
    case "pr.list": {
      return service.listPullRequests(parseOperationInput("pr.list", request.input));
    }
    case "pr.archive": {
      const input = parseOperationInput("pr.archive", request.input);
      return service.setPullRequestArchived(
        service.resolveStoredPullRequest(input.reference).id,
        input.archived,
      );
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
    case "walkthrough.list": {
      const input = parseOperationInput("walkthrough.list", request.input);
      return service.listWalkthroughsByReference(input.reference, {
        limit: input.limit,
        offset: input.offset,
      });
    }
    case "comment.watch": {
      const input = parseOperationInput("comment.watch", request.input);
      return service.listCommentPostEvents(input.cursor, input.limit);
    }
    case "comment.watch.activate": {
      const input = parseOperationInput("comment.watch.activate", request.input);
      return service.activateCommentWatchTask(input.taskId);
    }
    case "comment.watch.verify": {
      const input = parseOperationInput("comment.watch.verify", request.input);
      return service.verifyCommentWatchTask(input.taskId, input.generation);
    }
    case "comment.watch.reserveWrite": {
      const input = parseOperationInput("comment.watch.reserveWrite", request.input);
      return service.reserveCommentWatchWriter(
        input.taskId,
        input.generation,
        input.leaseId,
        input.writeKey,
      );
    }
    case "comment.watch.releaseWrite": {
      const input = parseOperationInput("comment.watch.releaseWrite", request.input);
      return service.releaseCommentWatchWriter(input.taskId, input.generation, input.leaseId);
    }
    case "comment.create": {
      const input = parseOperationInput("comment.create", request.input);
      return await service.createCommentForReference(
        input as Parameters<RvwService["createCommentForReference"]>[0],
      );
    }
    case "comment.get": {
      const input = parseOperationInput("comment.get", request.input);
      return await service.getCommentReviewContext(input.uri, { live: input.live });
    }
    case "comment.reply": {
      const input = parseOperationInput("comment.reply", request.input);
      return await service.replyToComment(input.uri, {
        ...(input.reply as unknown as Parameters<RvwService["replyToComment"]>[1]),
        lastModifiedBy: "agent",
      });
    }
    case "comment.edit": {
      const input = parseOperationInput("comment.edit", request.input);
      return await service.editCommentPost(input.uri, input.postId, {
        body: input.edit.body,
        ...(input.edit.relatedCommitOid === undefined
          ? {}
          : { relatedCommitOid: input.edit.relatedCommitOid }),
        ...(input.edit.references === undefined ? {} : { references: input.edit.references }),
        ...(input.edit.watchTask === undefined ? {} : { watchTask: input.edit.watchTask }),
        lastModifiedBy: "agent",
      });
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
    case "structure.get": {
      const input = parseOperationInput("structure.get", request.input);
      return service.getStructureByUri(input.uri);
    }
    case "structure.list": {
      const input = parseOperationInput("structure.list", request.input);
      return service.listStructuresByReference(input.reference);
    }
    case "structure.publish": {
      const input = parseOperationInput("structure.publish", request.input);
      return await service.publishStructure(input);
    }
    case "structure.update": {
      const input = parseOperationInput("structure.update", request.input);
      return await service.updateStructure(input.uri, input.content);
    }
    case "structure.delete.preview": {
      const input = parseOperationInput("structure.delete.preview", request.input);
      return service.getStructureDeletePreview(input.uri);
    }
    case "structure.delete": {
      const input = parseOperationInput("structure.delete", request.input);
      return service.deleteStructureByUri(input.uri, input.expectedUpdatedAt);
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
      suggestions:
        operation === "structure.publish"
          ? [
              "同じidempotencyKeyと同じpayloadでpublishを再実行すると、既存のStructureへ収束します。",
              "rvw structure list <PR> --jsonでもstable URIを確認できます。",
            ]
          : [
              "現在のコメント・Walkthrough・Structure・PR同期状態を読み直し、未反映の場合だけ再実行してください。",
            ],
    },
  );
}

function requiredSocketUnavailable(
  socketPath: string,
  expectedDatabasePath: string | undefined,
  reason: AgentSocketUnavailableReason,
  details?: unknown,
): RvwError {
  return new RvwError(
    "AGENT_SOCKET_UNAVAILABLE",
    "明示されたAgent socketへ接続できないため、databaseへfallbackしません。",
    {
      details: {
        agentSocketRequired: true,
        socketPath,
        connectionResult: reason,
        selectedTransport: "unavailable",
        fallbackReason: null,
        ...(expectedDatabasePath === undefined
          ? {}
          : { expectedDatabasePath: path.resolve(expectedDatabasePath) }),
        ...(details === undefined ? {} : { causeDetails: details }),
      },
      suggestions: [
        "rvw agent ping --json または rvw agent status --json で接続先を確認してください。",
        "対象databaseを使うviewerを起動するか、RVW_AGENT_SOCKET_PATHを解除してください。",
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
  const requireSocket = options.requireSocket ?? explicitAgentSocketPath() !== null;
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
    const finishUnavailable = (reason: AgentSocketUnavailableReason, details?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      socket.destroy();
      if (requireSocket) {
        reject(
          requiredSocketUnavailable(socketPath, options.expectedDatabasePath, reason, details),
        );
      } else {
        resolve({
          available: false,
          reason,
          ...(details === undefined ? {} : { details }),
        });
      }
    };
    const rejectUncertain = (cause: unknown, timedOut = false): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      socket.destroy();
      reject(uncertainOutcome(operation, cause, timedOut));
    };
    const connectTimer = setTimeout(
      () => finishUnavailable("connect-timeout"),
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
      if (!connected && error.code === "ENOENT") {
        finishUnavailable("socket-not-found", { code: error.code });
        return;
      }
      if (!connected && error.code === "ECONNREFUSED") {
        finishUnavailable("connection-refused", { code: error.code });
        return;
      }
      if (!connected && ["EACCES", "EPERM"].includes(error.code ?? "")) {
        finishUnavailable("permission-denied", { code: error.code });
        return;
      }
      if (!connected) {
        finishUnavailable("connection-error", {
          code: error.code ?? null,
          message: error.message,
        });
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
        finishUnavailable("connection-closed");
        return;
      }
      try {
        const response = parseResponse(Buffer.concat(chunks).toString("utf8").trim());
        settled = true;
        if (!response.ok) {
          const errorDetails = response.error.details as Record<string, unknown> | null | undefined;
          if (errorDetails?.agentSocketDatabaseMismatch === true) {
            const reason = "database-mismatch" as const;
            if (requireSocket) {
              reject(
                requiredSocketUnavailable(
                  socketPath,
                  options.expectedDatabasePath,
                  reason,
                  response.error.details,
                ),
              );
            } else {
              resolve({ available: false, reason, details: response.error.details });
            }
            return;
          }
          const suggestions =
            response.error.code === "STALE_PROTOCOL"
              ? [
                  ...new Set([
                    ...(response.error.suggestions ?? []),
                    AGENT_SOCKET_RESTART_SUGGESTION,
                  ]),
                ]
              : response.error.suggestions;
          reject(
            new RvwError(response.error.code, response.error.message, {
              suggestions,
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

export async function tryRuntimeViewerOpen(
  input: RuntimeViewerOpenInput,
  databaseFilePath = databasePathConfiguration().filePath,
  options: Pick<AgentSocketClientOptions, "connectTimeoutMs" | "operationTimeoutMs"> = {},
): Promise<AgentSocketResult<RuntimeViewerOpenResult>> {
  const parsedInput = runtimeViewerOpenInputSchema.safeParse(input);
  if (!parsedInput.success) throw invalidSocketInput(parsedInput.error);
  const response = await tryAgentSocketRequest<unknown>(
    RUNTIME_VIEWER_OPEN_OPERATION,
    parsedInput.data,
    {
      expectedDatabasePath: databaseFilePath,
      requireSocket: false,
      ...options,
    },
  );
  if (!response.available) return response;
  const parsedResult = runtimeViewerOpenResultSchema.safeParse(response.result);
  if (!parsedResult.success) {
    throw new RvwError("PROCESS_FAILED", "起動中のrvw runtimeから不正な応答を受信しました。", {
      details: { issues: parsedResult.error.issues },
      suggestions: [AGENT_SOCKET_RESTART_SUGGESTION],
    });
  }
  return {
    available: true,
    result: {
      url: parsedResult.data.url,
      origin: parsedResult.data.origin,
      port: parsedResult.data.port,
      pullRequestId: parsedResult.data.pullRequestId,
      ownerPid: parsedResult.data.ownerPid,
    },
  };
}

export interface RuntimeStopResult {
  ok: true;
  stopped: boolean;
  databasePath: string;
}

const socketIdentitySchema = z
  .object({
    dev: z.number().int(),
    ino: z.number().int(),
    token: z.uuid().nullable(),
  })
  .strict();
const runtimeStopInputSchema = z
  .object({ ownerIdentity: socketIdentitySchema.nullable() })
  .strict();
const runtimeStopAcceptedSchema = z
  .object({
    databasePath: z.string(),
    ownerPid: z.number().int().positive(),
    ownerIdentity: socketIdentitySchema.extend({ token: z.uuid() }),
  })
  .strict();

function sameIdentity(left: SocketIdentity | null, right: SocketIdentity | null): boolean {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

function sameOwnerIdentity(
  left: SocketOwnerIdentity | null,
  right: SocketOwnerIdentity | null,
): boolean {
  return sameIdentity(left, right) && left?.token === right?.token;
}

/** Stop only the database-matched owner over its private socket. Never signal a recorded PID. */
export async function stopRuntime(
  databaseFilePath = databasePathConfiguration().filePath,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<RuntimeStopResult> {
  const databasePath = resolveDatabaseIdentity(databaseFilePath);
  const socketPath = agentSocketPath(databaseFilePath);
  const lockPath = `${socketPath}${OWNER_LOCK_SUFFIX}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const wait = async (): Promise<void> => {
    if (Date.now() >= deadline) {
      throw new RvwError("PROCESS_TIMEOUT", "rvw serverの停止完了を確認できませんでした。", {
        details: { databasePath, socketPath, timeoutMs },
        suggestions: ["rvw agent status --jsonで状態を確認してください。強制終了はしていません。"],
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 50));
  };
  const unavailable = (reason: string, details?: unknown): RvwError =>
    new RvwError("AGENT_SOCKET_UNAVAILABLE", "対象のrvw serverを安全に停止できませんでした。", {
      details: { databasePath, socketPath, reason, causeDetails: details },
      suggestions: ["rvw agent status --jsonで接続先とdatabaseを確認してください。"],
    });

  const inspectIdentity = (targetPath: string): SocketIdentity | null => {
    try {
      const stat = lstatSync(targetPath);
      return { dev: stat.dev, ino: stat.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw unavailable("identity-unreadable", {
        path: targetPath,
        code: (error as NodeJS.ErrnoException).code,
      });
    }
  };
  const inspectOwnerIdentity = (): SocketOwnerIdentity | null => {
    try {
      return socketOwnerIdentity(lockPath);
    } catch (error) {
      throw unavailable("identity-unreadable", {
        path: lockPath,
        code: (error as NodeJS.ErrnoException).code,
      });
    }
  };

  const removeStaleSocket = (identity: SocketIdentity | null): void => {
    if (!identity || !sameIdentity(inspectIdentity(socketPath), identity)) return;
    try {
      if (!lstatSync(socketPath).isSocket()) throw unavailable("not-a-socket");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    unlinkIfOwned(socketPath, identity);
  };

  // Pin the selected owner across startup/shutdown retries. Never stop a replacement owner.
  let targetOwner = inspectOwnerIdentity();
  while (true) {
    const observedSocket = inspectIdentity(socketPath);
    const observedOwner = inspectOwnerIdentity();
    if (targetOwner && !sameOwnerIdentity(targetOwner, observedOwner)) {
      if (observedOwner) throw unavailable("owner-changed");
      return { ok: true, stopped: false, databasePath };
    }
    targetOwner ??= observedOwner;
    if (targetOwner?.token === null) {
      const pid = socketOwnerPid(lockPath);
      if (pid !== null && processIsAlive(pid)) throw unavailable("missing-owner-token");
    }
    const response = await tryAgentSocketRequest<unknown>(
      RUNTIME_STOP_OPERATION,
      { ownerIdentity: targetOwner },
      {
        expectedDatabasePath: databasePath,
        socketPath,
        requireSocket: false,
        connectTimeoutMs: Math.min(DEFAULT_CONNECT_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
        operationTimeoutMs: Math.max(1, deadline - Date.now()),
      },
    );
    if (response.available) {
      const parsed = runtimeStopAcceptedSchema.safeParse(response.result);
      if (
        !parsed.success ||
        parsed.data.databasePath !== databasePath ||
        !sameOwnerIdentity(targetOwner, parsed.data.ownerIdentity)
      ) {
        throw unavailable("invalid-stop-response");
      }
      // Ownership is released only after socket/HTTP drainage and Runtime/SQLite cleanup.
      // A replacement owner has a different token, even when its inode is reused.
      while (sameOwnerIdentity(inspectOwnerIdentity(), parsed.data.ownerIdentity)) await wait();
      return { ok: true, stopped: true, databasePath };
    }
    if (!["socket-not-found", "connection-refused"].includes(response.reason)) {
      throw unavailable(response.reason, response.details);
    }
    const currentOwner = inspectOwnerIdentity();
    if (observedOwner && currentOwner === null) {
      return { ok: true, stopped: false, databasePath };
    }
    if (currentOwner && !sameOwnerIdentity(currentOwner, observedOwner)) {
      throw unavailable("owner-changed");
    }
    if (observedOwner) {
      const ownerPid = socketOwnerPid(lockPath);
      if (ownerPid === null) throw unavailable("unreadable-owner");
      if (processIsAlive(ownerPid)) {
        await wait();
        continue;
      }
      // Recheck the dead owner token as well as its inode, as on startup.
      removeStaleSocket(observedSocket);
      unlinkOwnerIfOwned(lockPath, observedOwner, ownerPid);
    } else {
      removeStaleSocket(observedSocket);
    }
    return { ok: true, stopped: false, databasePath };
  }
}

export async function inspectAgentTransport(
  databaseFilePath = databasePathConfiguration().filePath,
): Promise<AgentTransportStatus> {
  const expectedDatabasePath =
    databaseFilePath === ":memory:" ? databaseFilePath : path.resolve(databaseFilePath);
  const configuredSocketPath = explicitAgentSocketPath();
  const socketPath = configuredSocketPath ?? agentSocketPath(expectedDatabasePath);
  const response = await tryAgentSocketRequest<AgentPingResult>(
    "ping",
    {},
    {
      socketPath,
      expectedDatabasePath,
      requireSocket: false,
    },
  );
  if (response.available) {
    return {
      socketPath,
      socketPathSource: configuredSocketPath ? "configured" : "default",
      explicitSocketPath: configuredSocketPath !== null,
      connectionResult: "connected",
      connected: true,
      expectedDatabasePath,
      socketDatabasePath: response.result.databasePath,
      socketOwnerPid: response.result.ownerPid,
      selectedTransport: "agent-socket",
      selectedDatabasePath: response.result.databasePath,
      fallbackReason: null,
      connectionDetails: null,
    };
  }
  const connectionDetails =
    response.details !== null &&
    typeof response.details === "object" &&
    !Array.isArray(response.details)
      ? (response.details as Record<string, unknown>)
      : response.details === undefined
        ? null
        : { value: response.details };
  const mismatchDetails = connectionDetails;
  const socketDatabasePath =
    typeof mismatchDetails?.actualDatabasePath === "string"
      ? mismatchDetails.actualDatabasePath
      : null;
  const explicitSocket = configuredSocketPath !== null;
  return {
    socketPath,
    socketPathSource: explicitSocket ? "configured" : "default",
    explicitSocketPath: explicitSocket,
    connectionResult: response.reason,
    connected: false,
    expectedDatabasePath,
    socketDatabasePath,
    socketOwnerPid: null,
    selectedTransport: explicitSocket ? "unavailable" : "direct-database",
    selectedDatabasePath: expectedDatabasePath,
    fallbackReason: explicitSocket ? null : response.reason,
    connectionDetails,
  };
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
          requireSocket: false,
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

function socketOwnerIdentity(lockPath: string): SocketOwnerIdentity | null {
  try {
    const { dev, ino } = lstatSync(lockPath);
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) return { dev, ino, token: null };
      throw error;
    }
    const token = z.object({ token: z.uuid() }).safeParse(record);
    return { dev, ino, token: token.success ? token.data.token : null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function unlinkOwnerIfOwned(
  lockPath: string,
  identity: SocketOwnerIdentity | null,
  ownerPid: number,
): void {
  if (
    !identity ||
    !sameOwnerIdentity(socketOwnerIdentity(lockPath), identity) ||
    socketOwnerPid(lockPath) !== ownerPid
  ) {
    return;
  }
  // Recheck the inode after reading the token. This is a best-effort identity guard, not an atomic
  // compare-and-unlink: a separate process can still replace the path between the check and unlink.
  unlinkIfOwned(lockPath, identity);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function socketOwnerPid(lockPath: string): number | null {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    return typeof value.pid === "number" && Number.isInteger(value.pid) ? value.pid : null;
  } catch {
    return null;
  }
}

function tryAcquireSocketOwnerLock(socketPath: string): SocketOwnerLock | null {
  const lockPath = `${socketPath}${OWNER_LOCK_SUFFIX}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    const stagingPath = `${lockPath}.${process.pid}.${token}.tmp`;
    try {
      writeFileSync(stagingPath, `${JSON.stringify({ pid: process.pid, token })}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      chmodSync(stagingPath, 0o600);
      linkSync(stagingPath, lockPath);
    } catch (error) {
      try {
        unlinkSync(stagingPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let observedIdentity: SocketOwnerIdentity | null;
      try {
        observedIdentity = socketOwnerIdentity(lockPath);
      } catch {
        // Preserve an owner whose identity cannot be read safely.
        return null;
      }
      const ownerPid = socketOwnerPid(lockPath);
      // An unreadable lock is kept rather than risking two live owners.
      if (ownerPid === null || processIsAlive(ownerPid)) return null;
      unlinkOwnerIfOwned(lockPath, observedIdentity, ownerPid);
      continue;
    }
    try {
      const identity = socketIdentity(lockPath);
      if (!identity) throw new Error("Agent socket owner lockを確認できませんでした。");
      unlinkSync(stagingPath);
      return { identity, path: lockPath, token };
    } catch (error) {
      const identity = socketIdentity(stagingPath);
      unlinkOwnerIfOwned(lockPath, identity ? { ...identity, token } : null, process.pid);
      try {
        unlinkSync(stagingPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
      throw error;
    }
  }
  return null;
}

function releaseSocketOwnerLock(lock: SocketOwnerLock | null): void {
  if (!lock) return;
  unlinkOwnerIfOwned(lock.path, { ...lock.identity, token: lock.token }, process.pid);
}

type AgentSocketDispatcher = (request: AgentRequest) => Promise<unknown>;

type AgentServer = net.Server & { drainRequests(): Promise<void> };

function createAgentServer(dispatch: AgentSocketDispatcher): AgentServer {
  const pendingRequests = new Set<Promise<void>>();
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
      const pending = (async () => {
        let response: AgentResponse;
        try {
          const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          response = {
            ok: true,
            result: await dispatch(parseRequest(request)),
          };
        } catch (error) {
          response = { ok: false, error: asRvwError(error).toJSON() };
        }
        socket.end(`${JSON.stringify(response)}\n`);
      })();
      pendingRequests.add(pending);
      const completed = (): void => {
        pendingRequests.delete(pending);
      };
      void pending.then(completed, completed);
    });
  });
  server.maxConnections = 16;
  return Object.assign(server, {
    async drainRequests(): Promise<void> {
      // A client can disconnect while its accepted operation is still using Runtime/SQLite.
      // net.Server.close alone waits for connections, not these dispatch promises.
      while (pendingRequests.size > 0) await Promise.allSettled(pendingRequests);
    },
  });
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

async function startAgentSocketListener(
  databaseFilePath: string,
  dispatch: AgentSocketDispatcher,
  options: AgentSocketListenerOptions,
): Promise<RunningAgentSocketListener> {
  const socketPath = agentSocketPath(databaseFilePath);
  ensurePrivateSocketDirectory(socketPath);
  const retryDelay = options.takeoverRetryMs ?? DEFAULT_TAKEOVER_RETRY_MS;
  let server: AgentServer | null = null;
  let identity: SocketIdentity | null = null;
  let ownerLock: SocketOwnerLock | null = null;
  let retryTimer: NodeJS.Timeout | undefined;
  let acquisition: Promise<void> | null = null;
  let listenerDrain: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let releasePromise: Promise<void> | null = null;
  let closed = false;

  const scheduleTakeover = (): void => {
    if (!options.retryOwnership || closed || server || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void acquire().catch(() => scheduleTakeover());
    }, retryDelay);
    retryTimer.unref();
  };

  const acquire = async (): Promise<void> => {
    if (closed || server || acquisition) return await (acquisition ?? Promise.resolve());
    acquisition = (async () => {
      const candidateLock = tryAcquireSocketOwnerLock(socketPath);
      if (!candidateLock) {
        scheduleTakeover();
        return;
      }
      const observedIdentity = socketIdentity(socketPath);
      if (observedIdentity) {
        if (await activeSocketExists(socketPath)) {
          releaseSocketOwnerLock(candidateLock);
          scheduleTakeover();
          return;
        }
        // Only remove the exact stale inode that was probed. A concurrent owner may have replaced it.
        try {
          unlinkIfOwned(socketPath, observedIdentity);
        } catch (error) {
          releaseSocketOwnerLock(candidateLock);
          throw error;
        }
      }
      const candidate = createAgentServer(dispatch);
      try {
        await listen(candidate, socketPath);
      } catch (error) {
        releaseSocketOwnerLock(candidateLock);
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          scheduleTakeover();
          return;
        }
        throw error;
      }
      if (closed) {
        const candidateIdentity = socketIdentity(socketPath);
        await new Promise<void>((resolve) => candidate.close(() => resolve()));
        await candidate.drainRequests();
        unlinkIfOwned(socketPath, candidateIdentity);
        releaseSocketOwnerLock(candidateLock);
        return;
      }
      try {
        chmodSync(socketPath, 0o600);
      } catch (error) {
        const candidateIdentity = socketIdentity(socketPath);
        await new Promise<void>((resolve) => candidate.close(() => resolve()));
        await candidate.drainRequests();
        unlinkIfOwned(socketPath, candidateIdentity);
        releaseSocketOwnerLock(candidateLock);
        throw error;
      }
      server = candidate;
      identity = socketIdentity(socketPath);
      ownerLock = candidateLock;
      candidate.on("error", () => {
        if (server !== candidate) return;
        server = null;
        listenerDrain = new Promise<void>((resolve) => candidate.close(() => resolve())).then(
          async () => await candidate.drainRequests(),
        );
        if (!options.retryOwnership) {
          // Keep the live-PID owner lock until the runtime shuts down. Releasing it while HTTP is
          // still alive would allow a second runtime for the same database after a socket failure.
          return;
        }
        const failedIdentity = identity;
        identity = null;
        const failedOwnerLock = ownerLock;
        ownerLock = null;
        void listenerDrain.then(() => {
          unlinkIfOwned(socketPath, failedIdentity);
          releaseSocketOwnerLock(failedOwnerLock);
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
  const stopAccepting = async (): Promise<void> => {
    await (stopPromise ??= (async () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      await acquisition;
      if (listenerDrain) await listenerDrain;
      const ownedServer = server;
      server = null;
      if (!ownedServer) return;
      listenerDrain = new Promise<void>((resolve, reject) =>
        ownedServer.close((error) => (error ? reject(error) : resolve())),
      );
      await listenerDrain;
      await ownedServer.drainRequests();
    })());
  };
  const releaseOwnership = async (): Promise<void> => {
    await (releasePromise ??= (async () => {
      try {
        await stopAccepting();
      } finally {
        const ownedIdentity = identity;
        const ownedOwnerLock = ownerLock;
        identity = null;
        ownerLock = null;
        try {
          unlinkIfOwned(socketPath, ownedIdentity);
        } finally {
          releaseSocketOwnerLock(ownedOwnerLock);
        }
      }
    })());
  };
  return {
    path: socketPath,
    get owned() {
      return ownerLock !== null;
    },
    get ownerIdentity() {
      return ownerLock ? { ...ownerLock.identity, token: ownerLock.token } : null;
    },
    stopAccepting,
    releaseOwnership,
    close: releaseOwnership,
  };
}

export async function startAgentSocket(
  service: RvwService,
  options: AgentSocketServerOptions = {},
): Promise<RunningAgentSocket> {
  return await startAgentSocketListener(
    service.database.filePath,
    async (request) => await dispatchAgentSocketRequest(service, request),
    { ...options, retryOwnership: true },
  );
}

export async function startRuntimeAgentSocket(
  databaseFilePath: string,
): Promise<RunningRuntimeAgentSocket> {
  let handler: RuntimeAgentSocketHandler | null = null;
  let resolveHandler: ((value: RuntimeAgentSocketHandler) => void) | undefined;
  let rejectHandler: ((reason: unknown) => void) | undefined;
  const handlerPromise = new Promise<RuntimeAgentSocketHandler>((resolve, reject) => {
    resolveHandler = resolve;
    rejectHandler = reject;
  });
  void handlerPromise.catch(() => {
    // Closing an owner before Runtime initialization must also release waiting requests.
  });
  let accepting = true;
  const stopped = Promise.withResolvers<void>();
  const requestStop = (): void => {
    accepting = false;
    stopped.resolve();
  };

  const rejectUninitializedHandler = (): void => {
    if (handler) return;
    rejectHandler?.(new RvwError("PROCESS_FAILED", "rvw runtimeが初期化される前に停止しました。"));
    resolveHandler = undefined;
    rejectHandler = undefined;
  };

  const running = await startAgentSocketListener(
    databaseFilePath,
    async (rawRequest) => {
      const request = validateAgentRequest(rawRequest, databaseFilePath);
      if (request.operation === RUNTIME_STOP_OPERATION) {
        const parsed = runtimeStopInputSchema.safeParse(request.input);
        if (!parsed.success) throw invalidSocketInput(parsed.error);
        if (request.expectedDatabasePath === undefined) {
          throw new RvwError("INVALID_INPUT", "runtime停止にはdatabase identityが必要です。");
        }
        const ownerIdentity = running.ownerIdentity;
        if (!ownerIdentity || !sameOwnerIdentity(ownerIdentity, parsed.data.ownerIdentity)) {
          throw new RvwError("PROCESS_FAILED", "rvw runtimeのownerが変わったため停止しません。", {
            details: { reason: "owner-changed" },
          });
        }
        requestStop();
        return {
          databasePath: resolveDatabaseIdentity(databaseFilePath),
          ownerPid: process.pid,
          ownerIdentity,
        };
      }
      if (!accepting) {
        throw new RvwError("PROCESS_FAILED", "rvw runtimeは停止処理中です。", {
          details: { reason: "runtime-stopping" },
        });
      }
      if (request.operation === "ping") {
        const ping = z.object({}).strict().safeParse(request.input);
        if (!ping.success) throw invalidSocketInput(ping.error);
        return pingResult(databaseFilePath);
      }
      if (request.operation === RUNTIME_VIEWER_OPEN_OPERATION) {
        const parsed = runtimeViewerOpenInputSchema.safeParse(request.input);
        if (!parsed.success) throw invalidSocketInput(parsed.error);
        return await (
          await handlerPromise
        ).openViewer({
          ...(parsed.data.reference === undefined ? {} : { reference: parsed.data.reference }),
          ...(parsed.data.list === undefined ? {} : { list: parsed.data.list }),
          cwd: parsed.data.cwd,
          requestedPort: parsed.data.requestedPort,
        });
      }
      return await dispatchAgentSocketRequest((await handlerPromise).service, request);
    },
    { retryOwnership: false },
  );

  return {
    path: running.path,
    get owned() {
      return running.owned;
    },
    stopRequested: stopped.promise,
    requestStop,
    setHandler(value) {
      if (!running.owned || !accepting) {
        throw new RvwError("PROCESS_FAILED", "所有していないruntime socketは初期化できません。");
      }
      if (handler) {
        throw new RvwError("INTERNAL_ERROR", "runtime socketは初期化済みです。", {
          status: 500,
        });
      }
      if (
        resolveDatabaseIdentity(value.service.database.filePath) !==
        resolveDatabaseIdentity(databaseFilePath)
      ) {
        throw new RvwError("DATABASE_ERROR", "runtimeとAgent socketのdatabaseが一致しません。", {
          details: {
            socketDatabasePath: resolveDatabaseIdentity(databaseFilePath),
            runtimeDatabasePath: resolveDatabaseIdentity(value.service.database.filePath),
          },
        });
      }
      handler = value;
      resolveHandler?.(value);
      resolveHandler = undefined;
      rejectHandler = undefined;
    },
    stopAccepting: async () => {
      accepting = false;
      rejectUninitializedHandler();
      await running.stopAccepting();
    },
    releaseOwnership: async () => {
      accepting = false;
      rejectUninitializedHandler();
      await running.releaseOwnership();
    },
    close: async () => {
      accepting = false;
      rejectUninitializedHandler();
      await running.releaseOwnership();
    },
  };
}
