import { describe, expect, it } from "vitest";
import { GitHubClient } from "../../src/infrastructure/github/github-client.js";
import type { runProcess } from "../../src/infrastructure/process/run-process.js";
import {
  GITHUB_ATTACHMENT_TIMEOUT_MS,
  MAX_GITHUB_ATTACHMENT_BYTES,
  MAX_GITHUB_ATTACHMENT_STDERR_BYTES,
} from "../../src/shared/constants.js";
import { RvwError } from "../../src/shared/errors.js";

const attachmentUrl =
  "https://github.com/user-attachments/assets/37948111-1227-4cdb-a76d-dc8eb469ae5c";
const pullRequestUrl = "https://github.com/acme/review-repo/pull/7";

describe("GitHubClient Pull Request status fetching", () => {
  it("requests only state and draft metadata after one authentication check", async () => {
    const calls: Array<{ executable: string; args: readonly string[]; options: unknown }> = [];
    const runner: typeof runProcess = (executable, args, options = {}) => {
      calls.push({ executable, args, options });
      const stdout =
        args[0] === "pr"
          ? JSON.stringify({
              state: args[2] === pullRequestUrl ? "MERGED" : "OPEN",
              isDraft: false,
            })
          : "";
      return Promise.resolve({
        stdout: Buffer.from(stdout),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        stdoutTruncated: false,
      });
    };

    const secondPullRequestUrl = "https://github.com/acme/review-repo/pull/8";
    await expect(
      new GitHubClient(runner).getPullRequestStatuses([pullRequestUrl, secondPullRequestUrl]),
    ).resolves.toEqual([
      { status: "fulfilled", value: { state: "MERGED", isDraft: false } },
      { status: "fulfilled", value: { state: "OPEN", isDraft: false } },
    ]);
    expect(calls).toEqual([
      {
        executable: "gh",
        args: ["auth", "status", "--hostname", "github.com"],
        options: { allowExitCodes: [1] },
      },
      {
        executable: "gh",
        args: ["pr", "view", pullRequestUrl, "--json", "state,isDraft"],
        options: { timeoutMs: 60_000 },
      },
      {
        executable: "gh",
        args: ["pr", "view", secondPullRequestUrl, "--json", "state,isDraft"],
        options: { timeoutMs: 60_000 },
      },
    ]);
  });
});

describe("GitHubClient attachment fetching", () => {
  it("uses a binary-safe gh api argument array with bounded process output", async () => {
    const calls: Array<{
      executable: string;
      args: readonly string[];
      options: Parameters<typeof runProcess>[2];
    }> = [];
    const runner: typeof runProcess = (executable, args, options = {}) => {
      calls.push({ executable, args, options });
      return Promise.resolve({
        stdout: Buffer.from([0, 1, 2, 3]),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        stdoutTruncated: false,
      });
    };

    await expect(new GitHubClient(runner).getAttachment(attachmentUrl)).resolves.toEqual({
      content: Buffer.from([0, 1, 2, 3]),
      byteLength: 4,
    });
    expect(calls).toEqual([
      {
        executable: "gh",
        args: ["api", attachmentUrl],
        options: {
          timeoutMs: GITHUB_ATTACHMENT_TIMEOUT_MS,
          maxStdoutBytes: MAX_GITHUB_ATTACHMENT_BYTES,
          maxStderrBytes: MAX_GITHUB_ATTACHMENT_STDERR_BYTES,
        },
      },
    ]);
  });

  it("rejects invalid URLs before starting gh", async () => {
    let called = false;
    const runner: typeof runProcess = () => {
      called = true;
      return Promise.reject(new Error("must not run"));
    };
    await expect(
      new GitHubClient(runner).getAttachment(
        "https://github.com.evil.example/user-attachments/assets/37948111-1227-4cdb-a76d-dc8eb469ae5c",
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(called).toBe(false);
  });

  it("maps stdout overflow and hides process details from fetch errors", async () => {
    const overflowRunner: typeof runProcess = () =>
      Promise.reject(
        new RvwError("PROCESS_OUTPUT_LIMIT", "too much", {
          details: { stream: "stdout", maxBytes: MAX_GITHUB_ATTACHMENT_BYTES },
        }),
      );
    await expect(
      new GitHubClient(overflowRunner).getAttachment(attachmentUrl),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE", status: 413, details: undefined });

    const failedRunner: typeof runProcess = () =>
      Promise.reject(
        new RvwError("PROCESS_FAILED", "private details", {
          details: { args: ["api", attachmentUrl], stderr: "secret failure" },
        }),
      );
    await expect(new GitHubClient(failedRunner).getAttachment(attachmentUrl)).rejects.toMatchObject(
      {
        code: "GITHUB_ERROR",
        status: 502,
        details: undefined,
      },
    );
  });
});
