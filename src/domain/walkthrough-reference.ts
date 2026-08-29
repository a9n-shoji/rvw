import type { WalkthroughReference } from "./models.js";

export function walkthroughReferenceFingerprint(
  sourceOid: string,
  reference: Pick<WalkthroughReference, "path" | "startLine" | "endLine">,
): string {
  return JSON.stringify([sourceOid, reference.path, reference.startLine, reference.endLine]);
}
