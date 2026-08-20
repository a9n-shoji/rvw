import { z } from "zod";
import {
  DEFAULT_COMMENT_LIST_LIMIT,
  GIT_OBJECT_ID_PATTERN,
  MAX_AUTHOR_LABEL_CHARACTERS,
  MAX_CODE_REFERENCE_DESCRIPTION_CHARACTERS,
  MAX_CODE_REFERENCE_LABEL_CHARACTERS,
  MAX_CODE_REFERENCE_PATH_CHARACTERS,
  MAX_CODE_REFERENCES,
  MAX_COMMENT_BODY_BYTES,
  MAX_COMMENT_LIST_LIMIT,
  MAX_COMMENT_WATCH_LIMIT,
  MAX_IDEMPOTENCY_KEY_CHARACTERS,
  MAX_WALKTHROUGH_BODY_BYTES,
  MAX_WALKTHROUGH_TITLE_CHARACTERS,
} from "../shared/constants.js";

const nonEmptyString = z.string().min(1);
const commentUri = z.string().regex(/^rvw:\/\/comment\//);
const walkthroughUri = z.string().regex(/^rvw:\/\/walkthrough\//);
const nullableCommentLine = z.number().int().positive().nullable().optional().default(null);
const idempotencyKey = z.string().min(1).max(MAX_IDEMPOTENCY_KEY_CHARACTERS).optional();

export const commentTargetInputSchema = z
  .union([
    z.object({ kind: z.literal("pull-request") }).strict(),
    z
      .object({
        kind: z.literal("walkthrough"),
        walkthroughId: z.uuid(),
        startLine: nullableCommentLine,
        endLine: nullableCommentLine,
      })
      .strict(),
    z
      .object({
        kind: z.literal("document"),
        documentKind: z.literal("pull-request-markdown"),
        startLine: nullableCommentLine,
        endLine: nullableCommentLine,
      })
      .strict(),
    z
      .object({
        kind: z.literal("document"),
        documentKind: z.literal("repository-file"),
        sourceOid: z.string().regex(GIT_OBJECT_ID_PATTERN),
        path: nonEmptyString,
        startLine: nullableCommentLine,
        endLine: nullableCommentLine,
      })
      .strict(),
  ])
  .superRefine((target, context) => {
    if (target.kind === "pull-request") return;
    if ((target.startLine === null) !== (target.endLine === null)) {
      context.addIssue({
        code: "custom",
        message: "startLineとendLineは両方指定するか、両方省略してください。",
      });
      return;
    }
    if (target.startLine !== null && target.endLine !== null && target.endLine < target.startLine) {
      context.addIssue({
        code: "custom",
        message: "endLineはstartLine以上にしてください。",
      });
    }
  });

export const codeReferenceInputSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    label: z.string().min(1).max(MAX_CODE_REFERENCE_LABEL_CHARACTERS),
    path: z.string().min(1).max(MAX_CODE_REFERENCE_PATH_CHARACTERS),
    startLine: z.number().int().positive().nullable().optional().default(null),
    endLine: z.number().int().positive().nullable().optional().default(null),
    description: z.string().max(MAX_CODE_REFERENCE_DESCRIPTION_CHARACTERS).nullable(),
  })
  .strict()
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

const optionalCodeReferences = z
  .array(codeReferenceInputSchema)
  .max(MAX_CODE_REFERENCES)
  .optional();

function requireRelatedCommitForReferences(
  input: {
    relatedCommitOid?: string | null | undefined;
    references?: unknown[] | undefined;
  },
  context: z.RefinementCtx,
): void {
  if ((input.references?.length ?? 0) > 0 && !input.relatedCommitOid) {
    context.addIssue({
      code: "custom",
      path: ["relatedCommitOid"],
      message: "code referenceを持つcomment postにはrelatedCommitOidが必要です。",
    });
  }
}

export const commentCreateInputSchema = z
  .object({
    pullRequest: nonEmptyString,
    target: commentTargetInputSchema,
    body: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0)
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COMMENT_BODY_BYTES, {
        message: `bodyはUTF-8で${MAX_COMMENT_BODY_BYTES} bytes（64 KiB）以下にしてください。`,
      }),
    authorLabel: z.string().max(MAX_AUTHOR_LABEL_CHARACTERS).nullable().optional(),
    relatedCommitOid: z.string().regex(GIT_OBJECT_ID_PATTERN).nullable().optional(),
    references: optionalCodeReferences,
  })
  .strict()
  .superRefine(requireRelatedCommitForReferences);

export const commentReplyInputSchema = z
  .object({
    body: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COMMENT_BODY_BYTES, {
        message: `bodyはUTF-8で${MAX_COMMENT_BODY_BYTES} bytes（64 KiB）以下にしてください。`,
      }),
    authorLabel: z.string().max(MAX_AUTHOR_LABEL_CHARACTERS).nullable().optional(),
    relatedCommitOid: z.string().regex(GIT_OBJECT_ID_PATTERN).nullable().optional(),
    references: optionalCodeReferences,
    idempotencyKey,
  })
  .strict()
  .superRefine(requireRelatedCommitForReferences);

export const commentPostEditInputSchema = z
  .object({
    body: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COMMENT_BODY_BYTES, {
        message: `bodyはUTF-8で${MAX_COMMENT_BODY_BYTES} bytes（64 KiB）以下にしてください。`,
      }),
    relatedCommitOid: z.string().regex(GIT_OBJECT_ID_PATTERN).nullable().optional(),
    references: optionalCodeReferences,
  })
  .strict();

export const pullRequestSyncInputSchema = z
  .object({
    pullRequest: nonEmptyString,
    commentUpdates: z
      .array(
        z
          .object({
            commentRef: commentUri,
            reply: z
              .string()
              .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COMMENT_BODY_BYTES, {
                message: `replyはUTF-8で${MAX_COMMENT_BODY_BYTES} bytes（64 KiB）以下にしてください。`,
              }),
            resolve: z.boolean(),
            references: optionalCodeReferences,
            idempotencyKey,
          })
          .strict(),
      )
      .max(500)
      .optional(),
  })
  .strict();

const walkthroughContentInputSchema = z
  .object({
    sourceOid: z.string().regex(GIT_OBJECT_ID_PATTERN),
    title: z.string().min(1).max(MAX_WALKTHROUGH_TITLE_CHARACTERS),
    body: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_WALKTHROUGH_BODY_BYTES),
    authorLabel: z.string().max(MAX_AUTHOR_LABEL_CHARACTERS).nullable().optional(),
    diagramBindings: z.record(z.string(), z.string()).optional(),
    references: z.array(codeReferenceInputSchema).min(1).max(MAX_CODE_REFERENCES),
  })
  .strict();

export const walkthroughPublishInputSchema = walkthroughContentInputSchema.extend({
  pullRequest: nonEmptyString,
});

export const walkthroughUpdateInputSchema = walkthroughContentInputSchema;

export const agentCommandInputSchemas = {
  doctor: z.object({ cwd: nonEmptyString }).strict(),
  "pr.refresh": z.object({ reference: nonEmptyString }).strict(),
  "pr.sync": pullRequestSyncInputSchema.extend({
    repositoryPath: nonEmptyString.optional(),
    allowUntracked: z.boolean().default(false),
  }),
  "pr.attach": z.object({ reference: nonEmptyString, repositoryPath: nonEmptyString }).strict(),
  "pr.reset.preview": z.object({ reference: nonEmptyString }).strict(),
  "pr.reset": z.object({ reference: nonEmptyString, confirmed: z.literal(true) }).strict(),
  "comment.list": z
    .object({
      reference: nonEmptyString,
      resolved: z.boolean().optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_COMMENT_LIST_LIMIT)
        .default(DEFAULT_COMMENT_LIST_LIMIT),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  "comment.watch": z
    .object({
      cursor: z.string().min(1).max(512).optional(),
      limit: z.number().int().min(1).max(MAX_COMMENT_WATCH_LIMIT),
    })
    .strict(),
  "comment.create": commentCreateInputSchema,
  "comment.get": z.object({ uri: commentUri, live: z.boolean().default(false) }).strict(),
  "comment.reply": z.object({ uri: commentUri, reply: commentReplyInputSchema }).strict(),
  "comment.edit": z
    .object({ uri: commentUri, postId: nonEmptyString, edit: commentPostEditInputSchema })
    .strict(),
  "comment.resolve": z.object({ uri: commentUri }).strict(),
  "comment.reopen": z.object({ uri: commentUri }).strict(),
  "walkthrough.get": z.object({ uri: walkthroughUri }).strict(),
  "walkthrough.publish": walkthroughPublishInputSchema,
  "walkthrough.update": z
    .object({ uri: walkthroughUri, content: walkthroughUpdateInputSchema })
    .strict(),
  "walkthrough.delete.preview": z.object({ uri: walkthroughUri }).strict(),
  "walkthrough.delete": z.object({ uri: walkthroughUri, confirmed: z.literal(true) }).strict(),
} as const;

export type AgentCommandOperation = keyof typeof agentCommandInputSchemas;
