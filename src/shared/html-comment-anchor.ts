import { z } from "zod";
const path = z.array(z.number().int().nonnegative()).max(128);
export const htmlCommentAnchorSchema = z
  .object({
    fenceStartLine: z.number().int().positive(),
    path,
    startOffset: z.number().int().nonnegative().optional(),
    endPath: path.optional(),
    endOffset: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.startOffset === undefined &&
        value.endPath === undefined &&
        value.endOffset === undefined) ||
      (value.startOffset !== undefined &&
        value.endPath !== undefined &&
        value.endOffset !== undefined),
    "Text anchors require both endpoints",
  );
