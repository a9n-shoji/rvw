import type { ChangeKind } from "../../domain/models.js";

export interface SourceAnchor {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface Structure {
  id: string;
  title: string;
  scope: string;
  initialFocus?: string;
  nodes: StructureNode[];
  edges: StructureEdge[];
}

export interface StructureNode {
  id: string;
  label: string;
  description?: string;
  kind?: string;
  anchor?: SourceAnchor;
  /** Phase 0 diagram notation. The Viewer never derives this from `kind`. */
  notation?: "class" | "database" | "interface" | "component" | "external" | "concept";
}

export interface StructureEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  directed: boolean;
  anchors?: SourceAnchor[];
}

export interface StructureFixture {
  category: "Code relationships" | "Flow comparisons" | "Synthetic";
  structure: Structure;
  /** Phase 0-only layout comparison; not part of the proposed artifact value. */
  layout?: "ranked" | "bidirectional";
  /** Phase 0 preview diff state; production must derive this from the selected commit range. */
  sourceChangeKinds?: Readonly<Record<string, ChangeKind>>;
  updatedStructure?: Structure;
  walkthroughMermaid?: string;
  temporary: true;
}
