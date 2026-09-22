import { MAX_TEXT_DOCUMENT_BYTES, NAVIGATION_CONCURRENCY } from "../../shared/constants.js";
import { Worker } from "node:worker_threads";
import { RvwError } from "../../shared/errors.js";
import type { BlobSymbols } from "./tree-sitter-tags.js";
import type { NavigationLanguage } from "../../domain/code-navigation.js";

declare const __RVW_CLI_BUNDLE__: boolean | undefined;

interface ParseJob {
  id: number;
  text: string;
  language: NavigationLanguage;
  resolve: (symbols: BlobSymbols) => void;
  reject: (error: Error) => void;
}

function createParserWorker(): Worker {
  const bundled = typeof __RVW_CLI_BUNDLE__ !== "undefined" && __RVW_CLI_BUNDLE__;
  return new Worker(
    new URL(bundled ? "./parser-worker.mjs" : "./parser-worker-bootstrap.mjs", import.meta.url),
    {
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
    },
  );
}

/** One lazy, bounded parser worker. A hung parser cannot block the HTTP event loop. */
export class ParserWorkerClient {
  private worker: Worker | undefined;
  private active: ParseJob | undefined;
  private readonly queue: ParseJob[] = [];
  private sequence = 0;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly options: {
      createWorker?: () => Worker;
      timeoutMs?: number;
      idleMs?: number;
    } = {},
  ) {}

  extract(text: string, language: NavigationLanguage): Promise<BlobSymbols> {
    if (this.closed) return Promise.reject(this.unavailable());
    if (Buffer.byteLength(text) > MAX_TEXT_DOCUMENT_BYTES)
      return Promise.reject(
        new RvwError("FILE_TOO_LARGE", "定義探索のfileサイズ上限を超えました。"),
      );
    if (this.queue.length >= NAVIGATION_CONCURRENCY)
      return Promise.reject(
        new RvwError("NAVIGATION_BUSY", "定義を解析中です。少し待って再試行してください。", {
          status: 429,
        }),
      );
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, text, language, resolve, reject });
      this.pump();
    });
  }

  close(): void {
    this.closed = true;
    this.fail();
  }

  private unavailable(): RvwError {
    return new RvwError(
      "NAVIGATION_UNAVAILABLE",
      "定義の解析を完了できませんでした。再試行してください。",
      { status: 503 },
    );
  }

  private stopWorker(): void {
    clearTimeout(this.idle);
    clearTimeout(this.timeout);
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate();
  }

  private fail(): void {
    this.stopWorker();
    this.active?.reject(this.unavailable());
    this.active = undefined;
    if (this.closed) {
      for (const job of this.queue.splice(0)) job.reject(this.unavailable());
    } else {
      // Only the active file ran in the failed worker. Queued inputs are independent.
      queueMicrotask(() => this.pump());
    }
  }

  private pump(): void {
    if (this.active || this.closed) return;
    clearTimeout(this.idle);
    const job = this.queue.shift();
    if (!job) {
      this.worker?.unref();
      this.idle = setTimeout(() => this.stopWorker(), this.options.idleMs ?? 30_000);
      this.idle.unref();
      return;
    }
    this.active = job;
    try {
      if (!this.worker) {
        const worker = (this.options.createWorker ?? createParserWorker)();
        this.worker = worker;
        worker.on("message", (reply: { id: number; symbols?: BlobSymbols; error?: boolean }) => {
          if (this.worker !== worker) return;
          if (
            !reply ||
            !this.active ||
            this.active.id !== reply.id ||
            !reply.symbols ||
            !Array.isArray(reply.symbols.tags) ||
            !Array.isArray(reply.symbols.issues) ||
            typeof reply.symbols.partial !== "boolean" ||
            reply.error
          ) {
            this.fail();
            return;
          }
          clearTimeout(this.timeout);
          const current = this.active;
          this.active = undefined;
          current.resolve(reply.symbols);
          this.pump();
        });
        worker.on("error", () => {
          if (this.worker === worker) this.fail();
        });
        worker.on("exit", () => {
          if (this.worker === worker) this.fail();
        });
      }
      this.worker.ref();
      this.timeout = setTimeout(() => this.fail(), this.options.timeoutMs ?? 5000);
      this.worker.postMessage({ id: job.id, text: job.text, language: job.language });
    } catch {
      this.fail();
    }
  }
}
