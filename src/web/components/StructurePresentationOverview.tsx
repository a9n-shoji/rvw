import type { Structure, StructureNode, StructurePresentationRegion } from "../../domain/models.js";
import type { StructureGuideDisclosure } from "../structure-session.js";

export interface StructurePresentationOverviewNode {
  id: string;
  label: string;
  isStart: boolean;
}

export interface StructurePresentationOverviewConnection {
  edgeId: string;
  label: string;
  directed: boolean;
  fromNode: StructurePresentationOverviewNode;
  toNode: StructurePresentationOverviewNode;
}

export interface StructurePresentationOverviewRegion {
  index: number;
  label: string;
  nodeIds: readonly string[];
  nodeCount: number;
}

export interface StructurePresentationOverviewModel {
  thesis: string;
  startNode: StructurePresentationOverviewNode;
  coreRelations: readonly StructurePresentationOverviewConnection[];
  regions: readonly StructurePresentationOverviewRegion[];
}

function stableCompare(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function overviewNode(node: StructureNode, startNodeId: string): StructurePresentationOverviewNode {
  return {
    id: node.id,
    label: node.label,
    isStart: node.id === startNodeId,
  };
}

function overviewRegions(
  regions: readonly StructurePresentationRegion[],
  nodeIds: ReadonlySet<string>,
): StructurePresentationOverviewRegion[] {
  return regions.map((region, index) => {
    const memberIds = region.nodeIds.filter((nodeId) => nodeIds.has(nodeId));
    return {
      index,
      label: region.label,
      nodeIds: memberIds,
      nodeCount: memberIds.length,
    };
  });
}

export function buildStructurePresentationOverviewModel(
  structure: Structure,
): StructurePresentationOverviewModel | null {
  const presentation = structure.presentation;
  if (!presentation) return null;

  const nodesById = new Map(structure.nodes.map((node) => [node.id, node]));
  const nodeIds = new Set(nodesById.keys());
  const startNode = nodesById.get(presentation.startNodeId);
  if (!startNode) return null;

  const backboneEdgeIds = new Set(presentation.primaryBackbone?.edgeIds ?? []);
  const coreRelations = structure.edges
    .filter((edge) => backboneEdgeIds.has(edge.id))
    .sort((left, right) => stableCompare(left.id, right.id))
    .flatMap((edge): StructurePresentationOverviewConnection[] => {
      const fromNode = nodesById.get(edge.from);
      const toNode = nodesById.get(edge.to);
      if (!fromNode || !toNode) return [];
      return [
        {
          edgeId: edge.id,
          label: edge.label,
          directed: edge.directed,
          fromNode: overviewNode(fromNode, presentation.startNodeId),
          toNode: overviewNode(toNode, presentation.startNodeId),
        },
      ];
    });
  return {
    thesis: presentation.thesis,
    startNode: overviewNode(startNode, presentation.startNodeId),
    coreRelations,
    regions: overviewRegions(presentation.regions, nodeIds),
  };
}

function FocusNodeButton({
  node,
  focused,
  compact = false,
  onFocusNode,
}: {
  node: StructurePresentationOverviewNode;
  focused: boolean;
  compact?: boolean;
  onFocusNode: (nodeId: string) => void;
}) {
  return (
    <button
      type="button"
      className={`structure-presentation-overview-node${compact ? " compact" : ""}`}
      data-node-id={node.id}
      data-authorial-start={node.isStart ? "true" : undefined}
      data-focused={focused ? "true" : undefined}
      aria-label={`${node.label}.${node.isStart ? " Authorial start node." : ""} Focus this node and frame its one-hop context.`}
      aria-pressed={focused}
      onClick={() => onFocusNode(node.id)}
    >
      {node.isStart && <span className="structure-presentation-overview-start">Start</span>}
      <span>{node.label}</span>
    </button>
  );
}

function CoreRelationNodeButton({
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
      className="structure-presentation-overview-relation-node"
      data-node-id={node.id}
      data-focused={focused ? "true" : undefined}
      aria-label={`${node.label}${node.isStart ? ". Authorial start node" : ""}. Focus this node and frame its one-hop context.`}
      aria-pressed={focused}
      onClick={() => onFocusNode(node.id)}
    >
      {node.label}
    </button>
  );
}

function GuideDisclosureButton({
  children,
  expanded,
  count,
  onToggle,
}: {
  children: string;
  expanded: boolean;
  count?: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="structure-presentation-guide-toggle"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      {children}
      {count !== undefined && <span className="structure-presentation-guide-count">{count}</span>}
    </button>
  );
}

export function StructurePresentationOverview({
  structure,
  focusedNodeId,
  framedRegionIndex,
  disclosure,
  onToggleDisclosure,
  onFocusNode,
  onFrameRegion,
}: {
  structure: Structure;
  focusedNodeId: string | null;
  framedRegionIndex: number | null;
  disclosure: StructureGuideDisclosure;
  onToggleDisclosure: (section: keyof StructureGuideDisclosure) => void;
  onFocusNode: (nodeId: string) => void;
  onFrameRegion: (regionIndex: number) => void;
}) {
  const model = buildStructurePresentationOverviewModel(structure);
  if (!model) return null;

  const hasCore = model.coreRelations.length > 0;
  const hasRegions = model.regions.length > 0;
  return (
    <section className="structure-presentation-overview" aria-label="Authorial Structure guide">
      <div className="structure-presentation-guide-header">
        <strong>Guide</strong>
        <FocusNodeButton
          node={model.startNode}
          focused={focusedNodeId === model.startNode.id}
          compact
          onFocusNode={onFocusNode}
        />
        <div className="structure-presentation-guide-controls" aria-label="Guide sections">
          <GuideDisclosureButton
            expanded={disclosure.thesis}
            onToggle={() => onToggleDisclosure("thesis")}
          >
            Thesis
          </GuideDisclosureButton>
          {hasCore && (
            <GuideDisclosureButton
              expanded={disclosure.coreRelations}
              count={model.coreRelations.length}
              onToggle={() => onToggleDisclosure("coreRelations")}
            >
              Core relations
            </GuideDisclosureButton>
          )}
          {hasRegions && (
            <GuideDisclosureButton
              expanded={disclosure.regions}
              count={model.regions.length}
              onToggle={() => onToggleDisclosure("regions")}
            >
              Regions
            </GuideDisclosureButton>
          )}
        </div>
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

      {hasCore && disclosure.coreRelations && (
        <div className="structure-presentation-guide-section structure-presentation-overview-core">
          <strong>Explanation backbone</strong>
          <div className="structure-presentation-overview-scroll">
            <ul aria-label="Core relations. This is an unordered exact relation set.">
              {model.coreRelations.map((connection) => {
                const relationDescription = connection.directed
                  ? `${connection.fromNode.label} to ${connection.toNode.label}: ${connection.label}`
                  : `${connection.fromNode.label} and ${connection.toNode.label}: ${connection.label}`;
                return (
                  <li
                    key={connection.edgeId}
                    className="structure-presentation-overview-connection"
                    data-edge-id={connection.edgeId}
                    data-direction={connection.directed ? "directed" : "undirected"}
                    aria-label={`${relationDescription}. Exact explanation backbone relation.`}
                  >
                    <CoreRelationNodeButton
                      node={connection.fromNode}
                      focused={focusedNodeId === connection.fromNode.id}
                      onFocusNode={onFocusNode}
                    />
                    <span className="structure-presentation-overview-relation" aria-hidden="true">
                      <span>{connection.label}</span>
                      <b>{connection.directed ? "→" : "—"}</b>
                    </span>
                    <CoreRelationNodeButton
                      node={connection.toNode}
                      focused={focusedNodeId === connection.toNode.id}
                      onFocusNode={onFocusNode}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {hasRegions && disclosure.regions && (
        <div className="structure-presentation-guide-section structure-presentation-overview-regions">
          <strong>Regions</strong>
          <ol aria-label="Comprehension regions in canonical spatial order">
            {model.regions.map((region) => (
              <li key={`${region.index}:${region.label}`}>
                <button
                  type="button"
                  className="structure-presentation-overview-region"
                  data-region-index={region.index}
                  aria-pressed={framedRegionIndex === region.index}
                  aria-label={`Frame region R${region.index + 1}: ${region.label}, ${region.nodeCount} ${region.nodeCount === 1 ? "node" : "nodes"}`}
                  onClick={() => onFrameRegion(region.index)}
                >
                  <span className="structure-presentation-overview-region-order" aria-hidden="true">
                    R{region.index + 1}
                  </span>
                  <span>{region.label}</span>
                  <span className="structure-presentation-overview-region-count">
                    {region.nodeCount} {region.nodeCount === 1 ? "Node" : "Nodes"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
