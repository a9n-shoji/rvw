import type { Structure, StructureNode } from "../../domain/models.js";
import type { StructureGuideDisclosure } from "../structure-session.js";

export interface StructurePresentationOverviewNode {
  id: string;
  label: string;
  isStart: boolean;
}

export interface StructurePresentationOverviewModel {
  thesis: string;
  startNode: StructurePresentationOverviewNode;
}

function overviewNode(node: StructureNode, startNodeId: string): StructurePresentationOverviewNode {
  return {
    id: node.id,
    label: node.label,
    isStart: node.id === startNodeId,
  };
}

export function buildStructurePresentationOverviewModel(
  structure: Structure,
): StructurePresentationOverviewModel | null {
  const presentation = structure.presentation;
  if (!presentation) return null;
  const startNode = structure.nodes.find((node) => node.id === presentation.startNodeId);
  if (!startNode) return null;
  return {
    thesis: presentation.thesis,
    startNode: overviewNode(startNode, presentation.startNodeId),
  };
}

function FocusNodeButton({
  node,
  focused,
  onFocusNode,
}: {
  node: StructurePresentationOverviewNode;
  focused: boolean;
  onFocusNode: (nodeId: string) => void;
}) {
  return (
    <button
      type="button"
      className="structure-presentation-overview-node compact"
      data-node-id={node.id}
      data-authorial-start="true"
      data-focused={focused ? "true" : undefined}
      aria-label={`${node.label}. Authorial start node. Open this node and its one-hop context in Graph.`}
      aria-pressed={focused}
      onClick={() => onFocusNode(node.id)}
    >
      <span className="structure-presentation-overview-start">Start</span>
      <span>{node.label}</span>
    </button>
  );
}

export function StructurePresentationOverview({
  structure,
  focusedNodeId,
  disclosure,
  onToggleDisclosure,
  onFocusNode,
}: {
  structure: Structure;
  focusedNodeId: string | null;
  disclosure: StructureGuideDisclosure;
  onToggleDisclosure: (section: keyof StructureGuideDisclosure) => void;
  onFocusNode: (nodeId: string) => void;
}) {
  const model = buildStructurePresentationOverviewModel(structure);
  if (!model) return null;

  return (
    <section className="structure-presentation-overview" aria-label="Authorial Structure guide">
      <div className="structure-presentation-guide-header">
        <strong>Guide</strong>
        <FocusNodeButton
          node={model.startNode}
          focused={focusedNodeId === model.startNode.id}
          onFocusNode={onFocusNode}
        />
        <button
          type="button"
          className="structure-presentation-guide-toggle"
          aria-expanded={disclosure.thesis}
          onClick={() => onToggleDisclosure("thesis")}
        >
          <span aria-hidden="true">{disclosure.thesis ? "▾" : "▸"}</span>
          Thesis
        </button>
      </div>

      {disclosure.thesis && (
        <div
          className="structure-presentation-guide-section structure-presentation-overview-thesis"
          role="note"
          aria-label="Structure thesis"
        >
          <strong>Thesis</strong>
          <span>{model.thesis}</span>
        </div>
      )}
    </section>
  );
}
