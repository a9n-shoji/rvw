import { z } from "zod";
import {
  GIT_OBJECT_ID_PATTERN,
  MAX_AUTHOR_LABEL_CHARACTERS,
  MAX_COMMENT_BODY_BYTES,
} from "../shared/constants.js";
import { codeReferenceInputSchema } from "../application/agent-command-schemas.js";
import { themePreferences } from "../shared/preferences.js";

const nullableLine = z.number().int().positive().nullable();

const pullRequestTargetSchema = z.object({ kind: z.literal("pull-request") });
const repositoryReviewTargetSchema = z.object({ kind: z.literal("repository") });
const issueTargetSchema = z.object({
  kind: z.literal("issue"),
  issue: z.string().min(1),
  startLine: nullableLine.optional().default(null),
  endLine: nullableLine.optional().default(null),
});
const walkthroughTargetSchema = z.object({
  kind: z.literal("walkthrough"),
  walkthroughId: z.uuid(),
  startLine: nullableLine.optional().default(null),
  endLine: nullableLine.optional().default(null),
});
const pullRequestMarkdownTargetSchema = z.object({
  kind: z.literal("document"),
  documentKind: z.literal("pull-request-markdown"),
  startLine: nullableLine,
  endLine: nullableLine,
});
const repositoryFileTargetSchema = z.object({
  kind: z.literal("document"),
  documentKind: z.literal("repository-file"),
  sourceOid: z.string().regex(GIT_OBJECT_ID_PATTERN),
  path: z.string().min(1),
  startLine: nullableLine,
  endLine: nullableLine,
});

const pullRequestCommentTargetSchema = z.union([
  pullRequestTargetSchema,
  issueTargetSchema,
  walkthroughTargetSchema,
  pullRequestMarkdownTargetSchema,
  repositoryFileTargetSchema,
]);

const repositoryReviewCommentTargetSchema = z.union([
  repositoryReviewTargetSchema,
  issueTargetSchema,
  walkthroughTargetSchema,
  repositoryFileTargetSchema,
]);

export const commentTargetSchema = z.union([
  pullRequestTargetSchema,
  repositoryReviewTargetSchema,
  issueTargetSchema,
  walkthroughTargetSchema,
  pullRequestMarkdownTargetSchema,
  repositoryFileTargetSchema,
]);

export const openPullRequestSchema = z.object({
  reference: z.string().min(1).optional(),
  cwd: z.string().min(1),
});

export const openRepositoryReviewSchema = z.object({ cwd: z.string().min(1) });
export const issueMutationSchema = z.object({
  issue: z.string().min(1),
  yes: z.boolean().optional(),
});

const confirmationTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const resetSchema = z.discriminatedUnion("yes", [
  z.object({ yes: z.literal(false) }).strict(),
  z.object({ yes: z.literal(true), confirmationToken: confirmationTokenSchema }).strict(),
]);

export const viewerIdSchema = z.uuid();
export const viewerReleaseSchema = z.object({ viewerId: viewerIdSchema });
export const themePreferenceSchema = z.object({ themePreference: z.enum(themePreferences) });

const createCommentFields = {
  body: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COMMENT_BODY_BYTES),
  authorLabel: z.string().max(MAX_AUTHOR_LABEL_CHARACTERS).nullable().optional(),
  relatedCommitOid: z.string().regex(GIT_OBJECT_ID_PATTERN).nullable().optional(),
  references: z.array(codeReferenceInputSchema).optional(),
};

export const createCommentSchema = z
  .union([
    z.object({
      ...createCommentFields,
      pullRequestId: z.uuid(),
      repositoryReviewId: z.never().optional(),
      target: pullRequestCommentTargetSchema,
    }),
    z.object({
      ...createCommentFields,
      pullRequestId: z.never().optional(),
      repositoryReviewId: z.uuid(),
      target: repositoryReviewCommentTargetSchema,
    }),
  ])
  .superRefine((input, context) => {
    if ((input.references?.length ?? 0) > 0 && !input.relatedCommitOid) {
      context.addIssue({
        code: "custom",
        path: ["relatedCommitOid"],
        message: "code referenceを持つcomment postにはrelatedCommitOidが必要です。",
      });
    }
  });

export const replySchema = z
  .object({
    body: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COMMENT_BODY_BYTES),
    relatedCommitOid: z.string().regex(GIT_OBJECT_ID_PATTERN).nullable().optional(),
    authorLabel: z.string().max(MAX_AUTHOR_LABEL_CHARACTERS).nullable().optional(),
    references: z.array(codeReferenceInputSchema).optional(),
  })
  .superRefine((input, context) => {
    if ((input.references?.length ?? 0) > 0 && !input.relatedCommitOid) {
      context.addIssue({
        code: "custom",
        path: ["relatedCommitOid"],
        message: "code referenceを持つcomment postにはrelatedCommitOidが必要です。",
      });
    }
  });

export const editCommentPostSchema = z.object({
  body: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COMMENT_BODY_BYTES),
  references: z.array(codeReferenceInputSchema).optional(),
});
