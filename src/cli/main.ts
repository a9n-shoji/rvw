import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import openBrowser from "open";
import { z } from "zod";
import { createRuntime, type Runtime } from "../application/runtime.js";
import { databasePathConfiguration } from "../infrastructure/db/database.js";
import { SkillInstaller, type SkillPlatform } from "../infrastructure/skills/skill-installer.js";
import {
  APP_VERSION,
  DEFAULT_COMMENT_LIST_LIMIT,
  DEFAULT_COMMENT_WATCH_INTERVAL_SECONDS,
  DEFAULT_COMMENT_WATCH_LIMIT,
  PROTOCOL_VERSION,
} from "../shared/constants.js";
import {
  asRvwError,
  RvwError,
  type RvwErrorCode,
  type SerializedRvwError,
} from "../shared/errors.js";
import { startServer, type RunningServer } from "../server/start-server.js";
import { DEFAULT_VIEWER_STARTUP_TIMEOUT_MS } from "../server/viewer-lifecycle.js";
import {
  type AgentSocketResult,
  inspectAgentTransport,
  MAX_CLI_STDIN_BYTES,
  startRuntimeAgentSocket,
  tryRuntimeViewerOpen,
  tryAgentSocketRequest,
  type AgentTransportStatus,
  type RunningRuntimeAgentSocket,
  type RuntimeAgentSocketHandler,
  type RuntimeViewerOpenInput,
  type RuntimeViewerOpenResult,
} from "../server/agent-socket.js";
import {
  formatCommentGetOutput,
  formatCommentListOutput,
  formatCommentWatchEvent,
} from "./comment-protocol.js";
import {
  commentCreateInputSchema,
  commentListOptionsSchema,
  commentPostEditInputSchema,
  commentReplyInputSchema,
  commentWatchOptionsSchema,
  pullRequestSyncInputSchema,
  walkthroughPublishInputSchema,
  walkthroughUpdateInputSchema,
} from "./schemas.js";

const MAX_STDIN_BYTES = MAX_CLI_STDIN_BYTES;
const OPEN_WORKER_READY_TIMEOUT_MS = 120_000;
const OPEN_WORKER_PARENT_TIMEOUT_PADDING_MS = 5_000;
const RUNTIME_REUSE_RETRY_MS = 50;
declare const __RVW_CLI_BUNDLE__: boolean | undefined;

interface OutputOptions {
  json?: boolean;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeJsonSequence(value: unknown): void {
  process.stdout.write(`\u001e${JSON.stringify(value)}\n`);
}

async function waitForCommentWatchInterval(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function writeOutput(options: OutputOptions, value: unknown, human: string): void {
  if (options.json) writeJson(value);
  else process.stdout.write(`${human}\n`);
}

function formatAgentTransportStatus(status: AgentTransportStatus): string {
  const lines = [
    `socket: ${status.socketPath} (${status.socketPathSource})`,
    `connection: ${status.connectionResult}`,
    `database: expected=${status.expectedDatabasePath}, socket=${status.socketDatabasePath ?? "none"}, selected=${status.selectedDatabasePath}`,
    `transport: ${status.selectedTransport}`,
    `fallback: ${status.fallbackReason ?? "none"}`,
  ];
  if (status.connectionDetails !== null) {
    lines.push(`connection details: ${JSON.stringify(status.connectionDetails)}`);
  }
  return lines.join("\n");
}

async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > MAX_STDIN_BYTES) {
      throw new RvwError(
        "INVALID_INPUT",
        `stdin JSONは${MAX_STDIN_BYTES} bytes以下にしてください。`,
      );
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new RvwError("INVALID_INPUT", "stdinのJSONを解析できません。", { cause: error });
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidArgumentError("portは0〜65535の整数です。");
  }
  return port;
}

function parsePlatform(value: string): SkillPlatform {
  if (value === "codex" || value === "claude") return value;
  throw new InvalidArgumentError("platformはcodexまたはclaudeです。");
}

export type ServerShutdownReason = "signal" | "viewers-closed";

interface OpenWorkerError extends SerializedRvwError {
  status: number;
}

type OpenWorkerMessage =
  | { type: "ready"; url: string }
  | { type: "viewer-connected" }
  | { type: "error"; error: OpenWorkerError };

export interface BackgroundOpenChild {
  connected: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  disconnect(): void;
  unref(): void;
}

interface BackgroundOpenOptions {
  readyTimeoutMs?: number;
  viewerTimeoutMs?: number;
}

interface BackgroundOpenDependencies {
  forkWorker?: (reference: string | undefined, port: number) => BackgroundOpenChild;
  launchBrowser?: (url: string) => Promise<unknown>;
  tryRuntimeOpen?: (
    input: RuntimeViewerOpenInput,
  ) => Promise<AgentSocketResult<RuntimeViewerOpenResult>>;
}

function isRvwErrorCode(value: unknown): value is RvwErrorCode {
  return typeof value === "string";
}

function openWorkerMessage(value: unknown): OpenWorkerMessage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "ready" && typeof candidate.url === "string") {
    return { type: "ready", url: candidate.url };
  }
  if (candidate.type === "viewer-connected") return { type: "viewer-connected" };
  if (candidate.type !== "error" || !candidate.error || typeof candidate.error !== "object") {
    return null;
  }
  const error = candidate.error as Record<string, unknown>;
  if (
    !isRvwErrorCode(error.code) ||
    typeof error.message !== "string" ||
    !Array.isArray(error.suggestions) ||
    !error.suggestions.every((suggestion) => typeof suggestion === "string") ||
    typeof error.status !== "number"
  ) {
    return null;
  }
  return {
    type: "error",
    error: {
      code: error.code,
      message: error.message,
      suggestions: error.suggestions,
      status: error.status,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

function errorFromOpenWorker(error: OpenWorkerError): RvwError {
  return new RvwError(error.code, error.message, {
    status: error.status,
    suggestions: error.suggestions,
    ...(error.details === undefined ? {} : { details: error.details }),
  });
}

export async function completeBackgroundOpen(
  child: BackgroundOpenChild,
  launchBrowser: (url: string) => Promise<unknown>,
  options: BackgroundOpenOptions = {},
): Promise<string> {
  const readyTimeoutMs = options.readyTimeoutMs ?? OPEN_WORKER_READY_TIMEOUT_MS;
  const viewerTimeoutMs =
    options.viewerTimeoutMs ??
    DEFAULT_VIEWER_STARTUP_TIMEOUT_MS + OPEN_WORKER_PARENT_TIMEOUT_PADDING_MS;
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let exited = false;
    let readyUrl: string | null = null;
    let browserOpened = false;
    let viewerConnected = false;
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!exited) child.kill("SIGTERM");
      reject(asRvwError(error));
    };
    const finishIfReady = (): void => {
      if (settled || !readyUrl || !browserOpened || !viewerConnected) return;
      settled = true;
      cleanup();
      if (child.connected) child.disconnect();
      child.unref();
      resolve(readyUrl);
    };
    const scheduleTimeout = (timeoutMs: number, message: string): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        fail(
          new RvwError("PROCESS_TIMEOUT", message, {
            details: { timeoutMs },
          }),
        );
      }, timeoutMs);
    };
    const onMessage = (...args: unknown[]): void => {
      const message = openWorkerMessage(args[0]);
      if (!message || settled) return;
      if (message.type === "error") {
        fail(errorFromOpenWorker(message.error));
        return;
      }
      if (message.type === "viewer-connected") {
        viewerConnected = true;
        finishIfReady();
        return;
      }
      if (readyUrl !== null) return;
      readyUrl = message.url;
      scheduleTimeout(viewerTimeoutMs, "ブラウザviewerの起動確認がタイムアウトしました。");
      void launchBrowser(readyUrl)
        .then(() => {
          browserOpened = true;
          finishIfReady();
        })
        .catch(fail);
    };
    const onError = (...args: unknown[]): void => {
      fail(args[0]);
    };
    const onExit = (...args: unknown[]): void => {
      exited = true;
      const code = args[0];
      fail(
        new RvwError("PROCESS_FAILED", "バックグラウンドviewerが起動前に終了しました。", {
          details: { exitCode: typeof code === "number" ? code : null },
        }),
      );
    };

    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
    scheduleTimeout(readyTimeoutMs, "バックグラウンドviewerの準備がタイムアウトしました。");
  });
}

export function waitForServerShutdown(
  allViewersClosed: Promise<void> | null,
): Promise<ServerShutdownReason> {
  return new Promise<ServerShutdownReason>((resolve) => {
    let settled = false;
    const finish = (reason: ServerShutdownReason): void => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve(reason);
    };
    const onSignal = (): void => finish("signal");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    if (allViewersClosed) {
      void allViewersClosed.then(() => finish("viewers-closed"));
    }
  });
}

function staticDirectory(): string {
  const executableDirectory = path.dirname(path.resolve(process.argv[1] ?? process.cwd()));
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, "web"),
    path.resolve(executableDirectory, "web"),
    path.resolve(executableDirectory, "../dist/web"),
    path.resolve(process.cwd(), "dist/web"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function forkOpenWorker(reference: string | undefined, port: number): BackgroundOpenChild {
  const modulePath = process.argv[1];
  if (!modulePath) {
    throw new RvwError("PROCESS_FAILED", "rvw CLIの実行pathを解決できませんでした。");
  }
  const args = ["__open-worker", "--port", String(port)];
  if (reference !== undefined) args.push("--reference", reference);
  return fork(path.resolve(modulePath), args, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

export async function startBackgroundOpen(
  reference: string | undefined,
  port: number,
  dependencies: BackgroundOpenDependencies = {},
): Promise<string> {
  const input: RuntimeViewerOpenInput = {
    ...(reference === undefined ? {} : { reference }),
    cwd: process.cwd(),
    requestedPort: port,
  };
  const launchBrowser = dependencies.launchBrowser ?? (async (url) => await openBrowser(url));
  const existing = await (dependencies.tryRuntimeOpen ?? tryRuntimeViewerOpen)(input);
  if (existing.available) {
    await launchBrowser(existing.result.url);
    return existing.result.url;
  }
  if (existing.reason === "database-mismatch") {
    throw new RvwError(
      "AGENT_SOCKET_UNAVAILABLE",
      "起動中のrvw runtimeが別のdatabaseを使用しています。",
      { details: existing.details },
    );
  }
  const child = (dependencies.forkWorker ?? forkOpenWorker)(reference, port);
  return await completeBackgroundOpen(child, launchBrowser);
}

async function sendOpenWorkerMessage(message: OpenWorkerMessage): Promise<boolean> {
  if (!process.send || !process.connected) return false;
  return await new Promise<boolean>((resolve) => {
    try {
      process.send?.(message, (error) => resolve(error === null));
    } catch {
      resolve(false);
    }
  });
}

type InitialViewerResult = "connected" | "aborted" | "timeout";

async function waitForInitialViewer(
  firstViewerConnected: Promise<void>,
  timeoutMs = DEFAULT_VIEWER_STARTUP_TIMEOUT_MS,
): Promise<InitialViewerResult> {
  return await new Promise<InitialViewerResult>((resolve) => {
    let settled = false;
    const finish = (result: InitialViewerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("SIGINT", onAbort);
      process.removeListener("SIGTERM", onAbort);
      process.removeListener("disconnect", onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish("aborted");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    process.once("SIGINT", onAbort);
    process.once("SIGTERM", onAbort);
    process.once("disconnect", onAbort);
    void firstViewerConnected.then(() => finish("connected"));
  });
}

function runtimeViewerOpenInput(
  reference: string | undefined,
  cwd: string,
  requestedPort: number,
): RuntimeViewerOpenInput {
  return {
    ...(reference === undefined ? {} : { reference }),
    cwd,
    requestedPort,
  };
}

export function createRuntimeAgentSocketHandler(
  activeRuntime: Runtime,
  running: RunningServer,
): RuntimeAgentSocketHandler {
  return {
    service: activeRuntime.service,
    openViewer: async (input) => {
      if (input.requestedPort !== 0 && input.requestedPort !== running.port) {
        throw new RvwError(
          "INVALID_INPUT",
          `同じdatabaseのrvw runtimeはport ${running.port} で起動済みです。`,
          {
            details: { activePort: running.port, requestedPort: input.requestedPort },
            suggestions: [
              "既存runtimeを停止してから指定portで再起動するか、--portを省略してください。",
            ],
          },
        );
      }
      const opened = await activeRuntime.service.openPullRequest(input.reference, input.cwd);
      const url = new URL(running.origin);
      url.searchParams.set("pullRequestId", opened.pullRequest.id);
      return {
        url: url.toString(),
        origin: running.origin,
        port: running.port,
        pullRequestId: opened.pullRequest.id,
        ownerPid: process.pid,
      };
    },
  };
}

async function waitForRunningRuntime(
  input: RuntimeViewerOpenInput,
  databaseFilePath: string,
  timeoutMs = OPEN_WORKER_READY_TIMEOUT_MS,
): Promise<RuntimeViewerOpenResult> {
  const deadline = Date.now() + timeoutMs;
  do {
    const response = await tryRuntimeViewerOpen(input, databaseFilePath);
    if (response.available) return response.result;
    if (response.reason === "database-mismatch") {
      throw new RvwError(
        "AGENT_SOCKET_UNAVAILABLE",
        "起動中のrvw runtimeが別のdatabaseを使用しています。",
        { details: response.details },
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, RUNTIME_REUSE_RETRY_MS));
  } while (Date.now() < deadline);
  throw new RvwError("PROCESS_TIMEOUT", "起動中のrvw runtimeへの接続がタイムアウトしました。", {
    details: { timeoutMs },
  });
}

async function waitForWorkerParentDisconnect(): Promise<void> {
  if (!process.connected) return;
  await new Promise<void>((resolve) => process.once("disconnect", resolve));
}

async function runOpenServer(
  runtimeFactory: () => Runtime,
  reference: string | undefined,
  port: number,
  openAutomatically: boolean,
  useAgentSocket: boolean,
  reuseExisting: boolean,
): Promise<void> {
  let activeRuntime: Runtime | undefined;
  let running: RunningServer | undefined;
  let agentSocket: RunningRuntimeAgentSocket | undefined;
  try {
    if (useAgentSocket) {
      const databaseFilePath = databasePathConfiguration().filePath;
      agentSocket = await startRuntimeAgentSocket(databaseFilePath);
      if (!agentSocket.owned) {
        if (reuseExisting) {
          const result = await waitForRunningRuntime(
            runtimeViewerOpenInput(reference, process.cwd(), port),
            databaseFilePath,
          );
          process.stdout.write(`rvw: ${result.url}\n`);
          return;
        }
        throw new RvwError(
          "PROCESS_FAILED",
          "同じdatabaseのrvw runtimeが既に起動中のためforeground serverを開始できません。",
          {
            suggestions: [
              "通常のrvw openで既存runtimeを利用するか、既存runtimeを停止してから再実行してください。",
            ],
          },
        );
      }
    }
    activeRuntime = runtimeFactory();
    const opened = await activeRuntime.service.openPullRequest(reference, process.cwd());
    running = await startServer(activeRuntime.service, {
      port,
      staticDirectory: staticDirectory(),
      autoCloseWhenNoViewers: openAutomatically,
    });
    agentSocket?.setHandler(createRuntimeAgentSocketHandler(activeRuntime, running));
    const url = new URL(running.origin);
    url.searchParams.set("pullRequestId", opened.pullRequest.id);
    process.stdout.write(`rvw: ${url.toString()}\n`);
    if (openAutomatically) await openBrowser(url.toString());
    const reason = await waitForServerShutdown(running.allViewersClosed);
    if (reason === "viewers-closed") {
      process.stdout.write("rvw: viewerを閉じたためserverを停止します。\n");
    }
  } finally {
    try {
      await agentSocket?.close();
    } finally {
      try {
        await running?.close();
      } finally {
        activeRuntime?.close();
      }
    }
  }
}

async function runOpenWorker(
  runtimeFactory: () => Runtime,
  reference: string | undefined,
  port: number,
): Promise<void> {
  let activeRuntime: Runtime | undefined;
  let running: RunningServer | undefined;
  let agentSocket: RunningRuntimeAgentSocket | undefined;
  try {
    if (!process.send || !process.connected) {
      throw new RvwError("INVALID_INPUT", "内部viewer workerは親CLIから起動してください。");
    }
    const databaseFilePath = databasePathConfiguration().filePath;
    agentSocket = await startRuntimeAgentSocket(databaseFilePath);
    if (!agentSocket.owned) {
      const result = await waitForRunningRuntime(
        runtimeViewerOpenInput(reference, process.cwd(), port),
        databaseFilePath,
      );
      if (!(await sendOpenWorkerMessage({ type: "ready", url: result.url }))) return;
      if (!(await sendOpenWorkerMessage({ type: "viewer-connected" }))) return;
      await waitForWorkerParentDisconnect();
      return;
    }
    activeRuntime = runtimeFactory();
    const opened = await activeRuntime.service.openPullRequest(reference, process.cwd());
    running = await startServer(activeRuntime.service, {
      port,
      staticDirectory: staticDirectory(),
      autoCloseWhenNoViewers: true,
    });
    agentSocket.setHandler(createRuntimeAgentSocketHandler(activeRuntime, running));
    const url = new URL(running.origin);
    url.searchParams.set("pullRequestId", opened.pullRequest.id);
    if (!(await sendOpenWorkerMessage({ type: "ready", url: url.toString() }))) return;
    const firstViewerConnected = running.firstViewerConnected;
    if (!firstViewerConnected) {
      throw new RvwError("INTERNAL_ERROR", "viewer lifecycleを初期化できませんでした。", {
        status: 500,
      });
    }
    const initialViewer = await waitForInitialViewer(firstViewerConnected);
    if (initialViewer === "aborted") return;
    if (initialViewer === "timeout") {
      throw new RvwError("PROCESS_TIMEOUT", "ブラウザviewerの起動確認がタイムアウトしました。", {
        details: { timeoutMs: DEFAULT_VIEWER_STARTUP_TIMEOUT_MS },
      });
    }
    await sendOpenWorkerMessage({ type: "viewer-connected" });
    await waitForServerShutdown(running.allViewersClosed);
  } finally {
    try {
      await agentSocket?.close();
    } finally {
      try {
        await running?.close();
      } finally {
        activeRuntime?.close();
      }
    }
  }
}

const defaultRuntimeFactory = (): Runtime => createRuntime();

export function createProgram(runtimeFactory: () => Runtime = defaultRuntimeFactory): Command {
  let runtime: Runtime | undefined;
  const getRuntime = (): Runtime => (runtime ??= runtimeFactory());
  const useAgentSocket = runtimeFactory === defaultRuntimeFactory;
  const callService = async <T>(
    operation: string,
    input: unknown,
    direct: () => T | Promise<T>,
  ): Promise<T> => {
    if (useAgentSocket) {
      const expectedDatabasePath = databasePathConfiguration().filePath;
      const remote = await tryAgentSocketRequest<T>(operation, input, {
        expectedDatabasePath,
      });
      if (remote.available) return remote.result;
    }
    return await direct();
  };
  const program = new Command();
  program
    .name("rvw")
    .description("GitHub Pull Requestをcommit単位で閲覧・コメントするローカルviewer")
    .version(APP_VERSION)
    .showHelpAfterError();

  program
    .command("doctor")
    .description(
      "git、gh認証、repository、DBを確認（RVW_DATABASE_PATHはchmodしないcaller-managed DB）",
    )
    .option("--json", "JSONで出力")
    .action(async (options: OutputOptions) => {
      const agentTransport = useAgentSocket
        ? await inspectAgentTransport()
        : await inspectAgentTransport(getRuntime().database.filePath);
      if (agentTransport.selectedTransport === "unavailable") {
        throw new RvwError(
          "AGENT_SOCKET_UNAVAILABLE",
          "明示されたAgent socketへ接続できないため、doctorをdatabaseへfallbackしません。",
          {
            details: agentTransport,
            suggestions: [
              "rvw agent ping --json または rvw agent status --json で接続先を確認してください。",
            ],
          },
        );
      }
      const directDoctor = async () => await getRuntime().service.doctor(process.cwd());
      const result =
        agentTransport.selectedTransport === "direct-database"
          ? await directDoctor()
          : await callService("doctor", { cwd: process.cwd() }, directDoctor);
      const skills = new SkillInstaller().statuses();
      const skillUpdates = skills.filter((status) => status.updateAvailable === true);
      const output = {
        ...result,
        agentTransport,
        skills,
        skillUpdateAvailable: skillUpdates.length > 0,
        skillUpdateRequired: skills.some((status) => status.updateRequired),
      };
      const message = result.ok
        ? skillUpdates.length > 0
          ? `rvwを利用できます。${skillUpdates.length}件のSkill更新があります。rvw skill statusで確認してください。`
          : "rvwを利用できます。"
        : !result.databaseWriteProbe.ok
          ? "databaseへの書き込み試験に失敗しました。"
          : "gh認証が必要です。";
      writeOutput(options, output, message);
      if (!result.ok) process.exitCode = 2;
    });

  program
    .command("protocol")
    .description("Agent向けCLI protocol情報を表示")
    .option("--json", "JSONで出力")
    .action((options: OutputOptions) => {
      const result = {
        protocolVersion: PROTOCOL_VERSION,
        appVersion: APP_VERSION,
        capabilities: [
          "agent.transport",
          "comment.create",
          "comment.list",
          "comment.watch",
          "comment.read",
          "comment.reply",
          "comment.edit",
          "comment.codeReferences",
          "comment.resolve",
          "comment.reopen",
          "pullRequest.sync",
          "walkthrough.read",
          "walkthrough.publish",
          "walkthrough.update",
          "walkthrough.delete",
          "walkthrough.htmlPreview",
        ],
      };
      writeOutput(options, result, `rvw protocol ${PROTOCOL_VERSION}`);
    });

  const agent = program.command("agent").description("Agent socket transportを診断");
  agent
    .command("ping")
    .description("Agent socketへの接続とdatabase identityを確認")
    .option("--json", "JSONで出力")
    .action(async (options: OutputOptions) => {
      const status = await inspectAgentTransport(
        useAgentSocket ? undefined : getRuntime().database.filePath,
      );
      const output = { ok: status.connected, ...status };
      writeOutput(options, output, formatAgentTransportStatus(status));
      if (!status.connected) process.exitCode = 2;
    });
  agent
    .command("status")
    .description("選択されるAgent transportとfallback理由を表示")
    .option("--json", "JSONで出力")
    .action(async (options: OutputOptions) => {
      const status = await inspectAgentTransport(
        useAgentSocket ? undefined : getRuntime().database.filePath,
      );
      const ok = status.selectedTransport !== "unavailable";
      writeOutput(options, { ok, ...status }, formatAgentTransportStatus(status));
      if (!ok) process.exitCode = 2;
    });

  program
    .command("open")
    .argument("[pull-request]", "PR URLまたは番号")
    .option("--no-open", "ブラウザを開かない")
    .option("--foreground", "terminalに接続したままviewerを実行")
    .option("--port <port>", "listen port（0は自動）", parsePort, 0)
    .description("Pull Requestを開いてローカルviewerを起動")
    .action(
      async (
        reference: string | undefined,
        options: { open: boolean; foreground?: boolean; port: number },
      ) => {
        if (options.open && !options.foreground && useAgentSocket) {
          const url = await startBackgroundOpen(reference, options.port);
          process.stdout.write(`rvw: ${url}\n`);
          return;
        }
        await runOpenServer(
          getRuntime,
          reference,
          options.port,
          options.open,
          useAgentSocket,
          !options.foreground,
        );
      },
    );

  program
    .command("__open-worker", { hidden: true })
    .option("--reference <pull-request>")
    .requiredOption("--port <port>", "listen port", parsePort)
    .action(async (options: { reference?: string; port: number }) => {
      try {
        await runOpenWorker(getRuntime, options.reference, options.port);
      } catch (error) {
        const rvwError = asRvwError(error);
        const sent = await sendOpenWorkerMessage({
          type: "error",
          error: { ...rvwError.toJSON(), status: rvwError.status },
        });
        if (!sent) throw error;
        process.exitCode = rvwError.status >= 500 ? 1 : 2;
      }
    });

  const pr = program.command("pr").description("Pull Request状態を管理");
  pr.command("refresh")
    .argument("<pull-request>", "登録済みPR URLまたは番号")
    .option("--json", "JSONで出力")
    .action(async (reference: string, options: OutputOptions) => {
      const result = await callService(
        "pr.refresh",
        { reference },
        async () => await getRuntime().service.refreshByReference(reference),
      );
      writeOutput(
        options,
        { ok: true, ...result },
        `${result.commits.length}件のPR commitを同期しました。`,
      );
    });

  pr.command("sync")
    .requiredOption("--stdin", "stdinからJSONを読む")
    .requiredOption("--json", "JSONで出力")
    .option("--repository <path>", "同期に使う同一repositoryのworktree")
    .option("--allow-untracked", "未追跡fileだけをdirty判定から除外")
    .action(async (options: { repository?: string; allowUntracked?: boolean }) => {
      const input = pullRequestSyncInputSchema.parse(await readStdinJson());
      const request = {
        pullRequest: input.pullRequest,
        commentUpdates: input.commentUpdates ?? [],
        ...(options.repository === undefined ? {} : { repositoryPath: options.repository }),
        allowUntracked: options.allowUntracked ?? false,
      };
      const result = await callService(
        "pr.sync",
        request,
        async () => await getRuntime().service.syncPullRequest(request),
      );
      writeJson({ ok: true, ...result });
    });

  pr.command("attach")
    .argument("<pull-request>", "登録済みPR URLまたは番号")
    .requiredOption("--repository <path>", "保存先にする同一repositoryのworktree")
    .option("--json", "JSONで出力")
    .description("viewerを起動せずrepository pathだけを更新")
    .action(async (reference: string, options: OutputOptions & { repository: string }) => {
      const pullRequest = await callService(
        "pr.attach",
        { reference, repositoryPath: options.repository },
        async () => await getRuntime().service.attachPullRequest(reference, options.repository),
      );
      writeOutput(
        options,
        { ok: true, pullRequest },
        `repository pathを${pullRequest.localRepositoryPath}へ更新しました。`,
      );
    });

  pr.command("reset")
    .argument("<pull-request>", "登録済みPR URLまたは番号")
    .option("--yes", "不可逆な削除を確認")
    .option("--json", "JSONで出力")
    .action(async (reference: string, options: OutputOptions & { yes?: boolean }) => {
      if (!options.yes) {
        const preview = await callService("pr.reset.preview", { reference }, async () => {
          const service = getRuntime().service;
          const pullRequest = service.resolveStoredPullRequest(reference);
          return await service.getResetPreview(pullRequest.id);
        });
        const result = {
          ok: false,
          error: {
            code: "RESET_CONFIRMATION_REQUIRED",
            message: "resetには--yesが必要です。",
            suggestions: [`rvw pr reset ${reference} --yes`],
          },
          ...preview,
        };
        writeOutput(
          options,
          result,
          `削除対象: コメント${preview.counts.comments}、返信${preview.counts.posts}、コメント内コード参照${preview.counts.commentReferences}、対象${preview.counts.targets}、Walkthrough${preview.counts.walkthroughs}、Walkthroughコード参照${preview.counts.walkthroughReferences}、Git ref${preview.counts.gitRefs}\n続行するには --yes を指定してください。`,
        );
        process.exitCode = 2;
        return;
      }
      const result = await callService("pr.reset", { reference, confirmed: true }, async () => {
        const service = getRuntime().service;
        const pullRequest = service.resolveStoredPullRequest(reference);
        return await service.resetPullRequest(pullRequest.id);
      });
      writeOutput(
        options,
        { ok: true, ...result },
        `${result.pullRequest.latestHeadOid.slice(0, 12)}を最新headとして再構築しました。`,
      );
    });

  const comment = program.command("comment").description("保存済みコメントを操作");

  const walkthrough = program.command("walkthrough").description("コード参照付きwalkthroughを管理");
  walkthrough
    .command("publish")
    .requiredOption("--stdin", "stdinからJSONを読む")
    .requiredOption("--json", "JSONで出力")
    .description("walkthroughを登録（viewerは開かずnavigationも変更しない）")
    .action(async () => {
      const input = walkthroughPublishInputSchema.parse(await readStdinJson());
      const request = {
        pullRequest: input.pullRequest,
        sourceOid: input.sourceOid,
        title: input.title,
        body: input.body,
        references: input.references,
        ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
        ...(input.diagramBindings === undefined ? {} : { diagramBindings: input.diagramBindings }),
      };
      const published = await callService(
        "walkthrough.publish",
        request,
        async () => await getRuntime().service.publishWalkthrough(request),
      );
      writeJson({ ok: true, walkthrough: published });
    });

  walkthrough
    .command("get")
    .argument("<walkthrough-uri>")
    .requiredOption("--json", "JSONで出力")
    .description("walkthroughの現在内容を取得")
    .action(async (uri: string) => {
      const result = await callService("walkthrough.get", { uri }, () =>
        getRuntime().service.getWalkthroughByUri(uri),
      );
      writeJson({ ok: true, ...result });
    });

  walkthrough
    .command("update")
    .argument("<walkthrough-uri>")
    .requiredOption("--stdin", "stdinからJSONを読む")
    .requiredOption("--json", "JSONで出力")
    .description("walkthroughを同じ参照のまま更新")
    .action(async (uri: string) => {
      const input = walkthroughUpdateInputSchema.parse(await readStdinJson());
      const content = {
        sourceOid: input.sourceOid,
        title: input.title,
        body: input.body,
        references: input.references,
        ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
        ...(input.diagramBindings === undefined ? {} : { diagramBindings: input.diagramBindings }),
      };
      const updated = await callService(
        "walkthrough.update",
        { uri, content },
        async () => await getRuntime().service.updateWalkthrough(uri, content),
      );
      writeJson({ ok: true, walkthrough: updated });
    });

  walkthrough
    .command("delete")
    .argument("<walkthrough-uri>")
    .option("--yes", "不可逆な削除を確認")
    .requiredOption("--json", "JSONで出力")
    .description("walkthroughと紐づくコメントを削除")
    .action(async (uri: string, options: OutputOptions & { yes?: boolean }) => {
      if (!options.yes) {
        const preview = await callService("walkthrough.delete.preview", { uri }, () =>
          getRuntime().service.getWalkthroughDeletePreview(uri),
        );
        writeJson({
          ok: false,
          error: {
            code: "WALKTHROUGH_DELETE_CONFIRMATION_REQUIRED",
            message: "walkthrough deleteには--yesが必要です。",
            suggestions: [`rvw walkthrough delete ${uri} --yes --json`],
          },
          ...preview,
        });
        process.exitCode = 2;
        return;
      }
      const deleted = await callService("walkthrough.delete", { uri, confirmed: true }, () =>
        getRuntime().service.deleteWalkthroughByUri(uri),
      );
      writeJson({ ok: true, deleted });
    });

  comment
    .command("watch")
    .description("全登録PRで起動後に作成されたroot commentとreplyを監視")
    .option("--after <cursor>", "以前のwatch cursorから再開")
    .option(
      "--interval <seconds>",
      `poll間隔（既定: ${DEFAULT_COMMENT_WATCH_INTERVAL_SECONDS}秒）`,
      String(DEFAULT_COMMENT_WATCH_INTERVAL_SECONDS),
    )
    .option(
      "--limit <limit>",
      `一度に取得する最大event数（既定: ${DEFAULT_COMMENT_WATCH_LIMIT}）`,
      String(DEFAULT_COMMENT_WATCH_LIMIT),
    )
    .option("--once", "現在取得可能なeventを出力して終了")
    .requiredOption("--json-seq", "RFC 7464 JSON text sequenceで出力")
    .action(async (rawOptions: unknown) => {
      const options = commentWatchOptionsSchema.parse(rawOptions);
      let cursor = options.after;
      let first = true;
      let stopping = false;
      const stop = (): void => {
        stopping = true;
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        do {
          const result = await callService(
            "comment.watch",
            {
              ...(cursor === undefined ? {} : { cursor }),
              limit: options.limit,
            },
            () => getRuntime().service.listCommentPostEvents(cursor, options.limit),
          );
          if (first) {
            writeJsonSequence({
              type: "ready",
              databaseId: result.databaseId,
              cursor: result.startCursor,
              anchoredAtCurrent: result.anchoredAtCurrent,
            });
          }
          for (const item of result.events) {
            writeJsonSequence({ type: "comment-posted", ...formatCommentWatchEvent(item) });
          }
          cursor = result.cursor;
          first = false;
          if (options.once || stopping) break;
          if (!result.hasMore) {
            await waitForCommentWatchInterval(options.interval * 1_000);
          }
        } while (!stopping);
        writeJsonSequence({ type: "stopped", cursor });
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    });

  comment
    .command("create")
    .requiredOption("--stdin", "stdinからJSONを読む")
    .requiredOption("--json", "JSONで出力")
    .description("登録済みPRへ未解決コメントを一件作成")
    .action(async () => {
      const input = commentCreateInputSchema.parse(await readStdinJson());
      const request = {
        pullRequest: input.pullRequest,
        target: input.target,
        body: input.body,
        ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
        ...(input.relatedCommitOid === undefined
          ? {}
          : { relatedCommitOid: input.relatedCommitOid }),
        ...(input.references === undefined ? {} : { references: input.references }),
      };
      const created = await callService(
        "comment.create",
        request,
        async () => await getRuntime().service.createCommentForReference(request),
      );
      writeJson({ ok: true, comment: created });
    });

  comment
    .command("list")
    .argument("<pull-request>", "登録済みPR URLまたは番号")
    .option("--state <state>", "unresolved、resolved、all（既定: unresolved）", "unresolved")
    .option(
      "--limit <limit>",
      `1ページの最大件数（既定: ${DEFAULT_COMMENT_LIST_LIMIT}）`,
      String(DEFAULT_COMMENT_LIST_LIMIT),
    )
    .option("--offset <offset>", "取得開始位置（既定: 0）", "0")
    .requiredOption("--json", "JSONで出力")
    .action(async (reference: string, rawOptions: unknown) => {
      const options = commentListOptionsSchema.parse(rawOptions);
      const resolved = options.state === "all" ? undefined : options.state === "resolved";
      const result = await callService(
        "comment.list",
        { reference, resolved, limit: options.limit, offset: options.offset },
        async () =>
          await getRuntime().service.listCommentReviewContexts(reference, resolved, {
            limit: options.limit,
            offset: options.offset,
          }),
      );
      writeJson(formatCommentListOutput(result, options.state));
    });

  comment
    .command("get")
    .argument("<comment-uri>")
    .option("--include-pr-body", "最新のPR本文をpullRequest.bodyに含める")
    .option("--live", "GitHubの現在値をread-onlyで確認し、cacheとの差を表示")
    .requiredOption("--json", "JSONで出力")
    .action(async (uri: string, options: { includePrBody?: boolean; live?: boolean }) => {
      const result = await callService(
        "comment.get",
        { uri, live: options.live ?? false },
        async () =>
          await getRuntime().service.getCommentReviewContext(uri, {
            live: options.live ?? false,
          }),
      );
      writeJson(formatCommentGetOutput(result, { includePrBody: options.includePrBody ?? false }));
    });

  comment
    .command("reply")
    .argument("<comment-uri>")
    .requiredOption("--stdin", "stdinからJSONを読む")
    .requiredOption("--json", "JSONで出力")
    .action(async (uri: string) => {
      const input = commentReplyInputSchema.parse(await readStdinJson());
      const reply = {
        body: input.body,
        ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
        ...(input.relatedCommitOid === undefined
          ? {}
          : { relatedCommitOid: input.relatedCommitOid }),
        ...(input.references === undefined ? {} : { references: input.references }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      };
      const post = await callService(
        "comment.reply",
        { uri, reply },
        async () =>
          await getRuntime().service.replyToComment(uri, {
            ...reply,
            lastModifiedBy: "agent",
          }),
      );
      writeJson({ ok: true, post });
    });

  comment
    .command("edit")
    .argument("<comment-uri>")
    .requiredOption("--post <post-id>", "編集するpost ID")
    .requiredOption("--stdin", "stdinからJSONを読む")
    .requiredOption("--json", "JSONで出力")
    .action(async (uri: string, options: { post: string }) => {
      const input = commentPostEditInputSchema.parse(await readStdinJson());
      const edit = {
        body: input.body,
        ...(input.relatedCommitOid === undefined
          ? {}
          : { relatedCommitOid: input.relatedCommitOid }),
        ...(input.references === undefined ? {} : { references: input.references }),
      };
      const post = await callService(
        "comment.edit",
        { uri, postId: options.post, edit },
        async () =>
          await getRuntime().service.editCommentPost(uri, options.post, {
            ...edit,
            lastModifiedBy: "agent",
          }),
      );
      writeJson({ ok: true, post });
    });

  comment
    .command("resolve")
    .argument("<comment-uri>")
    .requiredOption("--json", "JSONで出力")
    .action(async (uri: string) => {
      const comment = await callService("comment.resolve", { uri }, () =>
        getRuntime().service.setCommentResolved(uri, true),
      );
      writeJson({ ok: true, comment });
    });

  comment
    .command("reopen")
    .argument("<comment-uri>")
    .requiredOption("--json", "JSONで出力")
    .action(async (uri: string) => {
      const comment = await callService("comment.reopen", { uri }, () =>
        getRuntime().service.setCommentResolved(uri, false),
      );
      writeJson({ ok: true, comment });
    });

  const skill = program.command("skill").description("Codex / Claude Code向けrvw Skillを管理");
  skill
    .command("install")
    .argument("<platform>", "codexまたはclaude", parsePlatform)
    .option("--force", "差異がある既存Skillを置換")
    .option("--target <skills-root>", "Skill rootを上書き")
    .option("--json", "JSONで出力")
    .action(
      (platform: SkillPlatform, options: OutputOptions & { force?: boolean; target?: string }) => {
        const statuses = new SkillInstaller().install(platform, {
          force: options.force ?? false,
          ...(options.target === undefined ? {} : { targetRoot: options.target }),
        });
        writeOutput(
          options,
          { ok: true, skills: statuses },
          statuses
            .map((status) => `${status.name}を${status.path}へインストールしました。`)
            .join("\n"),
        );
      },
    );

  skill
    .command("status")
    .argument("[platform]", "codexまたはclaude", parsePlatform)
    .option("--target <skills-root>", "Skill rootを上書き")
    .option("--json", "JSONで出力")
    .action((platform: SkillPlatform | undefined, options: OutputOptions & { target?: string }) => {
      const statuses = new SkillInstaller().statuses(platform, options.target);
      writeOutput(
        options,
        { ok: true, skills: statuses },
        statuses.map((status) => `${status.name}: ${status.state} (${status.path})`).join("\n"),
      );
    });

  program.hook("postAction", (_command, actionCommand) => {
    if (actionCommand.name() !== "open" && actionCommand.name() !== "__open-worker") {
      runtime?.close();
    }
  });
  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  const json = argv.includes("--json");
  const jsonSequence = argv.includes("--json-seq");
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    const rvwError =
      error instanceof z.ZodError
        ? new RvwError("INVALID_INPUT", "入力がCLI schemaに適合しません。", {
            details: z.treeifyError(error),
          })
        : asRvwError(error);
    if (jsonSequence) writeJsonSequence({ type: "error", error: rvwError.toJSON() });
    else if (json) writeJson({ ok: false, error: rvwError.toJSON() });
    else process.stderr.write(`rvw: ${rvwError.message}\n${rvwError.suggestions.join("\n")}\n`);
    if (rvwError.status >= 500 && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = rvwError.status >= 500 ? 1 : 2;
  }
}

const bundledCli = typeof __RVW_CLI_BUNDLE__ !== "undefined" && __RVW_CLI_BUNDLE__ === true;
if (bundledCli || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  await runCli();
}
