import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { RvwService } from "../application/rvw-service.js";
import type { DiffDocumentRef, DocumentRef, StructureSourceLocator } from "../domain/models.js";
import {
  CONTENT_FINGERPRINT_PATTERN,
  GIT_OBJECT_ID_PATTERN,
  VIEWER_ID_HEADER,
  VIEWER_OPEN_LEASE_HEADER,
} from "../shared/constants.js";
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
  openPullRequestSchema,
  pullRequestListQuerySchema,
  replySchema,
  resolveCommentPlacementsSchema,
  resetSchema,
  structureDeleteSchema,
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
const contentFingerprintSchema = z.string().regex(CONTENT_FINGERPRINT_PATTERN);
const nonnegativeIndexSchema = z.coerce.number().int().nonnegative();
const svgAssetContentSecurityPolicy =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox";

function requiredQuery(value: string | undefined, name: string): string {
  if (!value) throw new RvwError("INVALID_INPUT", `${name} queryが必要です。`);
  return value;
}

function oidQuery(value: string | undefined, name: string): string {
  return oidSchema.parse(requiredQuery(value, name));
}

function optionalContentFingerprint(value: string | undefined): string | undefined {
  return value === undefined ? undefined : contentFingerprintSchema.parse(value);
}

function structureSourceLocator(query: {
  locatorKind: string | undefined;
  nodeId: string | undefined;
  edgeId: string | undefined;
  anchorIndex: string | undefined;
}): StructureSourceLocator {
  if (query.locatorKind === "node") {
    return { kind: "node", nodeId: requiredQuery(query.nodeId, "nodeId") };
  }
  if (query.locatorKind === "edge") {
    const anchorIndex = nonnegativeIndexSchema.safeParse(query.anchorIndex);
    if (!anchorIndex.success) {
      throw new RvwError("INVALID_INPUT", "anchorIndex queryは0以上の整数にしてください。");
    }
    return {
      kind: "edge",
      edgeId: requiredQuery(query.edgeId, "edgeId"),
      anchorIndex: anchorIndex.data,
    };
  }
  throw new RvwError("INVALID_INPUT", "locatorKind queryはnodeまたはedgeにしてください。");
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

function documentRefFromQuery(pullRequestId: string, query: Record<string, string>): DocumentRef {
  if (query.kind === "pull-request-markdown") {
    return { kind: "pull-request-markdown", pullRequestId };
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
      const rawViewerLease = context.req.header(VIEWER_OPEN_LEASE_HEADER);
      options.viewerLifecycle?.heartbeat(
        viewerIdSchema.parse(rawViewerId),
        rawViewerLease === undefined ? undefined : viewerIdSchema.parse(rawViewerLease),
      );
    }
    return context.json({ ok: true, ...service.database.getRevisionSnapshot() });
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

  app.get("/api/pull-requests", (context) => {
    const query = pullRequestListQuerySchema.parse({
      offset: context.req.query("offset"),
      limit: context.req.query("limit"),
      hideClosedOrMerged: context.req.query("hideClosedOrMerged"),
    });
    return context.json({ ok: true, ...service.listPullRequests(query) });
  });

  app.post("/api/pull-requests/refresh-statuses", async (context) =>
    context.json({ ok: true, ...(await service.refreshPullRequestStatuses()) }),
  );

  app.get("/api/pull-requests/:id", async (context) =>
    context.json({ ok: true, ...(await service.getPullRequestView(context.req.param("id"))) }),
  );

  app.post("/api/pull-requests/open", async (context) => {
    const input = openPullRequestSchema.parse(await context.req.json());
    return context.json({
      ok: true,
      ...(await service.openPullRequest(input.reference, input.cwd)),
    });
  });

  app.post("/api/pull-requests/:id/refresh", async (context) => {
    const result = await service.refreshPullRequest(context.req.param("id"));
    return context.json({ ok: true, ...result });
  });

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
            suggestions: ["削除件数を確認してyesを指定してください。"],
          },
          ...preview,
        },
        409,
      );
    }
    return context.json({ ok: true, ...(await service.resetPullRequest(context.req.param("id"))) });
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
    return context.json({
      ok: true,
      ...(await service.getDocumentWithContentFingerprint(
        ref,
        optionalContentFingerprint(context.req.query("expectedPullRequestContentFingerprint")),
      )),
    });
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
    const fetchSite = context.req.header("sec-fetch-site");
    const origin = context.req.header("origin");
    if (
      (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") ||
      (origin !== undefined && origin !== options.security.expectedOrigin)
    ) {
      throw new RvwError(
        "INVALID_ORIGIN",
        "cross-origin attachment requestは許可されていません。",
        {
          status: 403,
        },
      );
    }
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
      ...(await service.search(
        context.req.param("id"),
        oid,
        query,
        {
          matchCase,
          wholeWord,
        },
        optionalContentFingerprint(context.req.query("expectedPullRequestContentFingerprint")),
      )),
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

  app.get(
    "/api/pull-requests/:id/walkthroughs/:walkthroughId/references/:referenceId/resolve",
    async (context) =>
      context.json({
        ok: true,
        resolution: await service.resolveWalkthroughReference(
          context.req.param("id"),
          context.req.param("walkthroughId"),
          context.req.param("referenceId"),
        ),
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

  app.delete("/api/pull-requests/:id/walkthroughs/:walkthroughId", (context) =>
    context.json({
      ok: true,
      deleted: service.deleteWalkthrough(
        context.req.param("id"),
        context.req.param("walkthroughId"),
      ),
    }),
  );

  app.get("/api/pull-requests/:id/structures", (context) =>
    context.json({
      ok: true,
      structures: service.listStructures(context.req.param("id")),
    }),
  );

  app.get("/api/pull-requests/:id/structure-references", async (context) => {
    const sourceOid = oidQuery(context.req.query("sourceOid"), "sourceOid");
    const filePath = requiredQuery(context.req.query("path"), "path");
    return context.json({
      ok: true,
      references: await service.listFileStructureReferences(
        context.req.param("id"),
        sourceOid,
        filePath,
      ),
    });
  });

  app.get("/api/pull-requests/:id/structure-reference-index", async (context) => {
    const sourceOid = oidQuery(context.req.query("sourceOid"), "sourceOid");
    return context.json({
      ok: true,
      index: await service.listFileStructureReferenceIndex(context.req.param("id"), sourceOid),
    });
  });

  app.get("/api/pull-requests/:id/structures/:structureId", (context) =>
    context.json({
      ok: true,
      structure: service.getStructure(context.req.param("id"), context.req.param("structureId")),
    }),
  );

  app.get("/api/pull-requests/:id/structures/:structureId/anchors/resolve", async (context) => {
    return context.json({
      ok: true,
      resolution: await service.resolveStructureSource(
        context.req.param("id"),
        context.req.param("structureId"),
        structureSourceLocator({
          locatorKind: context.req.query("locatorKind"),
          nodeId: context.req.query("nodeId"),
          edgeId: context.req.query("edgeId"),
          anchorIndex: context.req.query("anchorIndex"),
        }),
      ),
    });
  });

  app.delete("/api/pull-requests/:id/structures/:structureId", async (context) => {
    const input = structureDeleteSchema.parse(await context.req.json());
    return context.json({
      ok: true,
      deleted: service.deleteStructure(
        context.req.param("id"),
        context.req.param("structureId"),
        input.expectedUpdatedAt,
      ),
    });
  });

  app.post("/api/comments", async (context) => {
    const input = createCommentSchema.parse(await context.req.json());
    return context.json(
      {
        ok: true,
        comment: await service.createComment({
          pullRequestId: input.pullRequestId,
          target: input.target,
          body: input.body,
          ...(input.relatedCommitOid === undefined
            ? {}
            : { relatedCommitOid: input.relatedCommitOid }),
          ...(input.references === undefined ? {} : { references: input.references }),
          ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
          lastModifiedBy: "human",
        }),
      },
      201,
    );
  });

  app.post("/api/comments/:id/posts", async (context) => {
    const input = replySchema.parse(await context.req.json());
    const commentId = context.req.param("id");
    const post = await service.replyToComment(commentId, {
      body: input.body,
      ...(input.relatedCommitOid === undefined ? {} : { relatedCommitOid: input.relatedCommitOid }),
      ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
      lastModifiedBy: "human",
      ...(input.references === undefined ? {} : { references: input.references }),
    });
    return context.json(
      {
        ok: true,
        post,
        comment: service.database.getComment(commentId)!,
      },
      201,
    );
  });

  app.patch("/api/comments/:id/posts/:postId", async (context) => {
    const input = editCommentPostSchema.parse(await context.req.json());
    const commentId = context.req.param("id");
    const post =
      input.references === undefined
        ? await service.updateCommentPost(
            commentId,
            context.req.param("postId"),
            input.body,
            "human",
          )
        : await service.editCommentPost(commentId, context.req.param("postId"), {
            body: input.body,
            references: input.references,
            lastModifiedBy: "human",
          });
    return context.json({
      ok: true,
      post,
      comment: service.database.getComment(commentId)!,
    });
  });

  app.delete("/api/comments/:id/posts/:postId", (context) => {
    const commentId = context.req.param("id");
    const deleted = service.deleteReply(commentId, context.req.param("postId"));
    return context.json({
      ok: true,
      deleted,
      comment: service.database.getComment(commentId)!,
    });
  });

  app.post("/api/comments/:id/resolve", (context) =>
    context.json({ ok: true, comment: service.setCommentResolved(context.req.param("id"), true) }),
  );

  app.post("/api/comments/:id/reopen", (context) =>
    context.json({ ok: true, comment: service.setCommentResolved(context.req.param("id"), false) }),
  );

  app.delete("/api/comments/:id", (context) =>
    context.json({ ok: true, deleted: service.deleteComment(context.req.param("id")) }),
  );

  app.post("/api/pull-requests/:pullRequestId/comment-placements/resolve", async (context) => {
    const input = resolveCommentPlacementsSchema.parse(await context.req.json());
    return context.json({
      ok: true,
      ...(await service.resolveCommentPlacements(
        context.req.param("pullRequestId"),
        input.commentIds,
        input.destinations,
        input.expectedPullRequestContentFingerprint,
      )),
    });
  });

  app.get("/api/comments/:id/placement", async (context) => {
    const comment = service.database.getComment(context.req.param("id"));
    if (!comment)
      throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。", { status: 404 });
    const pullRequestId = requiredQuery(context.req.query("pullRequestId"), "pullRequestId");
    if (comment.pullRequestId !== pullRequestId) {
      return context.json({
        ok: true,
        placement: { outdated: true as const, range: null, path: null },
      });
    }
    let destination;
    if (context.req.query("kind") === "commit") {
      const oid = oidQuery(context.req.query("oid"), "oid");
      destination = { kind: "commit" as const, oid };
    } else if (context.req.query("kind") === "walkthrough") {
      const walkthroughId = requiredQuery(context.req.query("walkthroughId"), "walkthroughId");
      destination = { kind: "walkthrough" as const, walkthroughId };
    } else {
      destination = {
        kind: "document" as const,
        ref: documentRefFromQuery(pullRequestId, context.req.query()),
      };
    }
    const placement =
      destination.kind === "commit"
        ? await service.placeCommentAtCommit(comment, destination.oid)
        : destination.kind === "walkthrough"
          ? service.placeWalkthroughComment(comment, destination.walkthroughId)
          : await service.placeComment(comment, destination.ref);
    return context.json({ ok: true, placement });
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
