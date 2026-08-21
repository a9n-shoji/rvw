import { z } from "zod";
import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepository,
  RepositoryIdentity,
} from "../../domain/models.js";
import { GIT_OBJECT_ID_PATTERN } from "../../shared/constants.js";
import { RvwError } from "../../shared/errors.js";
import { runProcess, runText } from "../process/run-process.js";

export interface GitHubPort {
  doctor(): Promise<{ version: string; authenticated: boolean }>;
  getPullRequest(reference: string | undefined, cwd: string): Promise<GitHubPullRequest>;
  getRepository?(identity: RepositoryIdentity, cwd: string): Promise<GitHubRepository>;
  getIssue?(number: number, identity: RepositoryIdentity, cwd: string): Promise<GitHubIssue>;
}

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

const ghRepositorySchema = z.object({
  full_name: z.string().regex(/^[^/]+\/[^/]+$/),
  default_branch: z.string().min(1),
});

const ghRefSchema = z.object({
  object: z.object({ sha: z.string().regex(GIT_OBJECT_ID_PATTERN) }),
});

const ghIssueSchema = z
  .object({
    number: z.number().int().positive(),
    html_url: z.url(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(["open", "closed"]),
    updated_at: z.string(),
    pull_request: z.unknown().optional(),
  })
  .passthrough();

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

export function parseIssueReference(
  reference: string,
  repository: Pick<RepositoryIdentity, "owner" | "repository">,
): { owner: string; repository: string; number: number } {
  const short = /^#(\d+)$/.exec(reference.trim());
  if (short?.[1]) {
    return { ...repository, number: Number(short[1]) };
  }
  const qualified = /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/.exec(reference.trim());
  if (qualified?.[1] && qualified[2] && qualified[3]) {
    return { owner: qualified[1], repository: qualified[2], number: Number(qualified[3]) };
  }
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/.exec(
    reference.trim(),
  );
  if (url?.[1] && url[2] && url[3]) {
    return { owner: url[1], repository: url[2], number: Number(url[3]) };
  }
  throw new RvwError("INVALID_INPUT", `GitHub Issue参照が不正です: ${reference}`);
}

export class GitHubClient implements GitHubPort {
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

  async getRepository(identity: RepositoryIdentity, cwd: string): Promise<GitHubRepository> {
    await this.assertAuthenticated();
    const repositoryPath = `repos/${identity.owner}/${identity.repository}`;
    try {
      const metadata = ghRepositorySchema.parse(
        JSON.parse(await runText("gh", ["api", repositoryPath], { cwd, timeoutMs: 60_000 })),
      );
      const encodedBranch = metadata.default_branch.split("/").map(encodeURIComponent).join("/");
      const ref = ghRefSchema.parse(
        JSON.parse(
          await runText("gh", ["api", `${repositoryPath}/git/ref/heads/${encodedBranch}`], {
            cwd,
            timeoutMs: 60_000,
          }),
        ),
      );
      const [owner, repository] = metadata.full_name.split("/");
      if (!owner || !repository) throw new Error("invalid full_name");
      return {
        host: "github.com",
        owner,
        repository,
        canonicalName: `${owner}/${repository}`,
        defaultBranchName: metadata.default_branch,
        defaultBranchOid: ref.object.sha,
      };
    } catch (error) {
      throw new RvwError(
        "GITHUB_REPOSITORY_ERROR",
        "GitHub repository情報を取得できませんでした。",
        {
          cause: error,
          suggestions: ["repositoryへのaccessとgh認証を確認してください。"],
        },
      );
    }
  }

  async getIssue(number: number, identity: RepositoryIdentity, cwd: string): Promise<GitHubIssue> {
    await this.assertAuthenticated();
    try {
      const data = ghIssueSchema.parse(
        JSON.parse(
          await runText(
            "gh",
            ["api", `repos/${identity.owner}/${identity.repository}/issues/${number}`],
            { cwd, timeoutMs: 60_000 },
          ),
        ),
      );
      if (data.pull_request !== undefined) {
        throw new RvwError(
          "GITHUB_ISSUE_IS_PULL_REQUEST",
          `#${number}はIssueではなくPull Requestです。`,
        );
      }
      return {
        host: "github.com",
        owner: identity.owner,
        repository: identity.repository,
        canonicalName: `${identity.owner}/${identity.repository}`,
        number: data.number,
        url: data.html_url,
        title: data.title,
        body: data.body ?? "",
        state: data.state === "open" ? "OPEN" : "CLOSED",
        updatedAt: data.updated_at,
      };
    } catch (error) {
      if (error instanceof RvwError && error.code === "GITHUB_ISSUE_IS_PULL_REQUEST") throw error;
      throw new RvwError("GITHUB_ISSUE_ERROR", `GitHub Issue #${number}を取得できませんでした。`, {
        cause: error,
      });
    }
  }
}
