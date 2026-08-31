import type { SourceAnchor } from "./models.js";

export function sourceAnchorFingerprint(
  sourceOid: string,
  reference: Pick<SourceAnchor, "path" | "startLine" | "endLine">,
): string {
  return JSON.stringify([sourceOid, reference.path, reference.startLine, reference.endLine]);
}
