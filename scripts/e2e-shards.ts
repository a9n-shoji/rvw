import { globSync } from "node:fs";
import path from "node:path";
import timings from "./e2e-timings.json" with { type: "json" };

/** Longest files first; timing hints affect balance, never test discovery or coverage. */
export function planE2eShards(
  files: string[],
  seconds: Readonly<Record<string, number>>,
  count: number,
): string[][] {
  if (!Number.isSafeInteger(count) || count < 1 || count > files.length)
    throw new Error("E2E shard count must be between 1 and the number of discovered files.");
  if (new Set(files).size !== files.length) throw new Error("Duplicate E2E file discovery.");
  if (Object.values(seconds).some((value) => !Number.isFinite(value) || value <= 0))
    throw new Error("E2E timing hints must be positive finite seconds.");
  const cost = (file: string): number => seconds[file] ?? 30;
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], seconds: 0 }));
  const ordered = files.toSorted((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const file of ordered) {
    const shard = shards.reduce((best, candidate) =>
      candidate.seconds < best.seconds ? candidate : best,
    );
    shard.files.push(file);
    shard.seconds += cost(file);
  }
  return shards.map((shard) => shard.files.sort());
}

export function e2eShardPatterns(
  directory: string,
  selection: string | undefined,
): RegExp[] | undefined {
  if (selection === undefined) return undefined;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(selection);
  if (!match) throw new Error("RVW_E2E_SHARD must be N/TOTAL, for example 2/8.");
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index > count) throw new Error("E2E shard index exceeds shard count.");
  // Match Playwright's default spec/test extensions, including future nested test files.
  const files = [...globSync("**/*", { cwd: directory })]
    .filter((file) => /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(file))
    .map((file) => file.split(path.sep).join("/"));
  const selected = planE2eShards(files, timings, count)[index - 1]!;
  console.log(`E2E shard ${selection}: ${selected.join(", ")}`);
  return selected.map(
    (file) =>
      new RegExp(`^${path.resolve(directory, file).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"),
  );
}
