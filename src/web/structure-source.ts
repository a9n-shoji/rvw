import type { SourceAnchor } from "../domain/models.js";

export function structureSourceAnchorLabel(anchor: SourceAnchor): string {
  return anchor.startLine === null
    ? anchor.path
    : `${anchor.path}:${anchor.startLine}${anchor.endLine === anchor.startLine ? "" : `-${anchor.endLine}`}`;
}
