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
  getPullRequest(reference: string | undefined, cwd: string): Promise<GitHubPullRequest>;
  getAttachment(absoluteUrl: string): Promise<{ content: Buffer; byteLength: number }>;
}

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
    const status = await runProcess("gh", ["auth", "status", "--hostname", "github.com"], {
      allowExitCodes: [1],
    });
    if (status.exitCode !== 0) {
      throw new RvwError("GH_NOT_AUTHENTICATED", "GitHub CLIがgithub.comへ認証されていません。", {
        suggestions: ["gh auth login", "gh auth setup-git"],
      });
    }
  }

  async getPullRequest(reference: string | undefined, cwd: string): Promise<GitHubPullRequest> {
    await this.assertAuthenticated();
    const fields = [
      "author",
      "number",
      "url",
      "title",
      "body",
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
    if (parsed.data.state !== "OPEN") {
      throw new RvwError(
        "GITHUB_PR_NOT_OPEN",
        "Closedまたはmerged Pull RequestはPhase 1の対象外です。",
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
      updatedAt: parsed.data.updatedAt,
      state: "OPEN",
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
