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
  MAX_ISSUE_REFERENCE_CHARACTERS,
  MAX_WALKTHROUGH_BODY_BYTES,
  MAX_WALKTHROUGH_ISSUES_TO_ADD,
  MAX_WALKTHROUGH_TITLE_CHARACTERS,
} from "../shared/constants.js";

const nonEmptyString = z.string().min(1);
const confirmationToken = z.string().regex(/^[0-9a-f]{64}$/);
const commentUri = z.string().regex(/^rvw:\/\/comment\//);
const walkthroughUri = z.string().regex(/^rvw:\/\/walkthrough\//);
const nullableCommentLine = z.number().int().positive().nullable().optional().default(null);
const idempotencyKey = z.string().min(1).max(MAX_IDEMPOTENCY_KEY_CHARACTERS).optional();

const pullRequestReviewTargetInputSchema = z
  .object({ kind: z.literal("pull-request"), pullRequest: nonEmptyString })
  .strict();
const repositoryReviewTargetInputSchema = z
  .object({ kind: z.literal("repository"), repository: nonEmptyString })
  .strict();

export const reviewTargetInputSchema = z.discriminatedUnion("kind", [
  pullRequestReviewTargetInputSchema,
  repositoryReviewTargetInputSchema,
]);

const pullRequestCommentTargetInputSchema = z.object({ kind: z.literal("pull-request") }).strict();
const repositoryReviewCommentTargetInputSchema = z
  .object({ kind: z.literal("repository") })
  .strict();
const issueCommentTargetInputSchema = z
  .object({
    kind: z.literal("issue"),
    issue: nonEmptyString,
    startLine: nullableCommentLine,
    endLine: nullableCommentLine,
  })
  .strict();
const walkthroughCommentTargetInputSchema = z
  .object({
    kind: z.literal("walkthrough"),
    walkthroughId: z.uuid(),
    startLine: nullableCommentLine,
    endLine: nullableCommentLine,
  })
  .strict();
const pullRequestMarkdownCommentTargetInputSchema = z
  .object({
    kind: z.literal("document"),
    documentKind: z.literal("pull-request-markdown"),
    startLine: nullableCommentLine,
    endLine: nullableCommentLine,
  })
  .strict();
const repositoryFileCommentTargetInputSchema = z
  .object({
    kind: z.literal("document"),
    documentKind: z.literal("repository-file"),
    sourceOid: z.string().regex(GIT_OBJECT_ID_PATTERN),
    path: nonEmptyString,
    startLine: nullableCommentLine,
    endLine: nullableCommentLine,
  })
  .strict();

function validateCommentTargetLines(
  target: { kind: string; startLine?: number | null; endLine?: number | null },
  context: z.RefinementCtx,
): void {
  if (target.kind === "pull-request" || target.kind === "repository") return;
  const startLine = target.startLine ?? null;
  const endLine = target.endLine ?? null;
  if ((startLine === null) !== (endLine === null)) {
    context.addIssue({
      code: "custom",
      message: "startLineとendLineは両方指定するか、両方省略してください。",
    });
    return;
  }
  if (startLine !== null && endLine !== null && endLine < startLine) {
    context.addIssue({
      code: "custom",
      message: "endLineはstartLine以上にしてください。",
    });
  }
}

export const commentTargetInputSchema = z
  .union([
    pullRequestCommentTargetInputSchema,
    repositoryReviewCommentTargetInputSchema,
    issueCommentTargetInputSchema,
    walkthroughCommentTargetInputSchema,
    pullRequestMarkdownCommentTargetInputSchema,
    repositoryFileCommentTargetInputSchema,
  ])
  .superRefine(validateCommentTargetLines);

const pullRequestCommentTargetForCreateSchema = z
  .union([
    pullRequestCommentTargetInputSchema,
    issueCommentTargetInputSchema,
    walkthroughCommentTargetInputSchema,
    pullRequestMarkdownCommentTargetInputSchema,
    repositoryFileCommentTargetInputSchema,
  ])
  .superRefine(validateCommentTargetLines);

const repositoryReviewCommentTargetForCreateSchema = z
  .union([
    repositoryReviewCommentTargetInputSchema,
    issueCommentTargetInputSchema,
    walkthroughCommentTargetInputSchema,
    repositoryFileCommentTargetInputSchema,
  ])
  .superRefine(validateCommentTargetLines);

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

const commentCreateFields = {
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
};

export const commentCreateInputSchema = z
  .union([
    z
      .object({
        ...commentCreateFields,
        review: pullRequestReviewTargetInputSchema,
        pullRequest: z.never().optional(),
        target: pullRequestCommentTargetForCreateSchema,
      })
      .strict(),
    z
      .object({
        ...commentCreateFields,
        review: repositoryReviewTargetInputSchema,
        pullRequest: z.never().optional(),
        target: repositoryReviewCommentTargetForCreateSchema,
      })
      .strict(),
    z
      .object({
        ...commentCreateFields,
        review: z.never().optional(),
        pullRequest: nonEmptyString,
        target: pullRequestCommentTargetForCreateSchema,
      })
      .strict(),
  ])
  .superRefine((input, context) => {
    requireRelatedCommitForReferences(input, context);
  });

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
    issuesToAdd: z
      .array(z.string().min(1).max(MAX_ISSUE_REFERENCE_CHARACTERS))
      .max(MAX_WALKTHROUGH_ISSUES_TO_ADD)
      .optional(),
  })
  .strict();

export const walkthroughPublishInputSchema = walkthroughContentInputSchema
  .extend({ review: reviewTargetInputSchema.optional(), pullRequest: nonEmptyString.optional() })
  .superRefine((input, context) => {
    if (Boolean(input.review) === Boolean(input.pullRequest)) {
      context.addIssue({
        code: "custom",
        path: ["review"],
        message: "reviewまたはpullRequestのどちらか一方が必要です。",
      });
    }
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
  "pr.reset": z
    .object({ reference: nonEmptyString, confirmed: z.literal(true), confirmationToken })
    .strict(),
  "pr.issue.add": z.object({ reference: nonEmptyString, issueReference: nonEmptyString }).strict(),
  "pr.issue.refresh": z
    .object({ reference: nonEmptyString, issueReference: nonEmptyString, force: z.literal(true) })
    .strict(),
  "pr.issue.remove.preview": z
    .object({ reference: nonEmptyString, issueReference: nonEmptyString })
    .strict(),
  "pr.issue.remove": z
    .object({
      reference: nonEmptyString,
      issueReference: nonEmptyString,
      confirmed: z.literal(true),
      confirmationToken,
    })
    .strict(),
  "repository.sync": z.object({ repositoryPath: nonEmptyString }).strict(),
  "repository.relocate.preview": z.object({ repositoryPath: nonEmptyString }).strict(),
  "repository.relocate": z
    .object({ repositoryPath: nonEmptyString, confirmed: z.literal(true), confirmationToken })
    .strict(),
  "repository.forget.preview": z.object({ repositoryPath: nonEmptyString }).strict(),
  "repository.forget": z
    .object({ repositoryPath: nonEmptyString, confirmed: z.literal(true), confirmationToken })
    .strict(),
  "repository.issue.add": z
    .object({ repositoryPath: nonEmptyString, issueReference: nonEmptyString })
    .strict(),
  "repository.issue.refresh": z
    .object({
      repositoryPath: nonEmptyString,
      issueReference: nonEmptyString,
      force: z.literal(true),
    })
    .strict(),
  "repository.issue.remove.preview": z
    .object({ repositoryPath: nonEmptyString, issueReference: nonEmptyString })
    .strict(),
  "repository.issue.remove": z
    .object({
      repositoryPath: nonEmptyString,
      issueReference: nonEmptyString,
      confirmed: z.literal(true),
      confirmationToken,
    })
    .strict(),
  "repository.reset.preview": z.object({ repositoryPath: nonEmptyString }).strict(),
  "repository.reset": z
    .object({ repositoryPath: nonEmptyString, confirmed: z.literal(true), confirmationToken })
    .strict(),
  "repository.comments": z
    .object({
      repositoryPath: nonEmptyString,
      resolved: z.boolean().optional(),
    })
    .strict(),
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
  "walkthrough.delete": z
    .object({ uri: walkthroughUri, confirmed: z.literal(true), confirmationToken })
    .strict(),
} as const;

export type AgentCommandOperation = keyof typeof agentCommandInputSchemas;
