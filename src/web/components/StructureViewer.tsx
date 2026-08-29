import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { ChangeKind } from "../../domain/models.js";
import type { ThemePreference } from "../theme.js";
import {
  STRUCTURE_NODE_HEIGHT,
  STRUCTURE_NODE_WIDTH,
  incidentStructureEdges,
  initialStructureLayout,
  reconcileStructureLayout,
  structureEdgeRouteOffsets,
  structureLayoutBounds,
  visibleStructureGraph,
  type StructureNeighborhoodDepth,
  type StructurePoint,
} from "../structure-spike/graph.js";
import type {
  SourceAnchor,
  Structure,
  StructureEdge,
  StructureFixture,
  StructureNode,
} from "../structure-spike/model.js";
import { FileEntryIcon } from "./FileIcon.js";
import { ChangeIcon } from "./FileTree.js";
import { MermaidSurface } from "./MermaidSurface.js";

interface StructureViewport {
  x: number;
  y: number;
  scale: number;
}

interface StructureViewerSession {
  focusedNodeId: string | null;
  selectedEdgeId: string | null;
  depth: StructureNeighborhoodDepth;
  expandedNodeIds: Set<string>;
  focusTrail: string[];
  updated: boolean;
  positions: Record<string, StructurePoint>;
  viewport: StructureViewport;
  inspectorOpen: boolean;
  comparisonOpen: boolean;
}

const structureViewerSessions = new Map<string, StructureViewerSession>();
const MIN_SCALE = 0.12;
const MAX_SCALE = 2.4;

function initialSession(fixture: StructureFixture): StructureViewerSession {
  const structure = fixture.structure;
  const focusedNodeId =
    structure.initialFocus && structure.nodes.some((node) => node.id === structure.initialFocus)
      ? structure.initialFocus
      : (structure.nodes[0]?.id ?? null);
  return {
    focusedNodeId,
    selectedEdgeId: null,
    depth: 1,
    expandedNodeIds: new Set(),
    focusTrail: focusedNodeId ? [focusedNodeId] : [],
    updated: false,
    positions: initialStructureLayout(structure, fixture.layout),
    viewport: { x: 110, y: 90, scale: 1 },
    inspectorOpen: false,
    comparisonOpen: false,
  };
}

function nodeById(structure: Structure, nodeId: string | null): StructureNode | undefined {
  return nodeId ? structure.nodes.find((node) => node.id === nodeId) : undefined;
}

function lineLabel(anchor: SourceAnchor): string {
  if (anchor.startLine === undefined || anchor.endLine === undefined) return anchor.path;
  return anchor.startLine === anchor.endLine
    ? `${anchor.path}:L${anchor.startLine}`
    : `${anchor.path}:L${anchor.startLine}–${anchor.endLine}`;
}

function relationDirection(edge: StructureEdge, nodeId: string): string {
  if (!edge.directed) return "関連";
  return edge.from === nodeId ? "出力" : "入力";
}

function categoryLabel(category: StructureFixture["category"]): string {
  if (category === "Code relationships") return "コード中心";
  if (category === "Flow comparisons") return "フロー比較";
  return "合成グラフ";
}

function edgePath(
  edge: StructureEdge,
  positions: Readonly<Record<string, StructurePoint>>,
  routeOffset = 0,
): {
  path: string;
  labelX: number;
  labelY: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
} | null {
  const from = positions[edge.from];
  const to = positions[edge.to];
  if (!from || !to) return null;
  const fromX = from.x + STRUCTURE_NODE_WIDTH / 2;
  const fromY = from.y + STRUCTURE_NODE_HEIGHT / 2;
  const toX = to.x + STRUCTURE_NODE_WIDTH / 2;
  const toY = to.y + STRUCTURE_NODE_HEIGHT / 2;
  if (edge.from === edge.to) {
    const right = from.x + STRUCTURE_NODE_WIDTH;
    const top = from.y;
    const gap = 8;
    return {
      path: `M ${right + gap} ${top + 34} C ${right + 88} ${top - 84}, ${right + 88} ${top + STRUCTURE_NODE_HEIGHT + 84}, ${right + gap} ${top + STRUCTURE_NODE_HEIGHT - 34}`,
      labelX: right + 52,
      labelY: top - 4,
      fromX,
      fromY,
      toX,
      toY,
    };
  }
  const dx = toX - fromX;
  const dy = toY - fromY;
  const length = Math.max(1, Math.hypot(dx, dy));
  const unitX = dx / length;
  const unitY = dy / length;
  const perpendicularX = -unitY;
  const perpendicularY = unitX;
  const boundaryDistance = Math.min(
    STRUCTURE_NODE_WIDTH / 2 / Math.max(0.0001, Math.abs(unitX)),
    STRUCTURE_NODE_HEIGHT / 2 / Math.max(0.0001, Math.abs(unitY)),
  );
  // Edge paths remain behind Nodes, but both endpoints sit just outside the
  // rectangular Node envelope so tails and arrowheads are not painted under a card.
  const endpointDistance = boundaryDistance + 8;
  const startX = fromX + unitX * endpointDistance + perpendicularX * routeOffset;
  const startY = fromY + unitY * endpointDistance + perpendicularY * routeOffset;
  const endX = toX - unitX * endpointDistance + perpendicularX * routeOffset;
  const endY = toY - unitY * endpointDistance + perpendicularY * routeOffset;
  const bend = Math.min(80, Math.abs(dy) * 0.16);
  const controlX = (startX + endX) / 2;
  return {
    path: `M ${startX} ${startY} C ${controlX - bend} ${startY}, ${controlX + bend} ${endY}, ${endX} ${endY}`,
    labelX: (startX + endX) / 2,
    labelY: (startY + endY) / 2,
    fromX: fromX + perpendicularX * routeOffset,
    fromY: fromY + perpendicularY * routeOffset,
    toX: toX + perpendicularX * routeOffset,
    toY: toY + perpendicularY * routeOffset,
  };
}

interface StructureBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface StructureEdgeLabelPlacement {
  edge: StructureEdge;
  x: number;
  y: number;
  selectWidth: number;
  height: number;
  crowded: boolean;
}

const EDGE_LABEL_MAX_TEXT_WIDTH = 210;
const EDGE_LABEL_MIN_TEXT_WIDTH = 64;
const EDGE_LABEL_HORIZONTAL_PADDING = 14;
const EDGE_LABEL_SOURCE_WIDTH = 25;
const EDGE_LABEL_FILE_ICON_WIDTH = 19;
const EDGE_LABEL_CHANGE_ICON_WIDTH = 16;
const EDGE_LABEL_LINE_HEIGHT = 11;

function boxesOverlap(left: StructureBox, right: StructureBox): boolean {
  return !(
    left.right < right.left ||
    left.left > right.right ||
    left.bottom < right.top ||
    left.top > right.bottom
  );
}

function labelBox(x: number, y: number, width: number, height: number, padding = 0): StructureBox {
  return {
    left: x - width / 2 - padding,
    top: y - height / 2 - padding,
    right: x + width / 2 + padding,
    bottom: y + height / 2 + padding,
  };
}

function edgeLabelSize(
  edge: StructureEdge,
  sourceChangeKinds: ReadonlyMap<string, ChangeKind>,
): {
  selectWidth: number;
  boxWidth: number;
  height: number;
} {
  const textUnits = [...edge.label].reduce(
    (total, character) =>
      total +
      (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(character) ? 1 : 0.56),
    0,
  );
  const naturalTextWidth = Math.ceil(textUnits * 9) + EDGE_LABEL_HORIZONTAL_PADDING;
  const textWidth = Math.min(
    EDGE_LABEL_MAX_TEXT_WIDTH,
    Math.max(EDGE_LABEL_MIN_TEXT_WIDTH, naturalTextWidth),
  );
  const lineCount = Math.max(1, Math.ceil(naturalTextWidth / textWidth));
  const height = Math.max(24, lineCount * EDGE_LABEL_LINE_HEIGHT + 10);
  const anchor = edge.anchors?.[0];
  const sourceIdentityWidth = anchor
    ? EDGE_LABEL_FILE_ICON_WIDTH +
      (sourceChangeKinds.has(anchor.path) ? EDGE_LABEL_CHANGE_ICON_WIDTH : 0)
    : 0;
  const selectWidth = textWidth + sourceIdentityWidth;
  return {
    selectWidth,
    boxWidth: selectWidth + (anchor ? EDGE_LABEL_SOURCE_WIDTH : 0),
    height,
  };
}

function placeEdgeLabels(
  edges: StructureEdge[],
  nodes: StructureNode[],
  positions: Readonly<Record<string, StructurePoint>>,
  sourceChangeKinds: ReadonlyMap<string, ChangeKind>,
  routeOffsets: ReadonlyMap<string, number>,
): StructureEdgeLabelPlacement[] {
  const nodeBoxes = nodes.flatMap((node) => {
    const point = positions[node.id];
    return point
      ? [
          {
            left: point.x - 10,
            top: point.y - 10,
            right: point.x + STRUCTURE_NODE_WIDTH + 10,
            bottom: point.y + STRUCTURE_NODE_HEIGHT + 10,
          },
        ]
      : [];
  });
  const occupiedLabels: StructureBox[] = [];
  const placements: StructureEdgeLabelPlacement[] = [];
  const candidateFractions = [0.5, 0.38, 0.62, 0.26, 0.74] as const;
  const candidateOffsets = [0, 48, -48, 96, -96, 144, -144, 204, -204, 276, -276] as const;
  const candidates = candidateOffsets.flatMap((offset) =>
    candidateFractions.map((fraction) => [fraction, offset] as const),
  );

  for (const edge of edges) {
    const geometry = edgePath(edge, positions, routeOffsets.get(edge.id) ?? 0);
    if (!geometry) continue;
    const dx = geometry.toX - geometry.fromX;
    const dy = geometry.toY - geometry.fromY;
    const length = Math.max(1, Math.hypot(dx, dy));
    const perpendicularX = -dy / length;
    const perpendicularY = dx / length;
    const size = edgeLabelSize(edge, sourceChangeKinds);
    const possible =
      edge.from === edge.to
        ? [
            { x: geometry.labelX, y: geometry.labelY },
            { x: geometry.labelX + 36, y: geometry.labelY - 42 },
            { x: geometry.labelX + 70, y: geometry.labelY + 24 },
            { x: geometry.labelX + 92, y: geometry.labelY - 88 },
            { x: geometry.labelX + 124, y: geometry.labelY + 82 },
          ]
        : candidates.map(([fraction, offset]) => ({
            x: geometry.fromX + dx * fraction + perpendicularX * offset,
            y: geometry.fromY + dy * fraction + perpendicularY * offset,
          }));
    const nodeSafe = possible.filter((candidate) => {
      const box = labelBox(candidate.x, candidate.y, size.boxWidth, size.height, 7);
      return !nodeBoxes.some((nodeBox) => boxesOverlap(box, nodeBox));
    });
    const available = nodeSafe.find((candidate) => {
      const box = labelBox(candidate.x, candidate.y, size.boxWidth, size.height, 5);
      return !occupiedLabels.some((occupied) => boxesOverlap(box, occupied));
    });
    // Nodeとの重なりは選ばない。全ての空きslotがrelation labelで埋まった場合だけ、
    // relation同士の重なりを許容する。候補順と寸法はcontent-neutralに保つ。
    const chosen = available ?? nodeSafe[0] ?? possible[0]!;
    occupiedLabels.push(labelBox(chosen.x, chosen.y, size.boxWidth, size.height, 4));
    placements.push({
      edge,
      x: chosen.x,
      y: chosen.y,
      selectWidth: size.selectWidth,
      height: size.height,
      crowded: !available,
    });
  }
  return placements;
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function SourceButton({
  anchor,
  compact = false,
  onOpen,
}: {
  anchor: SourceAnchor;
  compact?: boolean;
  onOpen: (anchor: SourceAnchor, openInRightPane: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={compact ? "structure-source-button compact" : "structure-source-button"}
      title={`${lineLabel(anchor)} · Cmd/Ctrlで右ペイン`}
      aria-label={`${lineLabel(anchor)}をソースで開く`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(anchor, event.metaKey || event.ctrlKey);
      }}
      onContextMenu={(event) => {
        if (event.ctrlKey || event.metaKey) event.preventDefault();
      }}
    >
      <span aria-hidden="true">&lt;/&gt;</span>
      {!compact && <span>{lineLabel(anchor)}</span>}
    </button>
  );
}

function SourceIdentity({
  anchor,
  changeKind,
}: {
  anchor: SourceAnchor;
  changeKind: ChangeKind | undefined;
}) {
  return (
    <span
      className="structure-source-identity"
      data-source-path={anchor.path}
      data-source-change-kind={changeKind}
      title={anchor.path}
    >
      <FileEntryIcon path={anchor.path} kind="file" />
      {changeKind && <ChangeIcon kind={changeKind} />}
    </span>
  );
}

function BreakableStructureLabel({ label }: { label: string }) {
  const parts = label.split(/(::|[./_-])/u);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={`${index}-${part}`}>
          {part}
          {(part === "::" || /^[./_-]$/u.test(part)) && <wbr />}
        </Fragment>
      ))}
    </>
  );
}

function StructureMiniMap({
  structure,
  positions,
  focusedNodeId,
  viewport,
  viewportElement,
}: {
  structure: Structure;
  positions: Readonly<Record<string, StructurePoint>>;
  focusedNodeId: string | null;
  viewport: StructureViewport;
  viewportElement: HTMLDivElement | null;
}) {
  const bounds = structureLayoutBounds(
    structure.nodes.map((node) => node.id),
    positions,
  );
  if (!bounds) return null;
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const mapWidth = 164;
  const mapHeight = 98;
  const scale = Math.min(mapWidth / width, mapHeight / height);
  const viewportWorld = viewportElement
    ? {
        x: -viewport.x / viewport.scale,
        y: -viewport.y / viewport.scale,
        width: viewportElement.clientWidth / viewport.scale,
        height: viewportElement.clientHeight / viewport.scale,
      }
    : null;
  const mapX = (x: number): number => (x - bounds.minX) * scale;
  const mapY = (y: number): number => (y - bounds.minY) * scale;
  return (
    <svg
      className="structure-minimap"
      viewBox={`0 0 ${mapWidth} ${mapHeight}`}
      aria-label="Structure minimap"
    >
      {structure.nodes.map((node) => {
        const point = positions[node.id];
        if (!point) return null;
        return (
          <circle
            key={node.id}
            cx={mapX(point.x + STRUCTURE_NODE_WIDTH / 2)}
            cy={mapY(point.y + STRUCTURE_NODE_HEIGHT / 2)}
            r={node.id === focusedNodeId ? 3.2 : 1.7}
            className={node.id === focusedNodeId ? "focused" : ""}
          />
        );
      })}
      {viewportWorld && (
        <rect
          className="structure-minimap-viewport"
          x={mapX(viewportWorld.x)}
          y={mapY(viewportWorld.y)}
          width={Math.max(2, viewportWorld.width * scale)}
          height={Math.max(2, viewportWorld.height * scale)}
        />
      )}
    </svg>
  );
}

interface StructureViewerProps {
  fixture: StructureFixture;
  sourceOid: string;
  sessionKey: string;
  themePreference: ThemePreference;
  changeKindsByPath: ReadonlyMap<string, ChangeKind>;
  onOpenSource: (
    sourceOid: string,
    anchor: SourceAnchor,
    openInRightPane: boolean,
  ) => Promise<string | null>;
}

function StructureViewerSessionSurface({
  fixture,
  sourceOid,
  sessionKey,
  themePreference,
  changeKindsByPath,
  onOpenSource,
}: StructureViewerProps) {
  const cachedAtMount = useRef(structureViewerSessions.has(sessionKey));
  const [session, setSession] = useState<StructureViewerSession>(() => {
    const cached = structureViewerSessions.get(sessionKey);
    return cached
      ? { ...cached, expandedNodeIds: new Set(cached.expandedNodeIds) }
      : initialSession(fixture);
  });
  const [sourceNotice, setSourceNotice] = useState<string | null>(null);
  const [lastRenderMilliseconds, setLastRenderMilliseconds] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    viewport: StructureViewport;
  } | null>(null);
  const nodeDragRef = useRef<{
    pointerId: number;
    nodeId: string;
    startX: number;
    startY: number;
    point: StructurePoint;
    moved: boolean;
  } | null>(null);
  const renderStarted = performance.now();
  const structure =
    session.updated && fixture.updatedStructure ? fixture.updatedStructure : fixture.structure;
  const edgeRouteOffsets = useMemo(
    () => structureEdgeRouteOffsets(structure.edges),
    [structure.edges],
  );
  const sourceChangeKinds = useMemo(() => {
    const merged = new Map<string, ChangeKind>(Object.entries(fixture.sourceChangeKinds ?? {}));
    for (const [path, kind] of changeKindsByPath) merged.set(path, kind);
    return merged;
  }, [changeKindsByPath, fixture.sourceChangeKinds]);
  const focusedNode = nodeById(structure, session.focusedNodeId);
  const focusedExpanded = session.focusedNodeId
    ? session.expandedNodeIds.has(session.focusedNodeId)
    : false;
  const visible = useMemo(
    () => visibleStructureGraph(structure, session.focusedNodeId, session.depth, focusedExpanded),
    [focusedExpanded, session.depth, session.focusedNodeId, structure],
  );
  const visibleNodes = structure.nodes.filter((node) => visible.nodeIds.has(node.id));
  const visibleEdges = structure.edges.filter((edge) => visible.edgeIds.has(edge.id));
  const viewportWidth = viewportRef.current?.clientWidth ?? 1_400;
  const viewportHeight = viewportRef.current?.clientHeight ?? 900;
  const viewportPadding = 520;
  const renderBounds = {
    left: (-session.viewport.x - viewportPadding) / session.viewport.scale,
    top: (-session.viewport.y - viewportPadding) / session.viewport.scale,
    right: (viewportWidth - session.viewport.x + viewportPadding) / session.viewport.scale,
    bottom: (viewportHeight - session.viewport.y + viewportPadding) / session.viewport.scale,
  };
  const canvasNodes =
    visibleNodes.length <= 120
      ? visibleNodes
      : visibleNodes.filter((node) => {
          if (node.id === session.focusedNodeId) return true;
          const point = session.positions[node.id];
          return (
            point !== undefined &&
            point.x + STRUCTURE_NODE_WIDTH >= renderBounds.left &&
            point.x <= renderBounds.right &&
            point.y + STRUCTURE_NODE_HEIGHT >= renderBounds.top &&
            point.y <= renderBounds.bottom
          );
        });
  const canvasNodeIds = new Set(canvasNodes.map((node) => node.id));
  const canvasEdges =
    visibleNodes.length <= 120
      ? visibleEdges
      : visibleEdges.filter((edge) => canvasNodeIds.has(edge.from) && canvasNodeIds.has(edge.to));
  const incidentIds = new Set(
    session.focusedNodeId
      ? incidentStructureEdges(structure, session.focusedNodeId).map((edge) => edge.id)
      : [],
  );
  const edgeLabelPlacements = placeEdgeLabels(
    canvasEdges.filter((edge) => incidentIds.has(edge.id) || edge.id === session.selectedEdgeId),
    canvasNodes,
    session.positions,
    sourceChangeKinds,
    edgeRouteOffsets,
  );
  const markerId = `structure-arrow-${useId().replaceAll(":", "")}`;

  useEffect(() => {
    structureViewerSessions.set(sessionKey, session);
  }, [session, sessionKey]);

  useLayoutEffect(() => {
    const duration = performance.now() - renderStarted;
    const frame = window.requestAnimationFrame(() => setLastRenderMilliseconds(duration));
    return () => window.cancelAnimationFrame(frame);
    // Render duration is intentionally sampled only when the graph value or visibility changes.
  }, [
    session.depth,
    session.updated,
    structure.edges.length,
    structure.nodes.length,
    visible.edgeIds.size,
  ]);

  const centerNode = useCallback(
    (nodeId: string, scale = session.viewport.scale): void => {
      const point = session.positions[nodeId];
      const element = viewportRef.current;
      if (!point || !element) return;
      setSession((current) => ({
        ...current,
        viewport: {
          x: element.clientWidth / 2 - (point.x + STRUCTURE_NODE_WIDTH / 2) * scale,
          y: element.clientHeight / 2 - (point.y + STRUCTURE_NODE_HEIGHT / 2) * scale,
          scale,
        },
      }));
    },
    [session.positions, session.viewport.scale],
  );

  useLayoutEffect(() => {
    if (cachedAtMount.current || !session.focusedNodeId) return;
    cachedAtMount.current = true;
    centerNode(session.focusedNodeId, 1);
  }, [centerNode, session.focusedNodeId]);

  const fitVisible = useCallback((): void => {
    const element = viewportRef.current;
    const bounds = structureLayoutBounds(visible.nodeIds, session.positions);
    if (!element || !bounds) return;
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const scale = clampScale(
      Math.min((element.clientWidth - 100) / width, (element.clientHeight - 100) / height, 1.3),
    );
    setSession((current) => ({
      ...current,
      viewport: {
        x: (element.clientWidth - width * scale) / 2 - bounds.minX * scale,
        y: (element.clientHeight - height * scale) / 2 - bounds.minY * scale,
        scale,
      },
    }));
  }, [session.positions, visible.nodeIds]);

  const focusNode = useCallback(
    (nodeId: string, center = false): void => {
      setSession((current) => ({
        ...current,
        focusedNodeId: nodeId,
        selectedEdgeId: null,
        focusTrail: [
          ...current.focusTrail.filter((candidate) => candidate !== nodeId),
          nodeId,
        ].slice(-6),
      }));
      if (center) window.requestAnimationFrame(() => centerNode(nodeId));
    },
    [centerNode],
  );

  const openSource = useCallback(
    (anchor: SourceAnchor, openInRightPane: boolean): void => {
      setSourceNotice(null);
      void onOpenSource(sourceOid, anchor, openInRightPane).then((notice) => {
        if (!notice) return;
        setSourceNotice(notice);
        window.setTimeout(() => setSourceNotice(null), 3_000);
      });
    },
    [onOpenSource, sourceOid],
  );

  const zoomAt = useCallback((scale: number, clientX?: number, clientY?: number): void => {
    const element = viewportRef.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    const localX = (clientX ?? bounds.left + bounds.width / 2) - bounds.left;
    const localY = (clientY ?? bounds.top + bounds.height / 2) - bounds.top;
    setSession((current) => {
      const nextScale = clampScale(scale);
      const worldX = (localX - current.viewport.x) / current.viewport.scale;
      const worldY = (localY - current.viewport.y) / current.viewport.scale;
      return {
        ...current,
        viewport: {
          x: localX - worldX * nextScale,
          y: localY - worldY * nextScale,
          scale: nextScale,
        },
      };
    });
  }, []);

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    zoomAt(session.viewport.scale * factor, event.clientX, event.clientY);
  };

  const handleBackgroundPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewport: session.viewport,
    };
  };

  const handleBackgroundPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    setSession((current) => ({
      ...current,
      viewport: {
        ...pan.viewport,
        x: pan.viewport.x + event.clientX - pan.startX,
        y: pan.viewport.y + event.clientY - pan.startY,
      },
    }));
  };

  const endBackgroundPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const startNodeDrag = (event: ReactPointerEvent<HTMLButtonElement>, nodeId: string): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const point = session.positions[nodeId];
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    nodeDragRef.current = {
      pointerId: event.pointerId,
      nodeId,
      startX: event.clientX,
      startY: event.clientY,
      point,
      moved: false,
    };
  };

  const moveNode = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = (event.clientX - drag.startX) / session.viewport.scale;
    const dy = (event.clientY - drag.startY) / session.viewport.scale;
    drag.moved ||= Math.hypot(dx, dy) > 3;
    setSession((current) => ({
      ...current,
      positions: {
        ...current.positions,
        [drag.nodeId]: { x: drag.point.x + dx, y: drag.point.y + dy },
      },
    }));
  };

  const endNodeDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    nodeDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) focusNode(drag.nodeId);
  };

  const toggleCurrentValue = (): void => {
    if (!fixture.updatedStructure) return;
    setSession((current) => {
      const updated = !current.updated;
      const nextStructure = updated ? fixture.updatedStructure! : fixture.structure;
      const focusedNodeId = nextStructure.nodes.some((node) => node.id === current.focusedNodeId)
        ? current.focusedNodeId
        : (nextStructure.initialFocus ?? nextStructure.nodes[0]?.id ?? null);
      return {
        ...current,
        updated,
        focusedNodeId,
        selectedEdgeId: null,
        positions: reconcileStructureLayout(nextStructure, current.positions),
      };
    });
  };

  const relations = focusedNode ? incidentStructureEdges(structure, focusedNode.id) : [];
  const selectedEdge = session.selectedEdgeId
    ? structure.edges.find((edge) => edge.id === session.selectedEdgeId)
    : undefined;

  return (
    <article
      className="structure-viewer"
      data-structure-id={structure.id}
      data-visible-node-count={visible.nodeIds.size}
      data-total-node-count={structure.nodes.length}
      data-visible-edge-count={visible.edgeIds.size}
      data-total-edge-count={structure.edges.length}
      data-rendered-node-count={canvasNodes.length}
      data-rendered-edge-count={canvasEdges.length}
      data-viewport-scale={session.viewport.scale.toFixed(3)}
      data-current-value={session.updated ? "updated" : "baseline"}
      data-last-render-ms={lastRenderMilliseconds.toFixed(2)}
    >
      <header className="structure-header">
        <div>
          <div className="structure-eyebrow">
            <span>Structure</span>
            <strong>Phase 0 UX Spike</strong>
            <span>{categoryLabel(fixture.category)}</span>
          </div>
          <h2>{structure.title}</h2>
          <p>{structure.scope}</p>
        </div>
        <div className="structure-claim-note">
          Producerのclaim · source anchorは確認可能にするだけで、意味的正しさを保証しません。
        </div>
      </header>
      <div className="structure-toolbar" aria-label="Structure表示操作">
        <div className="structure-toolbar-group">
          <span>近傍</span>
          {([1, 2, "all"] as const).map((depth) => (
            <button
              type="button"
              key={depth}
              className={session.depth === depth ? "active" : ""}
              aria-pressed={session.depth === depth}
              onClick={() => setSession((current) => ({ ...current, depth }))}
            >
              {depth === "all" ? "全体" : `${depth}-hop`}
            </button>
          ))}
        </div>
        <div className="structure-toolbar-group">
          <button
            type="button"
            aria-label="縮小"
            onClick={() => zoomAt(session.viewport.scale / 1.2)}
          >
            −
          </button>
          <span>{Math.round(session.viewport.scale * 100)}%</span>
          <button
            type="button"
            aria-label="拡大"
            onClick={() => zoomAt(session.viewport.scale * 1.2)}
          >
            +
          </button>
          <button type="button" onClick={fitVisible}>
            表示中を収める
          </button>
          {session.focusedNodeId && (
            <button type="button" onClick={() => centerNode(session.focusedNodeId!)}>
              focusを中央へ
            </button>
          )}
        </div>
        <div className="structure-toolbar-group structure-toolbar-group--end">
          <button
            type="button"
            className={session.inspectorOpen ? "active" : ""}
            aria-expanded={session.inspectorOpen}
            aria-controls="structure-inspector"
            onClick={() =>
              setSession((current) => ({ ...current, inspectorOpen: !current.inspectorOpen }))
            }
          >
            {session.inspectorOpen ? "詳細サイドバーを隠す" : "詳細サイドバーを表示"}
          </button>
          {fixture.updatedStructure && (
            <button type="button" onClick={toggleCurrentValue}>
              {session.updated ? "基準値へ戻す" : "current value更新を再現"}
            </button>
          )}
          {fixture.walkthroughMermaid && (
            <button
              type="button"
              onClick={() =>
                setSession((current) => ({ ...current, comparisonOpen: !current.comparisonOpen }))
              }
            >
              Walkthrough Mermaidと比較
            </button>
          )}
        </div>
      </div>
      {sourceNotice && (
        <div className="structure-source-notice" role="status">
          {sourceNotice}
        </div>
      )}
      <div className={`structure-body${session.inspectorOpen ? " inspector-open" : ""}`}>
        <section className="structure-canvas-shell" aria-label={`${structure.title} グラフ`}>
          <div
            ref={viewportRef}
            className="structure-canvas"
            onWheel={handleWheel}
            onPointerDown={handleBackgroundPointerDown}
            onPointerMove={handleBackgroundPointerMove}
            onPointerUp={endBackgroundPointer}
            onPointerCancel={endBackgroundPointer}
            onDoubleClick={(event) => {
              if (event.target === event.currentTarget) fitVisible();
            }}
          >
            <div
              className="structure-world"
              style={{
                transform: `translate(${session.viewport.x}px, ${session.viewport.y}px) scale(${session.viewport.scale})`,
              }}
            >
              <svg className="structure-edges" aria-hidden="true">
                <defs>
                  <marker
                    id={markerId}
                    markerWidth="8"
                    markerHeight="8"
                    refX="7"
                    refY="4"
                    orient="auto"
                  >
                    <path d="M0,0 L8,4 L0,8 Z" />
                  </marker>
                </defs>
                {canvasEdges.map((edge) => {
                  const geometry = edgePath(
                    edge,
                    session.positions,
                    edgeRouteOffsets.get(edge.id) ?? 0,
                  );
                  if (!geometry) return null;
                  const connected = incidentIds.has(edge.id);
                  const selected = edge.id === session.selectedEdgeId;
                  return (
                    <path
                      key={edge.id}
                      d={geometry.path}
                      data-edge-id={edge.id}
                      data-from-node-id={edge.from}
                      data-to-node-id={edge.to}
                      className={`${connected ? "connected" : ""}${selected ? " selected" : ""}`}
                      markerEnd={edge.directed ? `url(#${markerId})` : undefined}
                    />
                  );
                })}
              </svg>
              {edgeLabelPlacements.map(({ edge, x, y, selectWidth, height, crowded }) => {
                const anchor = edge.anchors?.[0];
                const sourceChangeKind = anchor ? sourceChangeKinds.get(anchor.path) : undefined;
                return (
                  <div
                    key={edge.id}
                    className={`structure-edge-label${incidentIds.has(edge.id) ? " connected" : ""}${session.selectedEdgeId === edge.id ? " selected" : ""}${crowded ? " crowded" : ""}`}
                    style={{ left: x, top: y, minHeight: height }}
                    data-edge-id={edge.id}
                    data-source-change-kind={sourceChangeKind}
                  >
                    <button
                      type="button"
                      className="structure-edge-select"
                      title={edge.label}
                      style={{ width: selectWidth }}
                      onClick={() =>
                        setSession((current) => ({
                          ...current,
                          selectedEdgeId: current.selectedEdgeId === edge.id ? null : edge.id,
                        }))
                      }
                    >
                      {anchor && <SourceIdentity anchor={anchor} changeKind={sourceChangeKind} />}
                      <span className="structure-edge-label-text">{edge.label}</span>
                    </button>
                    {anchor && <SourceButton anchor={anchor} compact onOpen={openSource} />}
                  </div>
                );
              })}
              {canvasNodes.map((node) => {
                const point = session.positions[node.id];
                if (!point) return null;
                const focused = node.id === session.focusedNodeId;
                const neighbor = relations.some(
                  (edge) => edge.from === node.id || edge.to === node.id,
                );
                const sourceChangeKind = node.anchor
                  ? sourceChangeKinds.get(node.anchor.path)
                  : undefined;
                return (
                  <div
                    key={node.id}
                    className={`structure-node notation-${node.notation ?? "plain"}${focused ? " focused" : ""}${neighbor && !focused ? " neighbor" : ""}`}
                    style={{ left: point.x, top: point.y }}
                    data-node-id={node.id}
                    data-node-notation={node.notation ?? "plain"}
                    data-node-position={`${point.x.toFixed(2)},${point.y.toFixed(2)}`}
                    data-source-change-kind={sourceChangeKind}
                  >
                    <button
                      type="button"
                      className="structure-node-select"
                      aria-pressed={focused}
                      onPointerDown={(event) => startNodeDrag(event, node.id)}
                      onPointerMove={moveNode}
                      onPointerUp={endNodeDrag}
                      onPointerCancel={endNodeDrag}
                      onClick={(event) => {
                        if (event.detail === 0) focusNode(node.id);
                      }}
                    >
                      {node.kind && <small>{node.kind}</small>}
                      <strong className="structure-node-title">
                        {node.anchor && (
                          <SourceIdentity anchor={node.anchor} changeKind={sourceChangeKind} />
                        )}
                        <span className="structure-node-title-text">
                          <BreakableStructureLabel label={node.label} />
                        </span>
                      </strong>
                      <span className="structure-node-description">
                        {node.description ?? "Producerによる説明なし"}
                      </span>
                    </button>
                    {node.anchor && (
                      <SourceButton anchor={node.anchor} compact onOpen={openSource} />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="structure-canvas-status">
              <strong>{focusedNode?.label ?? "focusなし"}</strong>
              <span>
                {visible.nodeIds.size}/{structure.nodes.length} Node · {visible.edgeIds.size}/
                {structure.edges.length} Relation
              </span>
            </div>
            <StructureMiniMap
              structure={structure}
              positions={session.positions}
              focusedNodeId={session.focusedNodeId}
              viewport={session.viewport}
              viewportElement={viewportRef.current}
            />
          </div>
        </section>
        {session.inspectorOpen && (
          <aside
            id="structure-inspector"
            className="structure-inspector"
            aria-label="focus中のStructure claim"
          >
            {focusedNode ? (
              <>
                <div className="structure-inspector-heading">
                  <span>focus中のNode</span>
                  {focusedNode.kind && <code>{focusedNode.kind}</code>}
                </div>
                <h3>{focusedNode.label}</h3>
                <p>{focusedNode.description ?? "このclaimにはProducerによる説明がありません。"}</p>
                {focusedNode.anchor ? (
                  <SourceButton anchor={focusedNode.anchor} onOpen={openSource} />
                ) : (
                  <span className="structure-unanchored">source anchorなし</span>
                )}
                <div className="structure-focus-trail" aria-label="focus履歴">
                  <span>focus履歴</span>
                  <div>
                    {session.focusTrail.map((nodeId) => {
                      const trailNode = nodeById(structure, nodeId);
                      return trailNode ? (
                        <button type="button" key={nodeId} onClick={() => focusNode(nodeId, true)}>
                          {trailNode.label}
                        </button>
                      ) : null;
                    })}
                  </div>
                </div>
                <div className="structure-relations-heading">
                  <strong>Relation</strong>
                  <span>{relations.length}</span>
                </div>
                {visible.hiddenRelationCount > 0 ? (
                  <button
                    type="button"
                    className="structure-collapse-control"
                    onClick={() =>
                      setSession((current) => ({
                        ...current,
                        expandedNodeIds: new Set(current.expandedNodeIds).add(focusedNode.id),
                      }))
                    }
                  >
                    折りたたまれたRelation {visible.hiddenRelationCount}件を展開
                    <small>入力順 · 方向ごとに先頭4件</small>
                  </button>
                ) : relations.length > 12 && focusedExpanded ? (
                  <button
                    type="button"
                    className="structure-collapse-control"
                    onClick={() =>
                      setSession((current) => {
                        const expandedNodeIds = new Set(current.expandedNodeIds);
                        expandedNodeIds.delete(focusedNode.id);
                        return { ...current, expandedNodeIds };
                      })
                    }
                  >
                    Relationを折りたたむ
                    <small>可逆・安定・内容に非依存</small>
                  </button>
                ) : null}
                <div className="structure-relation-list">
                  {relations.map((edge) => {
                    const neighborId = edge.from === focusedNode.id ? edge.to : edge.from;
                    const neighborNode = nodeById(structure, neighborId);
                    const hidden = !visible.edgeIds.has(edge.id);
                    return (
                      <article
                        key={edge.id}
                        className={`${session.selectedEdgeId === edge.id ? "selected" : ""}${hidden ? " hidden-relation" : ""}`}
                      >
                        <button
                          type="button"
                          className="structure-relation-focus"
                          disabled={!neighborNode}
                          onClick={() => neighborNode && focusNode(neighborNode.id, true)}
                        >
                          <small>{relationDirection(edge, focusedNode.id)}</small>
                          <strong>{edge.label}</strong>
                          <span>{neighborNode?.label ?? neighborId}</span>
                        </button>
                        {hidden && <em>折りたたみ中</em>}
                        {edge.anchors?.map((anchor) => (
                          <SourceButton
                            key={lineLabel(anchor)}
                            anchor={anchor}
                            compact
                            onOpen={openSource}
                          />
                        ))}
                      </article>
                    );
                  })}
                </div>
              </>
            ) : (
              <p>Nodeを選択して、claimと周辺relationを確認してください。</p>
            )}
            {selectedEdge && (
              <div className="structure-selected-edge">
                <span>選択中のRelation</span>
                <strong>{selectedEdge.label}</strong>
                <code>
                  {selectedEdge.from} {selectedEdge.directed ? "→" : "—"} {selectedEdge.to}
                </code>
              </div>
            )}
          </aside>
        )}
      </div>
      {session.comparisonOpen && fixture.walkthroughMermaid && (
        <div className="structure-comparison-backdrop">
          <section
            className="structure-comparison"
            role="dialog"
            aria-label="Walkthrough Mermaid比較"
          >
            <header>
              <div>
                <span>同じ主題 · Walkthrough Mermaidでの表現</span>
                <strong>Authorが構成した図を読む比較surface</strong>
              </div>
              <button
                type="button"
                onClick={() => setSession((current) => ({ ...current, comparisonOpen: false }))}
              >
                閉じる
              </button>
            </header>
            <p>
              図全体の構成は読めますが、任意Nodeからのfocus履歴、段階的な近傍探索、折りたたみ、
              セッション内のlayout continuityはありません。
            </p>
            <MermaidSurface
              className="structure-comparison-mermaid"
              source={fixture.walkthroughMermaid}
              themePreference={themePreference}
              renderIdPrefix="rvwStructureComparison"
              errorClassName="structure-comparison-error"
            />
          </section>
        </div>
      )}
    </article>
  );
}

export function StructureViewer(props: StructureViewerProps) {
  // The workspace reuses the same reading-surface slot while tabs change.
  // Keep each fixture's ephemeral exploration state isolated by its stable session key.
  return <StructureViewerSessionSurface key={props.sessionKey} {...props} />;
}
