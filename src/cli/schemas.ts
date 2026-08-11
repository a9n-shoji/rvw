import { z } from "zod";
import {
  DEFAULT_COMMENT_LIST_LIMIT,
  GIT_OBJECT_ID_PATTERN,
  MAX_AUTHOR_LABEL_CHARACTERS,
  MAX_COMMENT_BODY_BYTES,
  MAX_COMMENT_LIST_LIMIT,
  MAX_WALKTHROUGH_BODY_BYTES,
  MAX_WALKTHROUGH_REFERENCE_DESCRIPTION_CHARACTERS,
  MAX_WALKTHROUGH_REFERENCE_LABEL_CHARACTERS,
  MAX_WALKTHROUGH_REFERENCE_PATH_CHARACTERS,
  MAX_WALKTHROUGH_REFERENCES,
  MAX_WALKTHROUGH_TITLE_CHARACTERS,
} from "../shared/constants.js";

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

export const commentPullRequestOutputSchema = z
  .object({
    url: z.string(),
    owner: z.string(),
    repository: z.string(),
    number: z.number().int(),
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
const commentTargetOutputSchema = z.union([
  pullRequestCommentTargetOutputSchema,
  walkthroughCommentTargetOutputSchema,
  pullRequestMarkdownCommentTargetOutputSchema,
  repositoryCommentTargetOutputSchema,
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

const commentPostOutputSchema = z
  .object({
    id: z.string(),
    commentId: z.string(),
    body: z.string(),
    relatedCommitOid: z.string().nullable(),
    authorLabel: z.string().nullable(),
    isRoot: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const reviewCommentOutputSchema = z
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
    references: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          path: z.string(),
          startLine: z.number().int().nullable(),
          endLine: z.number().int().nullable(),
          description: z.string().nullable(),
        })
        .strict(),
    ),
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

export const commentGetOutputSchema = z
  .object({
    ok: z.literal(true),
    pullRequest: commentPullRequestOutputSchema,
    comment: reviewCommentOutputSchema,
    latestHeadOid: z.string(),
    latestPlacement: commentPlacementOutputSchema,
    exactSource: exactSourceOutputSchema.nullable(),
    walkthrough: walkthroughOutputSchema.nullable(),
  })
  .strict();

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
export type CommentListOutput = z.infer<typeof commentListOutputSchema>;

export const commentReplyInputSchema = z.object({
  body: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COMMENT_BODY_BYTES),
  authorLabel: z.string().max(MAX_AUTHOR_LABEL_CHARACTERS).nullable().optional(),
  relatedCommitOid: z.string().regex(GIT_OBJECT_ID_PATTERN).nullable().optional(),
});

export const pullRequestSyncInputSchema = z.object({
  pullRequest: z.string().min(1),
  commentUpdates: z
    .array(
      z.object({
        commentRef: z.string().regex(/^rvw:\/\/comment\//),
        reply: z
          .string()
          .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COMMENT_BODY_BYTES),
        resolve: z.boolean(),
      }),
    )
    .max(500)
    .optional(),
});

const walkthroughReferenceInputSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    label: z.string().min(1).max(MAX_WALKTHROUGH_REFERENCE_LABEL_CHARACTERS),
    path: z.string().min(1).max(MAX_WALKTHROUGH_REFERENCE_PATH_CHARACTERS),
    startLine: z.number().int().positive().nullable().optional().default(null),
    endLine: z.number().int().positive().nullable().optional().default(null),
    description: z.string().max(MAX_WALKTHROUGH_REFERENCE_DESCRIPTION_CHARACTERS).nullable(),
  })
  .superRefine((reference, context) => {
    if ((reference.startLine === null) !== (reference.endLine === null)) {
      context.addIssue({
        code: "custom",
        message: "startLineとendLineは両方指定するか、両方省略してください。",
      });
      return;
    }
    if (
      reference.startLine !== null &&
      reference.endLine !== null &&
      reference.endLine < reference.startLine
    ) {
      context.addIssue({
        code: "custom",
        message: "endLineはstartLine以上にしてください。",
      });
    }
  });

const walkthroughContentInputSchema = z.object({
  sourceOid: z.string().regex(GIT_OBJECT_ID_PATTERN),
  title: z.string().min(1).max(MAX_WALKTHROUGH_TITLE_CHARACTERS),
  body: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_WALKTHROUGH_BODY_BYTES),
  authorLabel: z.string().max(MAX_AUTHOR_LABEL_CHARACTERS).nullable().optional(),
  diagramBindings: z.record(z.string(), z.string()).optional(),
  references: z.array(walkthroughReferenceInputSchema).min(1).max(MAX_WALKTHROUGH_REFERENCES),
});

export const walkthroughPublishInputSchema = walkthroughContentInputSchema.extend({
  pullRequest: z.string().min(1),
});

export const walkthroughUpdateInputSchema = walkthroughContentInputSchema;
