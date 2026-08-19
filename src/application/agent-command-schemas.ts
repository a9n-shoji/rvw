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

const nonEmptyString = z.string().min(1);
const commentUri = z.string().regex(/^rvw:\/\/comment\//);
const walkthroughUri = z.string().regex(/^rvw:\/\/walkthrough\//);
const nullableCommentLine = z.number().int().positive().nullable().optional().default(null);

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

export const commentCreateInputSchema = z
  .object({
    pullRequest: nonEmptyString,
    target: commentTargetInputSchema,
    body: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0)
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COMMENT_BODY_BYTES),
    authorLabel: z.string().max(MAX_AUTHOR_LABEL_CHARACTERS).nullable().optional(),
  })
  .strict();

export const commentReplyInputSchema = z
  .object({
    body: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COMMENT_BODY_BYTES),
    authorLabel: z.string().max(MAX_AUTHOR_LABEL_CHARACTERS).nullable().optional(),
    relatedCommitOid: z.string().regex(GIT_OBJECT_ID_PATTERN).nullable().optional(),
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
              .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COMMENT_BODY_BYTES),
            resolve: z.boolean(),
          })
          .strict(),
      )
      .max(500)
      .optional(),
  })
  .strict();

const walkthroughReferenceInputSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    label: z.string().min(1).max(MAX_WALKTHROUGH_REFERENCE_LABEL_CHARACTERS),
    path: z.string().min(1).max(MAX_WALKTHROUGH_REFERENCE_PATH_CHARACTERS),
    startLine: z.number().int().positive().nullable().optional().default(null),
    endLine: z.number().int().positive().nullable().optional().default(null),
    description: z.string().max(MAX_WALKTHROUGH_REFERENCE_DESCRIPTION_CHARACTERS).nullable(),
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
    references: z.array(walkthroughReferenceInputSchema).min(1).max(MAX_WALKTHROUGH_REFERENCES),
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
  "comment.create": commentCreateInputSchema,
  "comment.get": z.object({ uri: commentUri, live: z.boolean().default(false) }).strict(),
  "comment.reply": z.object({ uri: commentUri, reply: commentReplyInputSchema }).strict(),
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
