import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/application/runtime.js";
import { createProgram } from "../../src/cli/main.js";
import { RvwDatabase } from "../../src/infrastructure/db/database.js";
import { startRuntimeAgentSocket } from "../../src/server/agent-socket.js";

afterEach(() => vi.restoreAllMocks());

it("lists and archives through both direct CLI and an explicit Agent socket", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-archive-cli-"));
  const filePath = path.join(directory, "rvw.db");
  const database = new RvwDatabase({ filePath });
  const saved = database.upsertPullRequest(
    {
      host: "github.com",
      owner: "acme",
      repository: "repo",
      number: 7,
      url: "https://github.com/acme/repo/pull/7",
      authorLogin: null,
      headRepositoryOwner: "acme",
      headRepositoryName: "repo",
      title: "Review",
      body: "",
      baseRefName: "main",
      headRefName: "feature",
      baseOid: "a".repeat(40),
      headOid: "b".repeat(40),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      state: "OPEN",
      isDraft: false,
      approvalCount: 0,
    },
    { localRepositoryPath: "/nonexistent", gitCommonDir: "/nonexistent/.git" },
    "a".repeat(40),
  );
  database.close();
  const originalDatabase = process.env.RVW_DATABASE_PATH;
  const originalSocket = process.env.RVW_AGENT_SOCKET_PATH;
  let running: Awaited<ReturnType<typeof startRuntimeAgentSocket>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    process.env.RVW_DATABASE_PATH = filePath;
    delete process.env.RVW_AGENT_SOCKET_PATH;
    const run = async (...args: string[]) => {
      output = "";
      await createProgram().parseAsync(["node", "rvw", "pr", ...args, "--json"]);
      return JSON.parse(output) as {
        pullRequest?: { archivedAt: string | null };
        items?: { pullRequestId: string; archivedAt: string | null }[];
        pagination?: { total: number };
      };
    };
    expect((await run("archive", saved.url)).pullRequest?.archivedAt).toEqual(expect.any(String));
    expect((await run("list")).pagination?.total).toBe(0);
    expect((await run("list", "--include-archived")).items).toMatchObject([
      { pullRequestId: saved.id, archivedAt: expect.any(String) as unknown },
    ]);
    process.env.RVW_AGENT_SOCKET_PATH = path.join(directory, "agent.sock");
    running = await startRuntimeAgentSocket(filePath);
    runtime = createRuntime({ database: { filePath } });
    running.setHandler({ service: runtime.service, openViewer: vi.fn() });
    expect((await run("unarchive", saved.url)).pullRequest?.archivedAt).toBeNull();
    expect((await run("list")).pagination?.total).toBe(1);
    const archived = await run("archive", "7");
    expect((await run("archive", "7")).pullRequest?.archivedAt).toBe(
      archived.pullRequest?.archivedAt,
    );
    expect(
      (await run("list", "--include-archived", "--include-closed", "--limit", "1")).items,
    ).toHaveLength(1);
  } finally {
    await running?.close();
    runtime?.close();
    if (originalDatabase === undefined) delete process.env.RVW_DATABASE_PATH;
    else process.env.RVW_DATABASE_PATH = originalDatabase;
    if (originalSocket === undefined) delete process.env.RVW_AGENT_SOCKET_PATH;
    else process.env.RVW_AGENT_SOCKET_PATH = originalSocket;
  }
});
