import { z } from "zod";
import {
  GIT_OBJECT_ID_PATTERN,
  MAX_AUTHOR_LABEL_CHARACTERS,
  MAX_COMMENT_BODY_BYTES,
} from "../shared/constants.js";
import { codeReferenceInputSchema } from "../application/agent-command-schemas.js";
import { themePreferences } from "../shared/preferences.js";

const nullableLine = z.number().int().positive().nullable();

export const commentTargetSchema = z.union([
  z.object({ kind: z.literal("pull-request") }),
  z.object({
    kind: z.literal("walkthrough"),
    walkthroughId: z.uuid(),
    startLine: nullableLine.optional().default(null),
    endLine: nullableLine.optional().default(null),
  }),
  z.object({
    kind: z.literal("document"),
    documentKind: z.literal("pull-request-markdown"),
    startLine: nullableLine,
    endLine: nullableLine,
  }),
  z.object({
    kind: z.literal("document"),
    documentKind: z.literal("repository-file"),
    sourceOid: z.string().regex(GIT_OBJECT_ID_PATTERN),
    path: z.string().min(1),
    startLine: nullableLine,
    endLine: nullableLine,
  }),
]);

export const openPullRequestSchema = z.object({
  reference: z.string().min(1).optional(),
  cwd: z.string().min(1),
});

export const resetSchema = z.object({ yes: z.boolean() });

export const viewerIdSchema = z.uuid();
export const viewerReleaseSchema = z.object({ viewerId: viewerIdSchema });
export const themePreferenceSchema = z.object({ themePreference: z.enum(themePreferences) });

export const createCommentSchema = z
  .object({
    pullRequestId: z.uuid(),
    target: commentTargetSchema,
    body: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COMMENT_BODY_BYTES),
    authorLabel: z.string().max(MAX_AUTHOR_LABEL_CHARACTERS).nullable().optional(),
    relatedCommitOid: z.string().regex(GIT_OBJECT_ID_PATTERN).nullable().optional(),
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
