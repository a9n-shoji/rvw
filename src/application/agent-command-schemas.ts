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
  MAX_STRUCTURE_DESCRIPTION_CHARACTERS,
  MAX_STRUCTURE_EDGE_ANCHORS,
  MAX_STRUCTURE_EDGES,
  MAX_STRUCTURE_ID_CHARACTERS,
  MAX_STRUCTURE_KIND_CHARACTERS,
  MAX_STRUCTURE_LABEL_CHARACTERS,
  MAX_STRUCTURE_NODES,
  MAX_STRUCTURE_PAYLOAD_BYTES,
  MAX_STRUCTURE_SCOPE_CHARACTERS,
  MAX_STRUCTURE_TITLE_CHARACTERS,
  STRUCTURE_ID_PATTERN,
  MAX_WALKTHROUGH_BODY_BYTES,
  MAX_WALKTHROUGH_TITLE_CHARACTERS,
} from "../shared/constants.js";

const nonEmptyString = z.string().min(1);
const commentUri = z.string().regex(/^rvw:\/\/comment\//);
const walkthroughUri = z.string().regex(/^rvw:\/\/walkthrough\//);
const structureUri = z.string().regex(/^rvw:\/\/structure\//);
const nullableCommentLine = z.number().int().positive().nullable().optional().default(null);
const idempotencyKey = z.string().min(1).max(MAX_IDEMPOTENCY_KEY_CHARACTERS).optional();
const requiredIdempotencyKey = z.string().min(1).max(MAX_IDEMPOTENCY_KEY_CHARACTERS);
const expectedUpdatedAt = z.string().min(1).max(100);

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

export const sourceAnchorInputSchema = z
  .object({
    path: z.string().min(1).max(MAX_CODE_REFERENCE_PATH_CHARACTERS),
    startLine: z.number().int().positive().nullable().optional().default(null),
    endLine: z.number().int().positive().nullable().optional().default(null),
  })
  .strict()
  .superRefine((anchor, context) => {
    if ((anchor.startLine === null) !== (anchor.endLine === null)) {
      context.addIssue({
        code: "custom",
        message: "startLineとendLineは両方指定するか、両方省略してください。",
      });
      return;
    }
    if (anchor.startLine !== null && anchor.endLine !== null && anchor.endLine < anchor.startLine) {
      context.addIssue({ code: "custom", message: "endLineはstartLine以上にしてください。" });
    }
  });

const structureNodeInputSchema = z
  .object({
    id: z.string().max(MAX_STRUCTURE_ID_CHARACTERS).regex(STRUCTURE_ID_PATTERN),
    label: z.string().min(1).max(MAX_STRUCTURE_LABEL_CHARACTERS),
    description: z
      .string()
      .max(MAX_STRUCTURE_DESCRIPTION_CHARACTERS)
      .nullable()
      .optional()
      .default(null),
    kind: z.string().max(MAX_STRUCTURE_KIND_CHARACTERS).nullable().optional().default(null),
    anchor: sourceAnchorInputSchema.nullable().optional().default(null),
  })
  .strict();

const structureEdgeInputSchema = z
  .object({
    id: z.string().max(MAX_STRUCTURE_ID_CHARACTERS).regex(STRUCTURE_ID_PATTERN),
    from: z.string().max(MAX_STRUCTURE_ID_CHARACTERS).regex(STRUCTURE_ID_PATTERN),
    to: z.string().max(MAX_STRUCTURE_ID_CHARACTERS).regex(STRUCTURE_ID_PATTERN),
    label: z.string().min(1).max(MAX_STRUCTURE_LABEL_CHARACTERS),
    directed: z.boolean(),
    anchors: z
      .array(sourceAnchorInputSchema)
      .max(MAX_STRUCTURE_EDGE_ANCHORS)
      .optional()
      .default([]),
  })
  .strict();

const structureContentShape = {
  sourceOid: z.string().regex(GIT_OBJECT_ID_PATTERN),
  title: z.string().min(1).max(MAX_STRUCTURE_TITLE_CHARACTERS),
  scope: z.string().min(1).max(MAX_STRUCTURE_SCOPE_CHARACTERS),
  initialFocus: z
    .string()
    .max(MAX_STRUCTURE_ID_CHARACTERS)
    .regex(STRUCTURE_ID_PATTERN)
    .nullable()
    .optional()
    .default(null),
  nodes: z.array(structureNodeInputSchema).min(1).max(MAX_STRUCTURE_NODES),
  edges: z.array(structureEdgeInputSchema).max(MAX_STRUCTURE_EDGES),
};

function refineStructureContent(
  value: {
    initialFocus: string | null;
    nodes: Array<{ id: string }>;
    edges: Array<{ id: string; from: string; to: string }>;
  },
  context: z.RefinementCtx,
): void {
  const nodeIds = new Set<string>();
  for (const [index, node] of value.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "id"],
        message: "Node IDが重複しています。",
      });
    }
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const [index, edge] of value.edges.entries()) {
    if (edgeIds.has(edge.id)) {
      context.addIssue({
        code: "custom",
        path: ["edges", index, "id"],
        message: "Edge IDが重複しています。",
      });
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from)) {
      context.addIssue({
        code: "custom",
        path: ["edges", index, "from"],
        message: "Edgeのfrom Nodeが存在しません。",
      });
    }
    if (!nodeIds.has(edge.to)) {
      context.addIssue({
        code: "custom",
        path: ["edges", index, "to"],
        message: "Edgeのto Nodeが存在しません。",
      });
    }
  }
  if (value.initialFocus !== null && !nodeIds.has(value.initialFocus)) {
    context.addIssue({
      code: "custom",
      path: ["initialFocus"],
      message: "initialFocus Nodeが存在しません。",
    });
  }
  const graph = { initialFocus: value.initialFocus, nodes: value.nodes, edges: value.edges };
  if (Buffer.byteLength(JSON.stringify(graph), "utf8") > MAX_STRUCTURE_PAYLOAD_BYTES) {
    context.addIssue({
      code: "custom",
      message: `Structure payloadは${MAX_STRUCTURE_PAYLOAD_BYTES} UTF-8 bytes以下にしてください。`,
    });
  }
}

export const structureContentInputSchema = z
  .object(structureContentShape)
  .strict()
  .superRefine(refineStructureContent);

export const structureUpdateInputSchema = z
  .object({ expectedUpdatedAt, ...structureContentShape })
  .strict()
  .superRefine(refineStructureContent);

export const structurePublishInputSchema = z
  .object({
    pullRequest: nonEmptyString,
    idempotencyKey: requiredIdempotencyKey,
    ...structureContentShape,
  })
  .strict()
  .superRefine(refineStructureContent);

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
  "structure.get": z.object({ uri: structureUri }).strict(),
  "structure.list": z.object({ reference: nonEmptyString }).strict(),
  "structure.publish": structurePublishInputSchema,
  "structure.update": z.object({ uri: structureUri, content: structureUpdateInputSchema }).strict(),
  "structure.delete.preview": z.object({ uri: structureUri }).strict(),
  "structure.delete": z
    .object({ uri: structureUri, expectedUpdatedAt, confirmed: z.literal(true) })
    .strict(),
} as const;

export type AgentCommandOperation = keyof typeof agentCommandInputSchemas;
