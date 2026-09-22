import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import { GitCodeNavigation } from "../../src/infrastructure/navigation/git-code-navigation.js";
import { extractSymbols } from "../../src/infrastructure/navigation/tree-sitter-tags.js";
import { NAVIGATION_LOOKUP_MS } from "../../src/shared/constants.js";
import { createGitRepository, git } from "../fixtures/git-repository.js";

// Exercise exhaustion with real Git/parser inputs, without multi-megabyte fixtures
// or a production-only budget configuration API.
vi.mock("../../src/shared/constants.js", async (original) => ({
  ...(await original<typeof import("../../src/shared/constants.js")>()),
  NAVIGATION_LOOKUP_BYTES: 512,
}));

const repositories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0))
    rmSync(repository, { recursive: true, force: true });
});
function fixture() {
  const repository = createGitRepository();
  repositories.push(repository);
  const files: Record<string, string> = {
    "a.ts": "export interface Button {}",
    "z.tsx": "export function Button() { return <button/>; }",
    "zz.js": "export function Button() { return null; }",
  };
  for (const [file, source] of Object.entries(files))
    writeFileSync(path.join(repository, file), source.padEnd(159) + "\n");
  const source =
    'import { Button } from "./zz";\nfunction other(){ function Button(){} }\n<Button/>;\n';
  writeFileSync(path.join(repository, "zzz.tsx"), source);
  git(repository, "add", ".");
  git(repository, "commit", "-m", "candidate priorities");
  const document = {
    kind: "repository-file" as const,
    pullRequestId: "fixture",
    sourceOid: git(repository, "rev-parse", "HEAD"),
    path: "zzz.tsx",
  };
  const client = new GitClient();
  const extract = vi.fn(extractSymbols);
  const index = new GitCodeNavigation(client, extract);
  return { repository, document, client, extract, index };
}

describe("navigation search priority and source-work budget", () => {
  it("returns imported, current-file and same-language candidates before lower-priority family files when partial", async () => {
    const { repository, document, client, index } = fixture();
    const read = vi.spyOn(client, "readBlobDocuments");
    const result = await index.definitions(repository, document, 3, 2);
    expect(result.partial).toBe(true);
    expect(result.issues).toContain("search-limit");
    expect(result.targets.map((target) => target.document.path)).toEqual([
      "zz.js",
      "zzz.tsx",
      "z.tsx",
    ]);
    expect(result.targets[0]?.evidence).toBe("relative-import");
    expect(read.mock.calls.flatMap((call) => call[1].map((entry) => entry.path))).toEqual([
      "zz.js",
      "z.tsx",
    ]);
    index.close();
  });

  it("uses warm blobs without charging their source again, so a broad lookup can finish on retry", async () => {
    const { repository, document, client, extract, index } = fixture();
    expect((await index.definitions(repository, document, 3, 2)).partial).toBe(true);
    const read = vi.spyOn(client, "readBlobDocuments");
    const count = extract.mock.calls.length;
    const result = await index.definitions(repository, document, 3, 2);
    expect(result.partial).toBe(false);
    expect(result.targets.map((target) => target.document.path)).toEqual([
      "zz.js",
      "zzz.tsx",
      "z.tsx",
      "a.ts",
    ]);
    expect(read.mock.calls.flatMap((call) => call[1].map((entry) => entry.path))).toEqual(["a.ts"]);
    expect(extract).toHaveBeenCalledTimes(count + 1);
    read.mockClear();
    expect((await index.definitions(repository, document, 3, 2)).partial).toBe(false);
    expect(read.mock.calls.every((call) => call[1].length === 0)).toBe(true);
    expect(extract).toHaveBeenCalledTimes(count + 1);
    index.close();
  });

  it("reuses a copied blob within a batch without a second source charge", async () => {
    const { repository, document, client, index } = fixture();
    writeFileSync(
      path.join(repository, "z-copy.tsx"),
      "export function Button() { return <button/>; }".padEnd(159) + "\n",
    );
    git(repository, "add", ".");
    git(repository, "commit", "-m", "copy");
    document.sourceOid = git(repository, "rev-parse", "HEAD");
    const read = vi.spyOn(client, "readBlobDocuments");
    const result = await index.definitions(repository, document, 3, 2);
    expect(result.targets.map((target) => target.document.path)).toEqual([
      "zz.js",
      "zzz.tsx",
      "z-copy.tsx",
      "z.tsx",
    ]);
    expect(read.mock.calls.flatMap((call) => call[1])).toHaveLength(2);
    index.close();
  });

  it("still visits cached candidates after an uncached entry cannot fit the remaining budget", async () => {
    const { repository, document, client, index } = fixture();
    // Warm only the lower-priority .ts blob, then add another uncached TSX file
    // that will exhaust the budget before the cached .ts candidate is visited.
    vi.spyOn(client, "navigationPaths").mockResolvedValueOnce({
      paths: new Set(),
      truncated: false,
    });
    await index.definitions(repository, { ...document, path: "a.ts" }, 1, 18);
    writeFileSync(
      path.join(repository, "z-other.tsx"),
      "export function Button(){ return <other/>; }".padEnd(159) + "\n",
    );
    git(repository, "add", ".");
    git(repository, "commit", "-m", "more same-language candidates");
    document.sourceOid = git(repository, "rev-parse", "HEAD");
    const read = vi.spyOn(client, "readBlobDocuments");
    const result = await index.definitions(repository, document, 3, 2);
    expect(result.partial).toBe(true);
    expect(result.skippedFiles).toBe(1);
    expect(result.targets.some((target) => target.document.path === "a.ts")).toBe(true);
    expect(read.mock.calls.flatMap((call) => call[1].map((entry) => entry.path))).not.toContain(
      "a.ts",
    );
    index.close();
  });

  it("retains current-file declarations when grep truncates before finding that path", async () => {
    const { repository, document, client, index } = fixture();
    vi.spyOn(client, "navigationPaths").mockResolvedValue({ paths: new Set(), truncated: true });
    const result = await index.definitions(repository, document, 3, 2);
    expect(result.partial).toBe(true);
    expect(result.targets.map((target) => target.document.path)).toEqual(["zzz.tsx"]);
    index.close();
  });

  it("retains current-file declarations when the scan deadline expires before the first candidate batch", async () => {
    const { repository, document, client, index } = fixture();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const original = client.readBlobDocuments.bind(client);
    vi.spyOn(client, "readBlobDocuments").mockImplementation(async (...args) => {
      const result = await original(...args);
      now = NAVIGATION_LOOKUP_MS + 1;
      return result;
    });
    const result = await index.definitions(repository, document, 3, 2);
    expect(result.partial).toBe(true);
    expect(result.targets.map((target) => target.document.path)).toEqual(["zzz.tsx"]);
    index.close();
  });
});
