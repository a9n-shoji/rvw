import { z } from "zod";
import type { GitHubPullRequest } from "../../domain/models.js";
import {
  GITHUB_ATTACHMENT_TIMEOUT_MS,
  GIT_OBJECT_ID_PATTERN,
  MAX_GITHUB_ATTACHMENT_BYTES,
  MAX_GITHUB_ATTACHMENT_STDERR_BYTES,
} from "../../shared/constants.js";
import { RvwError } from "../../shared/errors.js";
import { canonicalGitHubAttachmentUrl } from "../../shared/image-assets.js";
import { runProcess, runText } from "../process/run-process.js";

export interface GitHubPort {
  doctor(): Promise<{ version: string; authenticated: boolean }>;
  getPullRequestStatuses(references: readonly string[]): Promise<GitHubPullRequestStatusResult[]>;
  getPullRequest(
    reference: string | undefined,
    cwd: string,
    options?: { allowClosed?: boolean },
  ): Promise<GitHubPullRequest>;
  getAttachment(absoluteUrl: string): Promise<{ content: Buffer; byteLength: number }>;
}

export interface GitHubPullRequestStatus {
  state: GitHubPullRequest["state"];
  isDraft: boolean;
}

export type GitHubPullRequestStatusResult =
  { status: "fulfilled"; value: GitHubPullRequestStatus } | { status: "rejected"; error: unknown };

type ProcessRunner = typeof runProcess;

const ghPullRequestSchema = z.object({
  author: z.object({ login: z.string().min(1) }).nullable(),
  headRepository: z.object({ name: z.string().min(1) }).nullable(),
  headRepositoryOwner: z.object({ login: z.string().min(1) }).nullable(),
  number: z.number().int().positive(),
  url: z.url(),
  title: z.string(),
  body: z.string().nullable(),
  updatedAt: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  baseRefName: z.string().min(1),
  baseRefOid: z.string().regex(GIT_OBJECT_ID_PATTERN),
  headRefName: z.string().min(1),
  headRefOid: z.string().regex(GIT_OBJECT_ID_PATTERN),
  createdAt: z.string(),
});

const ghPullRequestStatusSchema = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
});

export function parsePullRequestUrl(url: string): {
  owner: string;
  repository: string;
  number: number;
} {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(url);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new RvwError("INVALID_INPUT", `GitHub Pull Request URLが不正です: ${url}`);
  }
  return { owner: match[1], repository: match[2], number: Number(match[3]) };
}

export class GitHubClient implements GitHubPort {
  constructor(private readonly processRunner: ProcessRunner = runProcess) {}

  async doctor(): Promise<{ version: string; authenticated: boolean }> {
    const version = await runText("gh", ["--version"]);
    const auth = await runProcess("gh", ["auth", "status", "--hostname", "github.com"], {
      allowExitCodes: [1],
    });
    return { version: version.split("\n")[0] ?? version, authenticated: auth.exitCode === 0 };
  }

  async assertAuthenticated(): Promise<void> {
    const status = await this.processRunner("gh", ["auth", "status", "--hostname", "github.com"], {
      allowExitCodes: [1],
    });
    if (status.exitCode !== 0) {
      throw new RvwError("GH_NOT_AUTHENTICATED", "GitHub CLIがgithub.comへ認証されていません。", {
        suggestions: ["gh auth login", "gh auth setup-git"],
      });
    }
  }

  private async getPullRequestStatus(reference: string): Promise<GitHubPullRequestStatus> {
    let output: string;
    try {
      const result = await this.processRunner(
        "gh",
        ["pr", "view", reference, "--json", "state,isDraft"],
        { timeoutMs: 60_000 },
      );
      output = result.stdout.toString("utf8").trimEnd();
    } catch (error) {
      if (error instanceof RvwError && error.code === "PROCESS_FAILED") {
        throw new RvwError("GITHUB_ERROR", "Pull Request状態をGitHubから取得できませんでした。", {
          cause: error,
          details: error.details,
          suggestions: ["PR URLとgh認証を確認してください。"],
        });
      }
      throw error;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(output);
    } catch (error) {
      throw new RvwError("GITHUB_ERROR", "GitHub CLIのPull Request状態応答が不正です。", {
        cause: error,
      });
    }
    const parsed = ghPullRequestStatusSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new RvwError("GITHUB_ERROR", "GitHub CLIのPull Request状態応答が不正です。", {
        details: parsed.error.flatten(),
      });
    }
    return parsed.data;
  }

  async getPullRequestStatuses(
    references: readonly string[],
  ): Promise<GitHubPullRequestStatusResult[]> {
    if (references.length === 0) return [];
    await this.assertAuthenticated();
    const outcomes: Array<GitHubPullRequestStatusResult | undefined> = Array.from(
      { length: references.length },
      () => undefined,
    );
    let nextIndex = 0;
    const workerCount = Math.min(4, references.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < references.length) {
          const index = nextIndex;
          nextIndex += 1;
          const reference = references[index];
          if (!reference) continue;
          try {
            outcomes[index] = {
              status: "fulfilled",
              value: await this.getPullRequestStatus(reference),
            };
          } catch (error) {
            outcomes[index] = { status: "rejected", error };
          }
        }
      }),
    );
    return outcomes.map((outcome) => {
      if (!outcome) {
        throw new RvwError("INTERNAL_ERROR", "Pull Request状態の一括取得結果が不足しています。", {
          status: 500,
        });
      }
      return outcome;
    });
  }

  async getPullRequest(
    reference: string | undefined,
    cwd: string,
    options: { allowClosed?: boolean } = {},
  ): Promise<GitHubPullRequest> {
    await this.assertAuthenticated();
    const fields = [
      "author",
      "number",
      "url",
      "title",
      "body",
      "createdAt",
      "updatedAt",
      "state",
      "isDraft",
      "baseRefName",
      "baseRefOid",
      "headRefName",
      "headRefOid",
      "headRepository",
      "headRepositoryOwner",
    ].join(",");
    const args = ["pr", "view"];
    if (reference !== undefined && reference.length > 0) args.push(reference);
    args.push("--json", fields);
    let output: string;
    try {
      output = await runText("gh", args, { cwd, timeoutMs: 60_000 });
    } catch (error) {
      if (error instanceof RvwError && error.code === "PROCESS_FAILED") {
        throw new RvwError("GITHUB_ERROR", "Pull Request情報をGitHubから取得できませんでした。", {
          cause: error,
          details: error.details,
          suggestions: ["PR URLまたは番号とgh認証を確認してください。"],
        });
      }
      throw error;
    }
    const parsed = ghPullRequestSchema.safeParse(JSON.parse(output));
    if (!parsed.success) {
      throw new RvwError("GITHUB_ERROR", "GitHub CLIのPull Request応答が不正です。", {
        details: parsed.error.flatten(),
      });
    }
    if (parsed.data.state !== "OPEN" && !options.allowClosed) {
      throw new RvwError(
        "GITHUB_PR_NOT_OPEN",
        "ClosedまたはMerged Pull Requestは新規登録の対象外です。",
      );
    }
    const identity = parsePullRequestUrl(parsed.data.url);
    return {
      host: "github.com",
      owner: identity.owner,
      repository: identity.repository,
      number: parsed.data.number,
      url: parsed.data.url,
      authorLogin: parsed.data.author?.login ?? null,
      headRepositoryOwner: parsed.data.headRepositoryOwner?.login ?? null,
      headRepositoryName: parsed.data.headRepository?.name ?? null,
      title: parsed.data.title,
      body: parsed.data.body ?? "",
      baseRefName: parsed.data.baseRefName,
      baseOid: parsed.data.baseRefOid,
      headRefName: parsed.data.headRefName,
      headOid: parsed.data.headRefOid,
      createdAt: parsed.data.createdAt,
      updatedAt: parsed.data.updatedAt,
      state: parsed.data.state,
      isDraft: parsed.data.isDraft,
    };
  }

  async getAttachment(absoluteUrl: string): Promise<{ content: Buffer; byteLength: number }> {
    const canonicalUrl = canonicalGitHubAttachmentUrl(absoluteUrl);
    if (!canonicalUrl) {
      throw new RvwError("INVALID_INPUT", "GitHub user attachment URLが不正です。");
    }
    try {
      const result = await this.processRunner("gh", ["api", canonicalUrl], {
        timeoutMs: GITHUB_ATTACHMENT_TIMEOUT_MS,
        maxStdoutBytes: MAX_GITHUB_ATTACHMENT_BYTES,
        maxStderrBytes: MAX_GITHUB_ATTACHMENT_STDERR_BYTES,
      });
      return { content: result.stdout, byteLength: result.stdout.byteLength };
    } catch (error) {
      if (
        error instanceof RvwError &&
        error.code === "PROCESS_OUTPUT_LIMIT" &&
        (error.details as { stream?: unknown } | undefined)?.stream === "stdout"
      ) {
        throw new RvwError("FILE_TOO_LARGE", "GitHub attachmentは10 MiB以下にしてください。", {
          status: 413,
        });
      }
      throw new RvwError(
        "GITHUB_ERROR",
        "GitHub attachmentを取得できませんでした。gh認証と画像の閲覧権限を確認してください。",
        { status: 502 },
      );
    }
  }
}
