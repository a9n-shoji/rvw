import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createRuntime } from "../../src/application/runtime.js";
import type { GitHubPullRequest } from "../../src/domain/models.js";
import { startAgentSocket } from "../../src/server/agent-socket.js";
import { startServer } from "../../src/server/start-server.js";
import { commitFile, createGitRepository, git } from "../fixtures/git-repository.js";

function syncThroughCli(databasePath: string, socketPath: string, input: unknown) {
  return new Promise<{ code: number | null; output: string; error: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve("dist/cli.mjs"), "pr", "sync", "--stdin", "--json"],
      {
        env: {
          ...process.env,
          RVW_DATABASE_PATH: databasePath,
          RVW_AGENT_SOCKET_PATH: socketPath,
        },
        stdio: "pipe",
        timeout: 10_000,
      },
    );
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      error += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output, error }));
    child.stdin.end(JSON.stringify(input));
  });
}

for (const selection of ["latest", "historical"] as const) {
  test(`CLI synchronization updates an open viewer with a ${selection} selection`, async ({
    page,
  }) => {
    const repository = createGitRepository("rvw-sync-e2e-");
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-sync-e2e-db-"));
    const baseOid = git(repository, "rev-parse", "HEAD");
    git(repository, "switch", "-c", "feature");
    commitFile(repository, "source.txt", "before worker\n", "First implementation");
    const initialHead = commitFile(
      repository,
      "README.md",
      "# Initial explanation\n",
      "Initial explanation",
    );
    let githubState: GitHubPullRequest = {
      host: "github.com",
      owner: "acme",
      repository: "review-repo",
      number: 7,
      url: "https://github.com/acme/review-repo/pull/7",
      authorLogin: "review-author",
      headRepositoryOwner: "acme",
      headRepositoryName: "review-repo",
      title: "Before worker",
      body: "Initial PR body.",
      baseRefName: "main",
      baseOid,
      headRefName: "feature",
      headOid: initialHead,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      state: "OPEN",
      isDraft: false,
      approvalCount: 0,
    };
    const databasePath = path.join(directory, "review.db");
    const runtime = createRuntime({
      database: { filePath: databasePath, migrationsDirectory: "./migrations" },
      github: {
        doctor: () => Promise.resolve({ version: "test", authenticated: true }),
        getPullRequest: () => Promise.resolve(githubState),
        getPullRequestStatuses: () => Promise.resolve([]),
        getAttachment: () => Promise.reject(new Error("not used")),
      },
    });
    const originalSocketPath = process.env.RVW_AGENT_SOCKET_PATH;
    // Keep the socket path short enough for macOS's Unix-domain socket limit.
    const socketPath = path.join(directory, "agent.sock");
    process.env.RVW_AGENT_SOCKET_PATH = socketPath;
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let socket: Awaited<ReturnType<typeof startAgentSocket>> | undefined;
    try {
      const opened = await runtime.service.openPullRequest(undefined, repository);
      socket = await startAgentSocket(runtime.service);
      server = await startServer(runtime.service, { staticDirectory: path.resolve("dist/web") });
      const initialRefresh = page.waitForResponse((response) =>
        response.url().endsWith(`/api/pull-requests/${opened.pullRequest.id}/refresh`),
      );
      await page.goto(`${server.origin}/?pullRequestId=${opened.pullRequest.id}`);
      await initialRefresh;
      const picker = page.getByRole("button", { name: /^対象commit:/ });
      if (selection === "historical") {
        await picker.click();
        await page.getByRole("option", { name: /First implementation/ }).click();
      }
      await page.getByRole("button", { name: "source.txt", exact: true }).click();
      await expect(page.getByText("before worker", { exact: true })).toBeVisible();
      const tabsBefore = await page.getByRole("tab").allTextContents();
      const navigationBefore = await page.evaluate(() => performance.timeOrigin);

      const pushedHead = commitFile(repository, "source.txt", "after worker\n", "Worker fix");
      githubState = {
        ...githubState,
        title: "After worker",
        body: "Updated PR body.",
        headOid: pushedHead,
      };
      const synced = await syncThroughCli(databasePath, socketPath, {
        pullRequest: githubState.url,
      });
      expect(synced.code, synced.error).toBe(0);
      expect(JSON.parse(synced.output)).toMatchObject({
        ok: true,
        headOid: pushedHead,
        commentUpdatesApplied: 0,
      });
      await expect(page.locator(".pr-heading h1")).toHaveText("After worker");
      await expect(
        page.getByText(selection === "latest" ? "after worker" : "before worker", { exact: true }),
      ).toBeVisible();
      await expect(picker).toHaveAccessibleName(
        selection === "latest" ? /3 commits.*PR全体/ : /First implementation/,
      );
      expect(await page.getByRole("tab").allTextContents()).toEqual(tabsBefore);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(navigationBefore);
      if (selection === "historical") {
        await picker.click();
        await expect(page.getByRole("option", { name: /First implementation/ })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect(page.getByRole("option", { name: /Worker fix/ })).toHaveAttribute(
          "aria-selected",
          "false",
        );
        await page.keyboard.press("Escape");
      }
      await page.getByRole("tab", { name: "Pull Request.md", exact: true }).click();
      await expect(page.getByText("Updated PR body.", { exact: true })).toBeVisible();
    } finally {
      await page.close();
      await server?.close();
      await socket?.close();
      runtime.close();
      if (originalSocketPath === undefined) delete process.env.RVW_AGENT_SOCKET_PATH;
      else process.env.RVW_AGENT_SOCKET_PATH = originalSocketPath;
      rmSync(directory, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
    }
  });
}
