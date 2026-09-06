import type {
  Structure,
  StructureEdge,
  StructureNode,
  StructurePresentationRegion,
} from "../../domain/models.js";

export type StructurePresentationEdgeDirection = "forward" | "reverse" | "undirected";

export interface StructurePresentationOverviewNode {
  id: string;
  label: string;
  isStart: boolean;
}

export interface StructurePresentationOverviewConnection {
  edgeId: string;
  label: string;
  direction: StructurePresentationEdgeDirection;
  fromNode: StructurePresentationOverviewNode;
  toNode: StructurePresentationOverviewNode;
}

export interface StructurePresentationOverviewRegion {
  label: string;
  nodeCount: number;
}

export interface StructurePresentationOverviewModel {
  thesis: string;
  startNode: StructurePresentationOverviewNode;
  spineNodes: readonly StructurePresentationOverviewNode[];
  spineConnections: readonly StructurePresentationOverviewConnection[];
  regions: readonly StructurePresentationOverviewRegion[];
}

function overviewNode(node: StructureNode, startNodeId: string): StructurePresentationOverviewNode {
  return {
    id: node.id,
    label: node.label,
    isStart: node.id === startNodeId,
  };
}

function edgeDirection(
  edge: StructureEdge,
  fromNodeId: string,
  toNodeId: string,
): StructurePresentationEdgeDirection {
  if (!edge.directed) return "undirected";
  return edge.from === fromNodeId && edge.to === toNodeId ? "forward" : "reverse";
}

function edgeJoins(edge: StructureEdge, leftNodeId: string, rightNodeId: string): boolean {
  return (
    (edge.from === leftNodeId && edge.to === rightNodeId) ||
    (edge.from === rightNodeId && edge.to === leftNodeId)
  );
}

function overviewRegions(
  regions: readonly StructurePresentationRegion[],
): StructurePresentationOverviewRegion[] {
  return regions.map((region) => ({
    label: region.label,
    nodeCount: region.nodeIds.length,
  }));
}

export function buildStructurePresentationOverviewModel(
  structure: Structure,
): StructurePresentationOverviewModel | null {
  const presentation = structure.presentation;
  if (!presentation) return null;

  const nodesById = new Map(structure.nodes.map((node) => [node.id, node]));
  const edgesById = new Map(structure.edges.map((edge) => [edge.id, edge]));
  const startNode = nodesById.get(presentation.startNodeId);
  if (!startNode) return null;

  let spineNodes: StructurePresentationOverviewNode[] = [];
  let spineConnections: StructurePresentationOverviewConnection[] = [];
  const spine = presentation.primarySpine;
  if (spine) {
    const resolvedNodes = spine.nodeIds.map((nodeId) => nodesById.get(nodeId));
    const resolvedEdges = spine.edgeIds.map((edgeId) => edgesById.get(edgeId));
    const complete =
      resolvedNodes.every((node) => node !== undefined) &&
      resolvedEdges.length === resolvedNodes.length - 1 &&
      resolvedEdges.every((edge, index) => {
        const leftNode = resolvedNodes[index];
        const rightNode = resolvedNodes[index + 1];
        return edge && leftNode && rightNode && edgeJoins(edge, leftNode.id, rightNode.id);
      });
    if (complete) {
      spineNodes = resolvedNodes.map((node) => overviewNode(node, presentation.startNodeId));
      spineConnections = resolvedEdges.map((edge, index) => {
        const fromNode = spineNodes[index]!;
        const toNode = spineNodes[index + 1]!;
        return {
          edgeId: edge!.id,
          label: edge!.label,
          direction: edgeDirection(edge!, fromNode.id, toNode.id),
          fromNode,
          toNode,
        };
      });
    }
  }

  return {
    thesis: presentation.thesis,
    startNode: overviewNode(startNode, presentation.startNodeId),
    spineNodes,
    spineConnections,
    regions: overviewRegions(presentation.regions),
  };
}

function FocusNodeButton({
  node,
  focused,
  spinePosition,
  spineLength,
  onFocusNode,
}: {
  node: StructurePresentationOverviewNode;
  focused: boolean;
  spinePosition: number | null;
  spineLength: number;
  onFocusNode: (nodeId: string) => void;
}) {
  const spineDescription =
    spinePosition === null ? "" : ` Reading spine position ${spinePosition} of ${spineLength}.`;
  const startDescription = node.isStart ? " Authorial start node." : "";
  return (
    <button
      type="button"
      className="structure-presentation-overview-node"
      data-node-id={node.id}
      data-authorial-start={node.isStart ? "true" : undefined}
      data-focused={focused ? "true" : undefined}
      aria-label={`${node.label}.${startDescription}${spineDescription} Focus this node.`}
      aria-pressed={focused}
      onClick={() => onFocusNode(node.id)}
    >
      {node.isStart && <span className="structure-presentation-overview-start">Start</span>}
      <span>{node.label}</span>
    </button>
  );
}

function directionGlyph(direction: StructurePresentationEdgeDirection): string {
  switch (direction) {
    case "forward":
      return "→";
    case "reverse":
      return "←";
    case "undirected":
      return "—";
  }
}

function directionDescription(direction: StructurePresentationEdgeDirection): string {
  switch (direction) {
    case "forward":
      return "The factual direction follows the left-to-right reading spine.";
    case "reverse":
      return "The factual direction points right-to-left, opposite the reading spine.";
    case "undirected":
      return "This factual relation is undirected.";
  }
}

export function StructurePresentationOverview({
  structure,
  focusedNodeId,
  onFocusNode,
}: {
  structure: Structure;
  focusedNodeId: string | null;
  onFocusNode: (nodeId: string) => void;
}) {
  const model = buildStructurePresentationOverviewModel(structure);
  if (!model) return null;

  const hasSpine = model.spineNodes.length > 0;
  return (
    <section
      className="structure-presentation-overview"
      aria-label="Authorial spatial presentation, not execution sequence"
    >
      <div
        className="structure-presentation-overview-thesis"
        role="note"
        aria-label="Structure thesis"
      >
        <strong>Thesis</strong>
        <span title={model.thesis}>{model.thesis}</span>
      </div>
      <div className="structure-presentation-overview-reading">
        <strong>{hasSpine ? "Reading spine" : "Start"}</strong>
        <div
          className="structure-presentation-overview-scroll"
          role="group"
          aria-label={
            hasSpine
              ? "Reading spine order. This is not an execution sequence. Choose any node directly."
              : "Authorial start for spatial exploration. Choose the node directly."
          }
          tabIndex={0}
        >
          {hasSpine ? (
            <div className="structure-presentation-overview-spine">
              {model.spineNodes.map((node, index) => {
                const connection = index === 0 ? null : model.spineConnections[index - 1];
                return (
                  <div className="structure-presentation-overview-spine-entry" key={node.id}>
                    {connection && (
                      <span
                        className="structure-presentation-overview-connection"
                        data-edge-id={connection.edgeId}
                        data-direction={connection.direction}
                        role="img"
                        aria-label={`${connection.fromNode.label} and ${connection.toNode.label}: ${connection.label}. ${directionDescription(connection.direction)}`}
                      >
                        <span
                          className="structure-presentation-overview-edge-label"
                          aria-hidden="true"
                        >
                          {connection.label}
                        </span>
                        <span
                          className="structure-presentation-overview-direction"
                          aria-hidden="true"
                        >
                          {directionGlyph(connection.direction)}
                        </span>
                      </span>
                    )}
                    <FocusNodeButton
                      node={node}
                      focused={focusedNodeId === node.id}
                      spinePosition={index + 1}
                      spineLength={model.spineNodes.length}
                      onFocusNode={onFocusNode}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <FocusNodeButton
              node={model.startNode}
              focused={focusedNodeId === model.startNode.id}
              spinePosition={null}
              spineLength={0}
              onFocusNode={onFocusNode}
            />
          )}
        </div>
      </div>
      {model.regions.length > 0 && (
        <div className="structure-presentation-overview-regions">
          <strong>Regions</strong>
          <ol aria-label="Comprehension regions in canonical spatial order" tabIndex={0}>
            {model.regions.map((region, index) => (
              <li key={`${index}:${region.label}`}>
                <span className="structure-presentation-overview-region-order" aria-hidden="true">
                  R{index + 1}
                </span>
                <span>{region.label}</span>
                <span className="structure-presentation-overview-region-count">
                  {region.nodeCount} {region.nodeCount === 1 ? "Node" : "Nodes"}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
