import { parentPort } from "node:worker_threads";
import { extractSymbols } from "./tree-sitter-tags.js";
import type { NavigationLanguage } from "../../domain/code-navigation.js";

if (!parentPort) throw new Error("Parser must run in a worker.");
parentPort.on("message", (job: { id: number; text: string; language: NavigationLanguage }) => {
  void extractSymbols(job.text, job.language).then(
    (symbols) => parentPort!.postMessage({ id: job.id, symbols }),
    () => parentPort!.postMessage({ id: job.id, error: true }),
  );
});
