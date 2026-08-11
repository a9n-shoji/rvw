import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import openBrowser from "open";
import { z } from "zod";
import { createRuntime, type Runtime } from "../application/runtime.js";
import { SkillInstaller, type SkillPlatform } from "../infrastructure/skills/skill-installer.js";
import { APP_VERSION, DEFAULT_COMMENT_LIST_LIMIT, PROTOCOL_VERSION } from "../shared/constants.js";
import { asRvwError, RvwError } from "../shared/errors.js";
import { startServer, type RunningServer } from "../server/start-server.js";
import { formatCommentGetOutput, formatCommentListOutput } from "./comment-protocol.js";
import {
  commentListOptionsSchema,
  commentReplyInputSchema,
  pullRequestSyncInputSchema,
  walkthroughPublishInputSchema,
  walkthroughUpdateInputSchema,
} from "./schemas.js";

const MAX_STDIN_BYTES = 1024 * 1024;
declare const __RVW_CLI_BUNDLE__: boolean | undefined;

interface OutputOptions {
  json?: boolean;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeOutput(options: OutputOptions, value: unknown, human: string): void {
  if (options.json) writeJson(value);
  else process.stdout.write(`${human}\n`);
}

async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > MAX_STDIN_BYTES) {
      throw new RvwError(
        "INVALID_INPUT",
        `stdin JSONは${MAX_STDIN_BYTES} bytes以下にしてください。`,
      );
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new RvwError("INVALID_INPUT", "stdinのJSONを解析できません。", { cause: error });
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidArgumentError("portは0〜65535の整数です。");
  }
  return port;
}

function parsePlatform(value: string): SkillPlatform {
  if (value === "codex" || value === "claude") return value;
  throw new InvalidArgumentError("platformはcodexまたはclaudeです。");
}

export type ServerShutdownReason = "signal" | "viewers-closed";

export function waitForServerShutdown(
  allViewersClosed: Promise<void> | null,
): Promise<ServerShutdownReason> {
  return new Promise<ServerShutdownReason>((resolve) => {
    let settled = false;
    const finish = (reason: ServerShutdownReason): void => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve(reason);
    };
    const onSignal = (): void => finish("signal");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    if (allViewersClosed) {
      void allViewersClosed.then(() => finish("viewers-closed"));
    }
  });
}

function staticDirectory(): string {
  const executableDirectory = path.dirname(path.resolve(process.argv[1] ?? process.cwd()));
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, "web"),
    path.resolve(executableDirectory, "web"),
    path.resolve(executableDirectory, "../dist/web"),
    path.resolve(process.cwd(), "dist/web"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function createProgram(runtimeFactory: () => Runtime = () => createRuntime()): Command {
  let runtime: Runtime | undefined;
  const getRuntime = (): Runtime => (runtime ??= runtimeFactory());
  const program = new Command();
  program
    .name("rvw")
    .description("GitHub Pull Requestをcommit単位で閲覧・コメントするローカルviewer")
    .version(APP_VERSION)
    .showHelpAfterError();

  program
    .command("doctor")
    .description("git、gh認証、repository、DBを確認")
    .option("--json", "JSONで出力")
    .action(async (options: OutputOptions) => {
      const result = await getRuntime().service.doctor(process.cwd());
      writeOutput(options, result, result.ok ? "rvwを利用できます。" : "gh認証が必要です。");
      if (!result.ok) process.exitCode = 2;
    });

  program
    .command("protocol")
    .description("Agent向けCLI protocol情報を表示")
    .option("--json", "JSONで出力")
    .action((options: OutputOptions) => {
      const result = {
        protocolVersion: PROTOCOL_VERSION,
        appVersion: APP_VERSION,
        capabilities: [
          "comment.list",
          "comment.read",
          "comment.reply",
          "comment.resolve",
          "comment.reopen",
          "pullRequest.sync",
          "walkthrough.read",
          "walkthrough.publish",
          "walkthrough.update",
          "walkthrough.delete",
        ],
      };
      writeOutput(options, result, `rvw protocol ${PROTOCOL_VERSION}`);
    });

  program
    .command("open")
    .argument("[pull-request]", "PR URLまたは番号")
    .option("--no-open", "ブラウザを開かない")
    .option("--port <port>", "listen port（0は自動）", parsePort, 0)
    .description("Pull Requestを開いてローカルviewerを起動")
    .action(async (reference: string | undefined, options: { open: boolean; port: number }) => {
      const activeRuntime = getRuntime();
      let running: RunningServer | undefined;
      try {
        const opened = await activeRuntime.service.openPullRequest(reference, process.cwd());
        running = await startServer(activeRuntime.service, {
          port: options.port,
          staticDirectory: staticDirectory(),
          autoCloseWhenNoViewers: options.open,
        });
        const url = new URL(running.origin);
        url.searchParams.set("pullRequestId", opened.pullRequest.id);
        process.stdout.write(`rvw: ${url.toString()}\n`);
        if (options.open) await openBrowser(url.toString());
        const reason = await waitForServerShutdown(running.allViewersClosed);
        if (reason === "viewers-closed") {
          process.stdout.write("rvw: viewerを閉じたためserverを停止します。\n");
        }
      } finally {
        try {
          await running?.close();
        } finally {
          activeRuntime.close();
        }
      }
    });

  const pr = program.command("pr").description("Pull Request状態を管理");
  pr.command("refresh")
    .argument("<pull-request>", "登録済みPR URLまたは番号")
    .option("--json", "JSONで出力")
    .action(async (reference: string, options: OutputOptions) => {
      const result = await getRuntime().service.refreshByReference(reference);
      writeOutput(
        options,
        { ok: true, ...result },
        `${result.commits.length}件のPR commitを同期しました。`,
      );
    });

  pr.command("sync")
    .requiredOption("--stdin", "stdinからJSONを読む")
    .requiredOption("--json", "JSONで出力")
    .action(async () => {
      const input = pullRequestSyncInputSchema.parse(await readStdinJson());
      const result = await getRuntime().service.syncPullRequest({
        pullRequest: input.pullRequest,
        commentUpdates: input.commentUpdates ?? [],
      });
      writeJson({ ok: true, ...result });
    });

  pr.command("reset")
    .argument("<pull-request>", "登録済みPR URLまたは番号")
    .option("--yes", "不可逆な削除を確認")
    .option("--json", "JSONで出力")
    .action(async (reference: string, options: OutputOptions & { yes?: boolean }) => {
      const service = getRuntime().service;
      const pullRequest = service.resolveStoredPullRequest(reference);
      if (!options.yes) {
        const preview = await service.getResetPreview(pullRequest.id);
        const result = {
          ok: false,
          error: {
            code: "RESET_CONFIRMATION_REQUIRED",
            message: "resetには--yesが必要です。",
            suggestions: [`rvw pr reset ${reference} --yes`],
          },
          ...preview,
        };
        writeOutput(
          options,
          result,
          `削除対象: コメント${preview.counts.comments}、返信${preview.counts.posts}、対象${preview.counts.targets}、Walkthrough${preview.counts.walkthroughs}、コード参照${preview.counts.walkthroughReferences}、Git ref${preview.counts.gitRefs}\n続行するには --yes を指定してください。`,
        );
        process.exitCode = 2;
        return;
      }
      const result = await service.resetPullRequest(pullRequest.id);
      writeOutput(
        options,
        { ok: true, ...result },
        `${result.pullRequest.latestHeadOid.slice(0, 12)}を最新headとして再構築しました。`,
      );
    });

  const comment = program.command("comment").description("保存済みコメントを操作");

  const walkthrough = program.command("walkthrough").description("コード参照付きwalkthroughを管理");
  walkthrough
    .command("publish")
    .requiredOption("--stdin", "stdinからJSONを読む")
    .requiredOption("--json", "JSONで出力")
    .description("walkthroughを登録（viewerは開かずnavigationも変更しない）")
    .action(async () => {
      const input = walkthroughPublishInputSchema.parse(await readStdinJson());
      const published = await getRuntime().service.publishWalkthrough({
        pullRequest: input.pullRequest,
        sourceOid: input.sourceOid,
        title: input.title,
        body: input.body,
        references: input.references,
        ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
        ...(input.diagramBindings === undefined ? {} : { diagramBindings: input.diagramBindings }),
      });
      writeJson({ ok: true, walkthrough: published });
    });

  walkthrough
    .command("get")
    .argument("<walkthrough-uri>")
    .requiredOption("--json", "JSONで出力")
    .description("walkthroughの現在内容を取得")
    .action((uri: string) => {
      writeJson({ ok: true, ...getRuntime().service.getWalkthroughByUri(uri) });
    });

  walkthrough
    .command("update")
    .argument("<walkthrough-uri>")
    .requiredOption("--stdin", "stdinからJSONを読む")
    .requiredOption("--json", "JSONで出力")
    .description("walkthroughを同じ参照のまま更新")
    .action(async (uri: string) => {
      const input = walkthroughUpdateInputSchema.parse(await readStdinJson());
      const updated = await getRuntime().service.updateWalkthrough(uri, {
        sourceOid: input.sourceOid,
        title: input.title,
        body: input.body,
        references: input.references,
        ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
        ...(input.diagramBindings === undefined ? {} : { diagramBindings: input.diagramBindings }),
      });
      writeJson({ ok: true, walkthrough: updated });
    });

  walkthrough
    .command("delete")
    .argument("<walkthrough-uri>")
    .option("--yes", "不可逆な削除を確認")
    .requiredOption("--json", "JSONで出力")
    .description("walkthroughと紐づくコメントを削除")
    .action((uri: string, options: OutputOptions & { yes?: boolean }) => {
      const service = getRuntime().service;
      if (!options.yes) {
        const preview = service.getWalkthroughDeletePreview(uri);
        writeJson({
          ok: false,
          error: {
            code: "WALKTHROUGH_DELETE_CONFIRMATION_REQUIRED",
            message: "walkthrough deleteには--yesが必要です。",
            suggestions: [`rvw walkthrough delete ${uri} --yes --json`],
          },
          ...preview,
        });
        process.exitCode = 2;
        return;
      }
      writeJson({ ok: true, deleted: service.deleteWalkthroughByUri(uri) });
    });

  comment
    .command("list")
    .argument("<pull-request>", "登録済みPR URLまたは番号")
    .option("--state <state>", "unresolved、resolved、all（既定: unresolved）", "unresolved")
    .option(
      "--limit <limit>",
      `1ページの最大件数（既定: ${DEFAULT_COMMENT_LIST_LIMIT}）`,
      String(DEFAULT_COMMENT_LIST_LIMIT),
    )
    .option("--offset <offset>", "取得開始位置（既定: 0）", "0")
    .requiredOption("--json", "JSONで出力")
    .action(async (reference: string, rawOptions: unknown) => {
      const options = commentListOptionsSchema.parse(rawOptions);
      const resolved = options.state === "all" ? undefined : options.state === "resolved";
      const result = await getRuntime().service.listCommentReviewContexts(reference, resolved, {
        limit: options.limit,
        offset: options.offset,
      });
      writeJson(formatCommentListOutput(result, options.state));
    });

  comment
    .command("get")
    .argument("<comment-uri>")
    .option("--include-pr-body", "最新のPR本文をpullRequest.bodyに含める")
    .requiredOption("--json", "JSONで出力")
    .action(async (uri: string, options: { includePrBody?: boolean }) => {
      const result = await getRuntime().service.getCommentReviewContext(uri);
      writeJson(formatCommentGetOutput(result, { includePrBody: options.includePrBody ?? false }));
    });

  comment
    .command("reply")
    .argument("<comment-uri>")
    .requiredOption("--stdin", "stdinからJSONを読む")
    .requiredOption("--json", "JSONで出力")
    .action(async (uri: string) => {
      const input = commentReplyInputSchema.parse(await readStdinJson());
      const post = await getRuntime().service.replyToComment(uri, {
        body: input.body,
        ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
        ...(input.relatedCommitOid === undefined
          ? {}
          : { relatedCommitOid: input.relatedCommitOid }),
      });
      writeJson({ ok: true, post });
    });

  comment
    .command("resolve")
    .argument("<comment-uri>")
    .requiredOption("--json", "JSONで出力")
    .action((uri: string) =>
      writeJson({ ok: true, comment: getRuntime().service.setCommentResolved(uri, true) }),
    );

  comment
    .command("reopen")
    .argument("<comment-uri>")
    .requiredOption("--json", "JSONで出力")
    .action((uri: string) =>
      writeJson({ ok: true, comment: getRuntime().service.setCommentResolved(uri, false) }),
    );

  const skill = program.command("skill").description("Codex / Claude Code向けrvw Skillを管理");
  skill
    .command("install")
    .argument("<platform>", "codexまたはclaude", parsePlatform)
    .option("--force", "差異がある既存Skillを置換")
    .option("--target <skills-root>", "Skill rootを上書き")
    .option("--json", "JSONで出力")
    .action(
      (platform: SkillPlatform, options: OutputOptions & { force?: boolean; target?: string }) => {
        const statuses = new SkillInstaller().install(platform, {
          force: options.force ?? false,
          ...(options.target === undefined ? {} : { targetRoot: options.target }),
        });
        writeOutput(
          options,
          { ok: true, skills: statuses },
          statuses
            .map((status) => `${status.name}を${status.path}へインストールしました。`)
            .join("\n"),
        );
      },
    );

  skill
    .command("status")
    .argument("[platform]", "codexまたはclaude", parsePlatform)
    .option("--target <skills-root>", "Skill rootを上書き")
    .option("--json", "JSONで出力")
    .action((platform: SkillPlatform | undefined, options: OutputOptions & { target?: string }) => {
      const statuses = new SkillInstaller().statuses(platform, options.target);
      writeOutput(
        options,
        { ok: true, skills: statuses },
        statuses
          .map(
            (status) =>
              `${status.name}: ${status.installed ? (status.matchesBundled ? "installed" : "different") : "not installed"} (${status.path})`,
          )
          .join("\n"),
      );
    });

  program.hook("postAction", (_command, actionCommand) => {
    if (actionCommand.name() !== "open") runtime?.close();
  });
  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  const json = argv.includes("--json");
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    const rvwError =
      error instanceof z.ZodError
        ? new RvwError("INVALID_INPUT", "入力がCLI schemaに適合しません。", {
            details: z.treeifyError(error),
          })
        : asRvwError(error);
    if (json) writeJson({ ok: false, error: rvwError.toJSON() });
    else process.stderr.write(`rvw: ${rvwError.message}\n${rvwError.suggestions.join("\n")}\n`);
    if (rvwError.status >= 500 && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = rvwError.status >= 500 ? 1 : 2;
  }
}

const bundledCli = typeof __RVW_CLI_BUNDLE__ !== "undefined" && __RVW_CLI_BUNDLE__ === true;
if (bundledCli || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  await runCli();
}
