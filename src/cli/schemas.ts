import { z } from "zod";
import {
  DEFAULT_COMMENT_LIST_LIMIT,
  DEFAULT_COMMENT_WATCH_INTERVAL_SECONDS,
  DEFAULT_COMMENT_WATCH_LIMIT,
  MAX_COMMENT_LIST_LIMIT,
  MAX_COMMENT_WATCH_INTERVAL_SECONDS,
  MAX_COMMENT_WATCH_LIMIT,
} from "../shared/constants.js";
export {
  commentCreateInputSchema,
  commentPostEditInputSchema,
  commentReplyInputSchema,
  pullRequestSyncInputSchema,
  walkthroughPublishInputSchema,
  walkthroughUpdateInputSchema,
} from "../application/agent-command-schemas.js";

export const commentListOptionsSchema = z.object({
  state: z.enum(["unresolved", "resolved", "all"]).default("unresolved"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_COMMENT_LIST_LIMIT)
    .default(DEFAULT_COMMENT_LIST_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export const commentWatchOptionsSchema = z.object({
  after: z.string().min(1).max(512).optional(),
  interval: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_COMMENT_WATCH_INTERVAL_SECONDS)
    .default(DEFAULT_COMMENT_WATCH_INTERVAL_SECONDS),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_COMMENT_WATCH_LIMIT)
    .default(DEFAULT_COMMENT_WATCH_LIMIT),
  once: z.boolean().optional().default(false),
  jsonSeq: z.literal(true),
});

export const commentPullRequestOutputSchema = z
  .object({
    url: z.string(),
    owner: z.string(),
    repository: z.string(),
    number: z.number().int(),
    authorLogin: z.string().nullable(),
    headRepository: z
      .object({ owner: z.string(), name: z.string(), url: z.string() })
      .strict()
      .nullable(),
    title: z.string(),
    body: z.string().optional(),
    baseRefName: z.string(),
    baseOid: z.string(),
    comparisonBaseOid: z.string(),
    headRefName: z.string(),
    headOid: z.string(),
    githubUpdatedAt: z.string(),
    fetchedAt: z.string(),
    localRepositoryPath: z.string(),
  })
  .strict();

const pullRequestCommentTargetOutputSchema = z.object({ kind: z.literal("pull-request") }).strict();
const walkthroughCommentTargetOutputSchema = z
  .object({
    kind: z.literal("walkthrough"),
    walkthroughId: z.string(),
    walkthroughTitle: z.string(),
    sourceDocumentHash: z.string().nullable(),
    quotedText: z.string().nullable(),
    startLine: z.number().int().nullable(),
    endLine: z.number().int().nullable(),
  })
  .strict();
const pullRequestMarkdownCommentTargetOutputSchema = z
  .object({
    kind: z.literal("document"),
    documentKind: z.literal("pull-request-markdown"),
    sourceDocumentHash: z.string(),
    quotedText: z.string().nullable(),
    startLine: z.number().int().nullable(),
    endLine: z.number().int().nullable(),
  })
  .strict();
const repositoryCommentTargetOutputSchema = z
  .object({
    kind: z.literal("document"),
    documentKind: z.literal("repository-file"),
    sourceOid: z.string(),
    path: z.string(),
    startLine: z.number().int().nullable(),
    endLine: z.number().int().nullable(),
  })
  .strict();
const issueCommentTargetOutputSchema = z
  .object({
    kind: z.literal("issue"),
    issueId: z.string(),
    issueUrl: z.string(),
    issueNumber: z.number().int().positive(),
    issueTitle: z.string(),
    sourceDocumentHash: z.string(),
    quotedText: z.string().nullable(),
    startLine: z.number().int().nullable(),
    endLine: z.number().int().nullable(),
  })
  .strict();
const commentTargetOutputSchema = z.union([
  pullRequestCommentTargetOutputSchema,
  walkthroughCommentTargetOutputSchema,
  pullRequestMarkdownCommentTargetOutputSchema,
  repositoryCommentTargetOutputSchema,
  issueCommentTargetOutputSchema,
]);

const commentListTargetOutputSchema = z.union([
  pullRequestCommentTargetOutputSchema,
  z
    .object({
      kind: z.literal("walkthrough"),
      walkthroughId: z.string(),
      walkthroughTitle: z.string(),
      startLine: z.number().int().nullable(),
      endLine: z.number().int().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("document"),
      documentKind: z.literal("pull-request-markdown"),
      startLine: z.number().int().nullable(),
      endLine: z.number().int().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("document"),
      documentKind: z.literal("repository-file"),
      path: z.string(),
      startLine: z.number().int().nullable(),
      endLine: z.number().int().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("issue"),
      issueUrl: z.string(),
      issueNumber: z.number().int().positive(),
      issueTitle: z.string(),
      startLine: z.number().int().nullable(),
      endLine: z.number().int().nullable(),
    })
    .strict(),
]);

const commentPlacementOutputSchema = z.union([
  z
    .object({
      outdated: z.literal(false),
      range: z
        .object({ startLine: z.number().int(), endLine: z.number().int() })
        .strict()
        .nullable(),
      path: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      outdated: z.literal(true),
      range: z.null(),
      path: z.string().nullable(),
    })
    .strict(),
]);

const codeReferenceOutputSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    path: z.string(),
    startLine: z.number().int().nullable(),
    endLine: z.number().int().nullable(),
    description: z.string().nullable(),
  })
  .strict();

const commentPostOutputSchema = z
  .object({
    id: z.string(),
    commentId: z.string(),
    body: z.string(),
    relatedCommitOid: z.string().nullable(),
    references: z.array(codeReferenceOutputSchema),
    authorLabel: z.string().nullable(),
    isRoot: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const pullRequestReviewCommentOutputSchema = z
  .object({
    id: z.string(),
    ref: z.string(),
    pullRequestId: z.string(),
    createdHeadOid: z.string(),
    resolvedAt: z.string().nullable(),
    resolved: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    target: commentTargetOutputSchema,
    posts: z.array(commentPostOutputSchema),
  })
  .strict();

const walkthroughOutputSchema = z
  .object({
    id: z.string(),
    ref: z.string(),
    pullRequestId: z.string(),
    sourceOid: z.string(),
    title: z.string(),
    body: z.string(),
    authorLabel: z.string().nullable(),
    diagramBindings: z.record(z.string(), z.string()),
    references: z.array(codeReferenceOutputSchema),
    createdAt: z.string(),
  })
  .strict();

const sourceExcerptOutputSchema = z
  .object({
    startLine: z.number().int(),
    endLine: z.number().int(),
    text: z.string(),
    truncatedBefore: z.boolean(),
    truncatedAfter: z.boolean(),
    truncatedByBytes: z.boolean(),
  })
  .strict();

const exactSourceOutputSchema = z
  .object({
    sourceOid: z.string(),
    path: z.string(),
    availability: z.enum(["available", "binary", "too-large", "missing"]),
    excerpt: sourceExcerptOutputSchema.nullable(),
  })
  .strict();

const issueDocumentOutputSchema = z
  .object({
    id: z.string(),
    host: z.literal("github.com"),
    owner: z.string(),
    repository: z.string(),
    canonicalName: z.string(),
    number: z.number().int().positive(),
    url: z.string(),
    title: z.string(),
    body: z.string(),
    state: z.enum(["OPEN", "CLOSED"]),
    updatedAt: z.string(),
    bodyHash: z.string(),
    fetchedAt: z.string(),
    syncError: z.string().nullable(),
    stale: z.boolean(),
  })
  .strict();

const pullRequestCommentGetOutputSchema = z
  .object({
    ok: z.literal(true),
    context: z
      .object({
        kind: z.literal("pull-request"),
        pullRequestId: z.string(),
        pullRequestUrl: z.string(),
      })
      .strict(),
    pullRequest: commentPullRequestOutputSchema,
    comment: pullRequestReviewCommentOutputSchema,
    latestHeadOid: z.string(),
    latestPlacement: commentPlacementOutputSchema,
    exactSource: exactSourceOutputSchema.nullable(),
    walkthrough: walkthroughOutputSchema.nullable(),
    issue: issueDocumentOutputSchema.nullable(),
    githubState: z
      .object({
        liveCheckedAt: z.string().nullable(),
        staleAgainstGitHub: z.boolean().nullable(),
        live: z
          .object({
            authorLogin: z.string().nullable(),
            headRepository: z
              .object({ owner: z.string(), name: z.string(), url: z.string() })
              .strict()
              .nullable(),
            title: z.string(),
            body: z.string().optional(),
            baseRefName: z.string(),
            baseOid: z.string(),
            headRefName: z.string(),
            headOid: z.string(),
            githubUpdatedAt: z.string(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();

const repositoryReviewCommentTargetOutputSchema = z.union([
  z.object({ kind: z.literal("repository") }).strict(),
  walkthroughCommentTargetOutputSchema,
  repositoryCommentTargetOutputSchema,
  issueCommentTargetOutputSchema,
]);

const repositoryReviewCommentOutputSchema = z
  .object({
    id: z.string(),
    ref: z.string(),
    repositoryReviewId: z.string(),
    createdSourceOid: z.string(),
    resolvedAt: z.string().nullable(),
    resolved: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    target: repositoryReviewCommentTargetOutputSchema,
    posts: z.array(commentPostOutputSchema),
  })
  .strict();

const repositoryWalkthroughOutputSchema = walkthroughOutputSchema
  .omit({ pullRequestId: true })
  .extend({
    repositoryReviewId: z.string(),
  });

const repositoryCommentGetOutputSchema = z
  .object({
    ok: z.literal(true),
    context: z
      .object({
        kind: z.literal("repository"),
        repositoryReviewId: z.string(),
        repository: z.string(),
      })
      .strict(),
    repositoryReview: z
      .object({
        repository: z.string(),
        owner: z.string(),
        name: z.string(),
        localRepositoryPath: z.string(),
        defaultBranchName: z.string(),
        currentSourceOid: z.string(),
        githubFetchedAt: z.string(),
        sourceSyncError: z.string().nullable(),
      })
      .strict(),
    comment: repositoryReviewCommentOutputSchema,
    currentSourceOid: z.string(),
    latestPlacement: commentPlacementOutputSchema,
    exactSource: exactSourceOutputSchema.nullable(),
    walkthrough: repositoryWalkthroughOutputSchema.nullable(),
    issue: issueDocumentOutputSchema.nullable(),
    githubState: z
      .object({
        liveCheckedAt: z.null(),
        staleAgainstGitHub: z.null(),
        live: z.null(),
      })
      .strict(),
  })
  .strict();

export const commentGetOutputSchema = z.union([
  pullRequestCommentGetOutputSchema,
  repositoryCommentGetOutputSchema,
]);

export const commentListOutputSchema = z
  .object({
    ok: z.literal(true),
    pullRequest: commentPullRequestOutputSchema,
    state: z.enum(["unresolved", "resolved", "all"]),
    page: z
      .object({
        offset: z.number().int().min(0),
        limit: z.number().int().min(1).max(MAX_COMMENT_LIST_LIMIT),
        returned: z.number().int().min(0),
        total: z.number().int().min(0),
        hasMore: z.boolean(),
        nextOffset: z.number().int().min(0).nullable(),
      })
      .strict(),
    comments: z.array(
      z
        .object({
          comment: z
            .object({
              ref: z.string(),
              resolved: z.boolean(),
              createdAt: z.string(),
              updatedAt: z.string(),
              target: commentListTargetOutputSchema,
              postCount: z.number().int().min(1),
              rootPost: z
                .object({
                  body: z.string(),
                  bodyTruncated: z.boolean(),
                  authorLabel: z.string().nullable(),
                  relatedCommitOid: z.string().nullable(),
                  createdAt: z.string(),
                  updatedAt: z.string(),
                })
                .strict(),
            })
            .strict(),
          latestPlacement: commentPlacementOutputSchema,
        })
        .strict(),
    ),
  })
  .strict();

export type CommentListOptions = z.infer<typeof commentListOptionsSchema>;
export type CommentGetOutput = z.infer<typeof commentGetOutputSchema>;
export type PullRequestCommentGetOutput = z.infer<typeof pullRequestCommentGetOutputSchema>;
export type CommentListOutput = z.infer<typeof commentListOutputSchema>;
