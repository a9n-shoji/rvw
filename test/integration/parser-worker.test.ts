import { NAVIGATION_CONCURRENCY } from "../../src/shared/constants.js";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { ParserWorkerClient } from "../../src/infrastructure/navigation/parser-worker-client.js";

describe("Parser worker", () => {
  it("parses in a reusable worker and rejects after shutdown", async () => {
    const worker = new ParserWorkerClient();
    try {
      const results = await Promise.all([
        worker.extract("class User; end\n", "ruby"),
        worker.extract("module Billing; end\n", "ruby"),
      ]);
      expect(results.map((result) => result.tags[0]?.name)).toEqual(["User", "Billing"]);
      expect(results[0]?.issues).toEqual([]);
    } finally {
      worker.close();
    }
    await expect(worker.extract("class User; end", "ruby")).rejects.toMatchObject({
      code: "NAVIGATION_UNAVAILABLE",
    });
  });

  it("terminates a hung worker without blocking the server and retries with a fresh worker", async () => {
    let workers = 0;
    const worker = new ParserWorkerClient({
      timeoutMs: 500,
      createWorker: () => {
        workers++;
        return new Worker(
          workers === 1
            ? "while (true) {}"
            : `const {parentPort}=require('node:worker_threads'); parentPort.on('message', ({id})=>parentPort.postMessage({id,symbols:{tags:[],partial:false,issues:[]}}));`,
          { eval: true },
        );
      },
    });
    try {
      let responsive = false;
      const first = worker.extract("User", "ruby");
      const timer = setTimeout(() => {
        responsive = true;
      }, 10);
      await expect(first).rejects.toMatchObject({ code: "NAVIGATION_UNAVAILABLE" });
      clearTimeout(timer);
      expect(responsive).toBe(true);
      await expect(worker.extract("User", "ruby")).resolves.toMatchObject({ partial: false });
      expect(workers).toBe(2);
    } finally {
      worker.close();
    }
  });

  it.each(["timeout", "crash", "malformed"] as const)(
    "isolates %s to the active file and continues queued work",
    async (failure) => {
      let workers = 0;
      const worker = new ParserWorkerClient({
        timeoutMs: 500,
        createWorker: () =>
          new Worker(
            ++workers === 1
              ? failure === "timeout"
                ? "while(true) {}"
                : failure === "crash"
                  ? "throw new Error('crash')"
                  : "require('node:worker_threads').parentPort.on('message', () => require('node:worker_threads').parentPort.postMessage(null))"
              : "const {parentPort}=require('node:worker_threads'); parentPort.on('message', ({id})=>parentPort.postMessage({id,symbols:{tags:[],partial:false,issues:[]}}));",
            { eval: true },
          ),
      });
      try {
        const failed = worker.extract("bad", "ruby").catch((error: unknown) => error);
        const queued = [worker.extract("good", "ruby"), worker.extract("also good", "tsx")];
        expect(await failed).toMatchObject({ code: "NAVIGATION_UNAVAILABLE" });
        for (const result of await Promise.all(queued)) expect(result.partial).toBe(false);
        expect(workers).toBe(2);
      } finally {
        worker.close();
      }
    },
  );

  it("bounds pending tasks, rejects all waiters on shutdown, and rejects oversized input", async () => {
    const worker = new ParserWorkerClient({
      createWorker: () => new Worker("while(true) {}", { eval: true }),
    });
    try {
      const jobs = Array.from({ length: NAVIGATION_CONCURRENCY + 1 }, () =>
        worker.extract("User", "ruby").catch((error: unknown) => error),
      );
      await expect(worker.extract("User", "ruby")).rejects.toMatchObject({
        code: "NAVIGATION_BUSY",
      });
      await expect(worker.extract("a".repeat(1024 * 1024 + 1), "ruby")).rejects.toMatchObject({
        code: "FILE_TOO_LARGE",
      });
      worker.close();
      for (const error of await Promise.all(jobs))
        expect(error).toMatchObject({ code: "NAVIGATION_UNAVAILABLE" });
    } finally {
      worker.close();
    }
  });

  it("releases the idle worker and starts a new one for the next query", async () => {
    let workers = 0;
    const worker = new ParserWorkerClient({
      idleMs: 10,
      createWorker: () => {
        workers++;
        return new Worker(
          `const {parentPort}=require('node:worker_threads'); parentPort.on('message', ({id})=>parentPort.postMessage({id,symbols:{tags:[],partial:false,issues:[]}}));`,
          { eval: true },
        );
      },
    });
    try {
      await worker.extract("User", "ruby");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await worker.extract("User", "ruby");
      expect(workers).toBe(2);
    } finally {
      worker.close();
    }
  });
});
