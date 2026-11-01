import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { e2eShardPatterns, planE2eShards } from "../../scripts/e2e-shards.js";

describe("isolated E2E shard planning", () => {
  it("balances heavy files without splitting them, independently of discovery order", () => {
    const files = ["a", "b", "c", "d", "e", "f"];
    const weights = { a: 90, b: 70, c: 40, d: 20, e: 10, f: 10 };
    const shards = planE2eShards(files, weights, 3);
    expect(shards).toEqual(planE2eShards([...files].reverse(), weights, 3));
    expect(shards.flat().sort()).toEqual(files);
    expect(
      shards.map((shard) =>
        shard.reduce((sum, file) => sum + weights[file as keyof typeof weights], 0),
      ),
    ).toEqual([90, 80, 70]);
  });

  it("includes new files and ignores removed-file timing hints", () => {
    const files = ["known.spec.ts", "new.spec.ts", "nested/new.test.ts"];
    const shards = planE2eShards(files, { "known.spec.ts": 60, "removed.spec.ts": 200 }, 2);
    expect(shards.flat().sort()).toEqual([...files].sort());
    expect(shards.every((shard) => shard.length > 0)).toBe(true);
  });

  it("fails explicitly for invalid counts, duplicates and corrupt timing hints", () => {
    for (const count of [0, -1, 1.5, 3, Infinity])
      expect(() => planE2eShards(["a", "b"], {}, count)).toThrow();
    expect(() => planE2eShards(["a", "a"], {}, 1)).toThrow(/Duplicate/);
    for (const value of [0, -1, NaN, Infinity])
      expect(() => planE2eShards(["a"], { a: value }, 1)).toThrow(/timing/);
  });

  it("discovers nested Playwright extensions and escapes literal file names", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-e2e-shards-"));
    const files = ["first.spec.ts", "nested/[literal].test.tsx", "nested/other.spec.mjs"];
    try {
      mkdirSync(path.join(directory, "nested"));
      for (const file of [...files, "helper.ts", "nested/notes.txt"])
        writeFileSync(path.join(directory, file), "");
      const patterns = [1, 2, 3].flatMap((index) => e2eShardPatterns(directory, `${index}/3`)!);
      for (const file of files)
        expect(
          patterns.filter((pattern) => pattern.test(path.resolve(directory, file))),
        ).toHaveLength(1);
      expect(patterns).toHaveLength(files.length);
      expect(
        patterns.some((pattern) => pattern.test(path.resolve(directory, "nested/l.test.tsx"))),
      ).toBe(false);
      for (const invalid of ["", "0/3", "4/3", "2/0", "1.5/3", "1/4"])
        expect(() => e2eShardPatterns(directory, invalid)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves normal local discovery unchanged without a shard selection", () => {
    expect(e2eShardPatterns("nonexistent-directory", undefined)).toBeUndefined();
  });
});
