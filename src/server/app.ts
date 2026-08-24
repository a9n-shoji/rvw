import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { RvwService } from "../application/rvw-service.js";
import type { DiffDocumentRef, DocumentRef } from "../domain/models.js";
import { GIT_OBJECT_ID_PATTERN, VIEWER_ID_HEADER } from "../shared/constants.js";
import { asRvwError, RvwError } from "../shared/errors.js";
import {
  detectImageContentType,
  imageContentTypeHeader,
  isSupportedImagePath,
  type ImageContentType,
} from "../shared/image-assets.js";
import {
  createCommentSchema,
  editCommentPostSchema,
  issueMutationSchema,
  openRepositoryReviewSchema,
  openPullRequestSchema,
  replySchema,
  resetSchema,
  themePreferenceSchema,
  viewerIdSchema,
  viewerReleaseSchema,
} from "./schemas.js";
import type { ViewerLifecycle } from "./viewer-lifecycle.js";

export interface ServerSecurityContext {
  expectedHost: string | null;
  expectedOrigin: string | null;
}

export interface CreateAppOptions {
  security: ServerSecurityContext;
  staticDirectory?: string;
  viewerLifecycle?: ViewerLifecycle;
}

const oidSchema = z.string().regex(GIT_OBJECT_ID_PATTERN);
const svgAssetContentSecurityPolicy =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox";

function requiredQuery(value: string | undefined, name: string): string {
  if (!value) throw new RvwError("INVALID_INPUT", `${name} queryが必要です。`);
  return value;
}

function oidQuery(value: string | undefined, name: string): string {
  return oidSchema.parse(requiredQuery(value, name));
}

function isWriteMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function parseResolved(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "all") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new RvwError("INVALID_INPUT", "resolved queryはtrue、false、allのいずれかです。");
}

function parseBooleanQuery(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new RvwError("INVALID_INPUT", `${name} queryはtrueまたはfalseにしてください。`);
}

function repositoryAssetContentType(
  filePath: string,
  content: Uint8Array,
): ImageContentType | null {
  if (!isSupportedImagePath(filePath)) return null;
  const contentType = detectImageContentType(content);
  if (!contentType) {
    throw new RvwError("UNSUPPORTED_IMAGE", "repository assetは対応画像形式ではありません。", {
      status: 415,
    });
  }
  return contentType;
}

function setImageResponseHeaders(
  setHeader: (name: string, value: string) => void,
  contentType: ImageContentType,
): void {
  setHeader("content-type", imageContentTypeHeader(contentType));
  setHeader("cache-control", "private, max-age=31536000, immutable");
  setHeader("x-content-type-options", "nosniff");
  setHeader("content-disposition", "inline");
  setHeader("cross-origin-resource-policy", "same-origin");
  if (contentType === "image/svg+xml") {
    setHeader("content-security-policy", svgAssetContentSecurityPolicy);
  }
}

function assertSameOriginAttachmentRequest(
  fetchSite: string | undefined,
  origin: string | undefined,
  expectedOrigin: string | null,
): void {
  if (
    (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") ||
    (origin !== undefined && origin !== expectedOrigin)
  ) {
    throw new RvwError("INVALID_ORIGIN", "cross-origin attachment requestは許可されていません。", {
      status: 403,
    });
  }
}

function documentRefFromQuery(pullRequestId: string, query: Record<string, string>): DocumentRef {
  if (query.kind === "pull-request-markdown") {
    return { kind: "pull-request-markdown", pullRequestId };
  }
  if (query.kind === "issue-markdown" && query.issueId) {
    return { kind: "issue-markdown", pullRequestId, issueId: query.issueId };
  }
  if (query.kind === "repository-file" && query.sourceOid && query.path) {
    return {
      kind: "repository-file",
      pullRequestId,
      sourceOid: oidSchema.parse(query.sourceOid),
      path: query.path,
    };
  }
  throw new RvwError("INVALID_INPUT", "文書参照queryが不正です。");
}

export function createApp(service: RvwService, options: CreateAppOptions): Hono {
  const app = new Hono();

  app.use("*", async (context, next) => {
    const expectedHost = options.security.expectedHost;
    if (!expectedHost || context.req.header("host") !== expectedHost) {
      throw new RvwError("HOST_NOT_ALLOWED", "Host headerが許可されていません。", { status: 403 });
    }
    if (isWriteMethod(context.req.method) && context.req.path.startsWith("/api/")) {
      const contentType = context.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        throw new RvwError(
          "CONTENT_TYPE_REQUIRED",
          "write APIはapplication/jsonだけを受理します。",
          { status: 415 },
        );
      }
      const origin = context.req.header("origin");
      if (origin && origin !== options.security.expectedOrigin) {
        throw new RvwError("INVALID_ORIGIN", "cross-origin write requestは許可されていません。", {
          status: 403,
        });
      }
    }
    await next();
  });

  app.onError((error, context) => {
    const rvwError =
      error instanceof z.ZodError
        ? new RvwError("INVALID_INPUT", "requestがAPI schemaに適合しません。", {
            details: z.treeifyError(error),
          })
        : asRvwError(error);
    if (rvwError.status >= 500) console.error(error);
    return context.json(
      { ok: false as const, error: rvwError.toJSON() },
      rvwError.status as ContentfulStatusCode,
    );
  });

  app.get("/api/meta/change-sequence", (context) => {
    const rawViewerId = context.req.header(VIEWER_ID_HEADER);
    if (rawViewerId !== undefined) {
      options.viewerLifecycle?.heartbeat(viewerIdSchema.parse(rawViewerId));
    }
    const reviewKind = context.req.query("reviewKind");
    const reviewId = context.req.query("reviewId");
    if ((reviewKind === undefined) !== (reviewId === undefined)) {
      throw new RvwError("INVALID_INPUT", "reviewKindとreviewId queryは同時に指定してください。");
    }
    const parsedKind =
      reviewKind === undefined ? null : z.enum(["pull-request", "repository"]).parse(reviewKind);
    const parsedReviewId = reviewId === undefined ? null : z.uuid().parse(reviewId);
    return context.json({
      ok: true,
      changeSequence: service.database.getChangeSequence(),
      reviewChangeSequence:
        parsedKind && parsedReviewId
          ? service.database.getReviewChangeSequence(parsedKind, parsedReviewId)
          : null,
    });
  });

  app.post("/api/meta/viewers/release", async (context) => {
    const input = viewerReleaseSchema.parse(await context.req.json());
    options.viewerLifecycle?.release(input.viewerId);
    return context.json({ ok: true });
  });

  app.get("/api/preferences/theme", (context) =>
    context.json({ ok: true, themePreference: service.database.getThemePreference() }),
  );

  app.post("/api/preferences/theme", async (context) => {
    const input = themePreferenceSchema.parse(await context.req.json());
    return context.json({
      ok: true,
      themePreference: service.database.setThemePreference(input.themePreference),
    });
  });

  app.get("/api/pull-requests/:id", async (context) =>
    context.json({ ok: true, ...(await service.getPullRequestView(context.req.param("id"))) }),
  );

  app.get("/api/pull-requests/:id/issues", (context) =>
    context.json({ ok: true, issues: service.listPullRequestIssues(context.req.param("id")) }),
  );

  app.get("/api/pull-requests/:id/issues/:issueId", (context) =>
    context.json({
      ok: true,
      issue: service.getReviewIssue(
        "pull-request",
        context.req.param("id"),
        context.req.param("issueId"),
      ),
    }),
  );

  app.post("/api/pull-requests/:id/issues", async (context) => {
    const input = issueMutationSchema.parse(await context.req.json());
    const pullRequest = service.getPullRequest(context.req.param("id"));
    return context.json({
      ok: true,
      ...(await service.addPullRequestIssue(pullRequest.url, input.issue)),
    });
  });

  app.delete("/api/pull-requests/:id/issues/:issueId", async (context) => {
    const input = resetSchema.parse(await context.req.json());
    const pullRequest = service.getPullRequest(context.req.param("id"));
    const issue = service.getReviewIssue(
      "pull-request",
      pullRequest.id,
      context.req.param("issueId"),
    );
    if (!input.yes) {
      const preview = service.getIssueRemovalPreview("pull-request", pullRequest.id, issue.url);
      return context.json(
        {
          ok: false,
          error: {
            code: "ISSUE_REMOVAL_CONFIRMATION_REQUIRED",
            message: "Issue削除には明示的な確認が必要です。",
            suggestions: ["削除対象を確認し、返されたconfirmationTokenとyesを指定してください。"],
          },
          ...preview,
        },
        409,
      );
    }
    return context.json({
      ok: true,
      ...service.removePullRequestIssue(pullRequest.url, issue.url, input.confirmationToken),
    });
  });

  app.post("/api/pull-requests/open", async (context) => {
    const input = openPullRequestSchema.parse(await context.req.json());
    return context.json({
      ok: true,
      ...(await service.openPullRequest(input.reference, input.cwd)),
    });
  });

  app.post("/api/pull-requests/:id/refresh", async (context) =>
    context.json({ ok: true, ...(await service.refreshPullRequest(context.req.param("id"))) }),
  );

  app.post("/api/pull-requests/:id/reset", async (context) => {
    const input = resetSchema.parse(await context.req.json());
    if (!input.yes) {
      const preview = await service.getResetPreview(context.req.param("id"));
      return context.json(
        {
          ok: false,
          error: {
            code: "RESET_CONFIRMATION_REQUIRED",
            message: "resetには明示的な確認が必要です。",
            suggestions: ["削除件数を確認し、返されたconfirmationTokenとyesを指定してください。"],
          },
          ...preview,
        },
        409,
      );
    }
    return context.json({
      ok: true,
      ...(await service.resetPullRequest(context.req.param("id"), input.confirmationToken)),
    });
  });

  app.get("/api/pull-requests/:id/commits", async (context) =>
    context.json({ ok: true, ...(await service.getPullRequestView(context.req.param("id"))) }),
  );

  app.get("/api/pull-requests/:id/tree", async (context) => {
    const oid = oidQuery(context.req.query("oid"), "oid");
    return context.json({ ok: true, ...(await service.getTree(context.req.param("id"), oid)) });
  });

  app.get("/api/pull-requests/:id/changed-files", async (context) => {
    const oldOid = oidQuery(context.req.query("oldOid"), "oldOid");
    const newOid = oidQuery(context.req.query("newOid"), "newOid");
    return context.json({
      ok: true,
      ...(await service.getChangedFiles(context.req.param("id"), oldOid, newOid)),
    });
  });

  app.get("/api/pull-requests/:id/document", async (context) => {
    const ref = documentRefFromQuery(context.req.param("id"), context.req.query());
    return context.json({ ok: true, document: await service.getDocument(ref) });
  });

  app.on(["GET", "HEAD"], "/api/pull-requests/:id/markdown-asset", async (context) => {
    const sourceOid = oidQuery(context.req.query("sourceOid"), "sourceOid");
    const filePath = requiredQuery(context.req.query("path"), "path");
    const asset = await service.getRepositoryAsset(context.req.param("id"), sourceOid, filePath);
    const contentType = repositoryAssetContentType(filePath, asset.content);
    if (contentType) {
      setImageResponseHeaders((name, value) => context.header(name, value), contentType);
    } else {
      context.header("content-type", "application/octet-stream");
      context.header("cache-control", "private, max-age=31536000, immutable");
      context.header("x-content-type-options", "nosniff");
    }
    return context.req.method === "HEAD"
      ? context.body(null)
      : context.body(Uint8Array.from(asset.content));
  });

  app.get("/api/pull-requests/:id/github-attachment", async (context) => {
    assertSameOriginAttachmentRequest(
      context.req.header("sec-fetch-site"),
      context.req.header("origin"),
      options.security.expectedOrigin,
    );
    const absoluteUrl = requiredQuery(context.req.query("url"), "url");
    const attachment = await service.getGitHubAttachment(context.req.param("id"), absoluteUrl);
    setImageResponseHeaders((name, value) => context.header(name, value), attachment.contentType);
    return context.body(Uint8Array.from(attachment.content));
  });

  app.get("/api/pull-requests/:id/diff", async (context) => {
    const pullRequestId = context.req.param("id");
    const query = context.req.query();
    if (query.kind !== "repository-file") {
      throw new RvwError("INVALID_INPUT", "Pull Request.mdにはcommit diffがありません。");
    }
    const oldOid = oidQuery(query.oldOid, "oldOid");
    const newOid = oidQuery(query.newOid, "newOid");
    await service.getChangedFiles(pullRequestId, oldOid, newOid);
    const oldPath = query.oldPath;
    const newPath = query.newPath;
    if (!oldPath && !newPath) throw new RvwError("INVALID_INPUT", "diff pathが必要です。");
    const ref: DiffDocumentRef = {
      kind: "diff",
      old: oldPath
        ? { kind: "repository-file", pullRequestId, sourceOid: oldOid, path: oldPath }
        : null,
      new: newPath
        ? { kind: "repository-file", pullRequestId, sourceOid: newOid, path: newPath }
        : null,
    };
    return context.json({ ok: true, diff: await service.getDiff(ref) });
  });

  app.get("/api/pull-requests/:id/search", async (context) => {
    const oid = oidQuery(context.req.query("oid"), "oid");
    const query = context.req.query("q") ?? "";
    const matchCase = parseBooleanQuery(context.req.query("matchCase"), "matchCase");
    const wholeWord = parseBooleanQuery(context.req.query("wholeWord"), "wholeWord");
    return context.json({
      ok: true,
      ...(await service.search(context.req.param("id"), oid, query, {
        matchCase,
        wholeWord,
      })),
    });
  });

  app.get("/api/pull-requests/:id/comments", (context) => {
    const resolved = parseResolved(context.req.query("resolved"));
    return context.json({
      ok: true,
      comments: service.listComments(context.req.param("id"), resolved),
    });
  });

  app.get("/api/pull-requests/:id/walkthroughs", (context) =>
    context.json({
      ok: true,
      walkthroughs: service.listWalkthroughs(context.req.param("id")),
    }),
  );

  app.get("/api/pull-requests/:id/walkthroughs/:walkthroughId", (context) =>
    context.json({
      ok: true,
      walkthrough: service.getWalkthrough(
        context.req.param("id"),
        context.req.param("walkthroughId"),
      ),
    }),
  );

  app.get("/api/repository-reviews/:id", async (context) =>
    context.json({
      ok: true,
      ...(await service.getBoundRepositoryReviewView(context.req.param("id"))),
    }),
  );

  app.post("/api/repository-reviews/open", async (context) => {
    const input = openRepositoryReviewSchema.parse(await context.req.json());
    return context.json({ ok: true, ...(await service.openRepositoryReview(input.cwd)) });
  });

  app.post("/api/repository-reviews/:id/sync", async (context) => {
    return context.json({
      ok: true,
      ...(await service.syncRepositoryReviewById(context.req.param("id"))),
    });
  });

  app.post("/api/repository-reviews/:id/reset", async (context) => {
    const input = resetSchema.parse(await context.req.json());
    if (!input.yes) {
      const preview = await service.getRepositoryResetPreview(context.req.param("id"));
      return context.json(
        {
          ok: false,
          error: {
            code: "RESET_CONFIRMATION_REQUIRED",
            message: "resetには明示的な確認が必要です。",
            suggestions: ["削除件数を確認し、返されたconfirmationTokenとyesを指定してください。"],
          },
          ...preview,
        },
        409,
      );
    }
    return context.json({
      ok: true,
      ...(await service.resetRepositoryReview(context.req.param("id"), input.confirmationToken)),
    });
  });

  app.get("/api/repository-reviews/:id/tree", async (context) =>
    context.json({ ok: true, ...(await service.getRepositoryTree(context.req.param("id"))) }),
  );

  app.get("/api/repository-reviews/:id/document", async (context) => {
    const repositoryReviewId = context.req.param("id");
    const query = context.req.query();
    if (query.kind === "issue-markdown" && query.issueId) {
      return context.json({
        ok: true,
        document: await service.getRepositoryReviewDocument({
          kind: "issue-markdown",
          repositoryReviewId,
          issueId: query.issueId,
        }),
      });
    }
    if (query.kind === "repository-file" && query.sourceOid && query.path) {
      return context.json({
        ok: true,
        document: await service.getRepositoryReviewDocument({
          kind: "repository-file",
          repositoryReviewId,
          sourceOid: oidSchema.parse(query.sourceOid),
          path: query.path,
        }),
      });
    }
    throw new RvwError("INVALID_INPUT", "Repository Review document参照queryが不正です。");
  });

  app.on(["GET", "HEAD"], "/api/repository-reviews/:id/markdown-asset", async (context) => {
    const sourceOid = oidQuery(context.req.query("sourceOid"), "sourceOid");
    const filePath = requiredQuery(context.req.query("path"), "path");
    const asset = await service.getRepositoryReviewAsset(
      context.req.param("id"),
      sourceOid,
      filePath,
    );
    const contentType = repositoryAssetContentType(filePath, asset.content);
    if (contentType) {
      setImageResponseHeaders((name, value) => context.header(name, value), contentType);
    } else {
      context.header("content-type", "application/octet-stream");
      context.header("cache-control", "private, max-age=31536000, immutable");
      context.header("x-content-type-options", "nosniff");
    }
    return context.req.method === "HEAD"
      ? context.body(null)
      : context.body(Uint8Array.from(asset.content));
  });

  app.get("/api/repository-reviews/:id/github-attachment", async (context) => {
    assertSameOriginAttachmentRequest(
      context.req.header("sec-fetch-site"),
      context.req.header("origin"),
      options.security.expectedOrigin,
    );
    const absoluteUrl = requiredQuery(context.req.query("url"), "url");
    const attachment = await service.getRepositoryGitHubAttachment(
      context.req.param("id"),
      absoluteUrl,
    );
    setImageResponseHeaders((name, value) => context.header(name, value), attachment.contentType);
    return context.body(Uint8Array.from(attachment.content));
  });

  app.get("/api/repository-reviews/:id/search", async (context) => {
    const matchCase = parseBooleanQuery(context.req.query("matchCase"), "matchCase");
    const wholeWord = parseBooleanQuery(context.req.query("wholeWord"), "wholeWord");
    return context.json({
      ok: true,
      ...(await service.searchRepositoryReview(
        context.req.param("id"),
        context.req.query("q") ?? "",
        {
          matchCase,
          wholeWord,
        },
      )),
    });
  });

  app.get("/api/repository-reviews/:id/issues", (context) =>
    context.json({ ok: true, issues: service.listRepositoryIssues(context.req.param("id")) }),
  );

  app.get("/api/repository-reviews/:id/issues/:issueId", (context) =>
    context.json({
      ok: true,
      issue: service.getReviewIssue(
        "repository",
        context.req.param("id"),
        context.req.param("issueId"),
      ),
    }),
  );

  app.post("/api/repository-reviews/:id/issues", async (context) => {
    const input = issueMutationSchema.parse(await context.req.json());
    return context.json({
      ok: true,
      ...(await service.addRepositoryIssueById(context.req.param("id"), input.issue)),
    });
  });

  app.delete("/api/repository-reviews/:id/issues/:issueId", async (context) => {
    const input = resetSchema.parse(await context.req.json());
    const repositoryReview = service.getRepositoryReview(context.req.param("id"));
    const issue = service.getReviewIssue(
      "repository",
      repositoryReview.id,
      context.req.param("issueId"),
    );
    if (!input.yes) {
      const preview = await service.getRepositoryIssueRemovalPreviewById(
        repositoryReview.id,
        issue.url,
      );
      return context.json(
        {
          ok: false,
          error: {
            code: "ISSUE_REMOVAL_CONFIRMATION_REQUIRED",
            message: "Issue削除には明示的な確認が必要です。",
            suggestions: ["削除対象を確認し、返されたconfirmationTokenとyesを指定してください。"],
          },
          ...preview,
        },
        409,
      );
    }
    return context.json({
      ok: true,
      ...(await service.removeRepositoryIssueById(
        repositoryReview.id,
        issue.url,
        input.confirmationToken,
      )),
    });
  });

  app.get("/api/repository-reviews/:id/comments", async (context) => {
    const resolved = parseResolved(context.req.query("resolved"));
    const comments = await service.listRepositoryCommentContextsById(
      context.req.param("id"),
      resolved,
    );
    return context.json({
      ok: true,
      comments,
    });
  });

  app.get("/api/repository-reviews/:id/walkthroughs", (context) =>
    context.json({
      ok: true,
      walkthroughs: service.listRepositoryWalkthroughs(context.req.param("id")),
    }),
  );

  app.get("/api/repository-reviews/:id/walkthroughs/:walkthroughId", (context) =>
    context.json({
      ok: true,
      walkthrough: service.getRepositoryWalkthrough(
        context.req.param("id"),
        context.req.param("walkthroughId"),
      ),
    }),
  );

  app.delete("/api/repository-reviews/:id/walkthroughs/:walkthroughId", async (context) => {
    const input = resetSchema.parse(await context.req.json());
    const walkthrough = service.getRepositoryWalkthrough(
      context.req.param("id"),
      context.req.param("walkthroughId"),
    );
    if (!input.yes) {
      return context.json(
        {
          ok: false,
          error: {
            code: "WALKTHROUGH_DELETE_CONFIRMATION_REQUIRED",
            message: "Walkthrough削除には明示的な確認が必要です。",
          },
          ...(await service.getWalkthroughDeletePreview(walkthrough.ref)),
        },
        409,
      );
    }
    return context.json({
      ok: true,
      deleted: await service.deleteRepositoryWalkthrough(
        context.req.param("id"),
        context.req.param("walkthroughId"),
        input.confirmationToken,
      ),
    });
  });

  app.delete("/api/pull-requests/:id/walkthroughs/:walkthroughId", async (context) => {
    const input = resetSchema.parse(await context.req.json());
    const walkthrough = service.getWalkthrough(
      context.req.param("id"),
      context.req.param("walkthroughId"),
    );
    if (!input.yes) {
      return context.json(
        {
          ok: false,
          error: {
            code: "WALKTHROUGH_DELETE_CONFIRMATION_REQUIRED",
            message: "Walkthrough削除には明示的な確認が必要です。",
          },
          ...(await service.getWalkthroughDeletePreview(walkthrough.ref)),
        },
        409,
      );
    }
    return context.json({
      ok: true,
      deleted: await service.deleteWalkthrough(
        context.req.param("id"),
        context.req.param("walkthroughId"),
        input.confirmationToken,
      ),
    });
  });

  app.post("/api/comments", async (context) => {
    const input = createCommentSchema.parse(await context.req.json());
    const comment = input.repositoryReviewId
      ? await service.createRepositoryComment({
          repositoryReviewId: input.repositoryReviewId,
          target: input.target,
          body: input.body,
          ...(input.relatedCommitOid === undefined
            ? {}
            : { relatedCommitOid: input.relatedCommitOid }),
          ...(input.references === undefined ? {} : { references: input.references }),
          ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
          lastModifiedBy: "human",
        })
      : await service.createComment({
          pullRequestId: input.pullRequestId!,
          target: input.target,
          body: input.body,
          ...(input.relatedCommitOid === undefined
            ? {}
            : { relatedCommitOid: input.relatedCommitOid }),
          ...(input.references === undefined ? {} : { references: input.references }),
          ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
          lastModifiedBy: "human",
        });
    return context.json(
      {
        ok: true,
        comment,
      },
      201,
    );
  });

  app.post("/api/comments/:id/posts", async (context) => {
    const input = replySchema.parse(await context.req.json());
    return context.json(
      {
        ok: true,
        post: await service.replyToComment(context.req.param("id"), {
          body: input.body,
          ...(input.relatedCommitOid === undefined
            ? {}
            : { relatedCommitOid: input.relatedCommitOid }),
          ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
          lastModifiedBy: "human",
          ...(input.references === undefined ? {} : { references: input.references }),
        }),
      },
      201,
    );
  });

  app.patch("/api/comments/:id/posts/:postId", async (context) => {
    const input = editCommentPostSchema.parse(await context.req.json());
    return context.json({
      ok: true,
      post:
        input.references === undefined
          ? await service.updateCommentPost(
              context.req.param("id"),
              context.req.param("postId"),
              input.body,
              "human",
            )
          : await service.editCommentPost(context.req.param("id"), context.req.param("postId"), {
              body: input.body,
              references: input.references,
              lastModifiedBy: "human",
            }),
    });
  });

  app.delete("/api/comments/:id/posts/:postId", async (context) =>
    context.json({
      ok: true,
      deleted: await service.deleteReply(context.req.param("id"), context.req.param("postId")),
    }),
  );

  app.post("/api/comments/:id/resolve", async (context) =>
    context.json({
      ok: true,
      comment: await service.setCommentResolved(context.req.param("id"), true),
    }),
  );

  app.post("/api/comments/:id/reopen", async (context) =>
    context.json({
      ok: true,
      comment: await service.setCommentResolved(context.req.param("id"), false),
    }),
  );

  app.delete("/api/comments/:id", async (context) =>
    context.json({ ok: true, deleted: await service.deleteComment(context.req.param("id")) }),
  );

  app.get("/api/comments/:id/placement", async (context) => {
    const comment = service.database.getComment(context.req.param("id"));
    const repositoryComment = comment
      ? null
      : service.database.getRepositoryComment(context.req.param("id"));
    if (!comment && !repositoryComment)
      throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。", { status: 404 });
    if (repositoryComment) {
      const repositoryReviewId = requiredQuery(
        context.req.query("repositoryReviewId"),
        "repositoryReviewId",
      );
      if (repositoryComment.repositoryReviewId !== repositoryReviewId) {
        return context.json({
          ok: true,
          placement: { outdated: true as const, range: null, path: null },
        });
      }
      if (context.req.query("kind") === "walkthrough") {
        const walkthroughId = requiredQuery(context.req.query("walkthroughId"), "walkthroughId");
        return context.json({
          ok: true,
          placement: service.placeRepositoryWalkthroughComment(
            repositoryReviewId,
            repositoryComment,
            walkthroughId,
          ),
        });
      }
      if (context.req.query("kind") === "issue-markdown") {
        const issueId = requiredQuery(context.req.query("issueId"), "issueId");
        return context.json({
          ok: true,
          placement: service.placeRepositoryIssueComment(
            repositoryReviewId,
            repositoryComment,
            issueId,
          ),
        });
      }
      const kind = context.req.query("kind");
      let oid: string;
      if (kind === "repository-file") {
        oid = oidQuery(context.req.query("sourceOid"), "sourceOid");
      } else if (kind === "commit") {
        oid = oidQuery(context.req.query("oid"), "oid");
      } else {
        throw new RvwError("INVALID_INPUT", "Repository Review配置先queryが不正です。");
      }
      return context.json({
        ok: true,
        placement: await service.placeRepositoryCommentAtCommit(
          repositoryReviewId,
          repositoryComment,
          oid,
        ),
      });
    }
    if (!comment) {
      throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。", { status: 404 });
    }
    const pullRequestId = requiredQuery(context.req.query("pullRequestId"), "pullRequestId");
    if (comment.pullRequestId !== pullRequestId) {
      return context.json({
        ok: true,
        placement: { outdated: true as const, range: null, path: null },
      });
    }
    if (context.req.query("kind") === "commit") {
      const oid = oidQuery(context.req.query("oid"), "oid");
      return context.json({
        ok: true,
        placement: await service.placeCommentAtCommit(comment, oid),
      });
    }
    if (context.req.query("kind") === "walkthrough") {
      const walkthroughId = requiredQuery(context.req.query("walkthroughId"), "walkthroughId");
      return context.json({
        ok: true,
        placement: service.placeWalkthroughComment(comment, walkthroughId),
      });
    }
    const destination = documentRefFromQuery(pullRequestId, context.req.query());
    return context.json({ ok: true, placement: await service.placeComment(comment, destination) });
  });

  if (options.staticDirectory && existsSync(options.staticDirectory)) {
    app.use("*", serveStatic({ root: options.staticDirectory }));
    const indexPath = path.join(options.staticDirectory, "index.html");
    if (existsSync(indexPath)) {
      const index = readFileSync(indexPath, "utf8");
      app.get("*", (context) => context.html(index));
    }
  }

  app.notFound((context) =>
    context.json(
      {
        ok: false,
        error: { code: "NOT_FOUND", message: "routeが見つかりません。", suggestions: [] },
      },
      404,
    ),
  );

  return app;
}
