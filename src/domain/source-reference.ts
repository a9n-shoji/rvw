import type { SourceAnchor, Structure, StructureSourceLocator } from "./models.js";

export function sourceAnchorFingerprint(
  sourceOid: string,
  reference: Pick<SourceAnchor, "path" | "startLine" | "endLine">,
): string {
  return JSON.stringify([sourceOid, reference.path, reference.startLine, reference.endLine]);
}

export function structureSourceAnchor(
  structure: Structure,
  locator: StructureSourceLocator,
): SourceAnchor | null {
  if (locator.kind === "node") {
    return structure.nodes.find((node) => node.id === locator.nodeId)?.anchor ?? null;
  }
  const edge = structure.edges.find((candidate) => candidate.id === locator.edgeId);
  return edge?.anchors[locator.anchorIndex] ?? null;
}
