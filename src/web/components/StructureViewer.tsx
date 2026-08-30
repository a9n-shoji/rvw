import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { changedFilePath } from "../../domain/changed-file.js";
import type {
  ChangedFile,
  ChangeKind,
  SourceAnchor,
  Structure,
  StructureEdge,
  StructureNode,
} from "../../domain/models.js";
import { api, type DeleteStructureResponse } from "../api.js";
import {
  incidentStructureEdges,
  initialStructureLayout,
  reconcileStructureLayout,
  STRUCTURE_NODE_HEIGHT,
  STRUCTURE_NODE_WIDTH,
  structureEdgeRouteOffsets,
  structureLayoutBounds,
  visibleStructureGraph,
  type StructureNeighborhoodDepth,
  type StructurePoint,
} from "../structure-graph.js";
import { ChangeIcon } from "./FileTree.js";
import { FileEntryIcon } from "./FileIcon.js";

interface StructureViewport {
  x: number;
  y: number;
  scale: number;
}

interface StructureSession {
  focusId: string | null;
  depth: StructureNeighborhoodDepth;
  expanded: boolean;
  focusTrail: string[];
  detailsOpen: boolean;
  positions: Record<string, StructurePoint>;
  viewport: StructureViewport;
  surfaceSize: { width: number; height: number };
  updatedAt: string;
}

const sessions = new Map<string, StructureSession>();

function initialSession(structure: Structure): StructureSession {
  const focusId =
    structure.initialFocus && structure.nodes.some((node) => node.id === structure.initialFocus)
      ? structure.initialFocus
      : null;
  return {
    focusId,
    depth: focusId ? 1 : "all",
    expanded: false,
    focusTrail: focusId ? [focusId] : [],
    detailsOpen: false,
    positions: initialStructureLayout(structure),
    viewport: { x: 110, y: 90, scale: 1 },
    surfaceSize: { width: 0, height: 0 },
    updatedAt: structure.updatedAt,
  };
}

function anchorLabel(anchor: SourceAnchor): string {
  return anchor.startLine === null
    ? anchor.path
    : `${anchor.path}:${anchor.startLine}${anchor.endLine === anchor.startLine ? "" : `-${anchor.endLine}`}`;
}

function SourceButton({
  anchor,
  compact = false,
  relatedAnchorCount = 0,
  onOpen,
}: {
  anchor: SourceAnchor;
  compact?: boolean;
  relatedAnchorCount?: number;
  onOpen: (openInRightPane: boolean) => void;
}) {
  const label = `${anchorLabel(anchor)}を開く${relatedAnchorCount > 0 ? `（ほか${relatedAnchorCount}件は詳細サイドバー）` : ""}`;
  return (
    <button
      type="button"
      className={`structure-source${compact ? " compact" : ""}`}
      title={label}
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(event.metaKey || event.ctrlKey);
      }}
    >
      <span aria-hidden="true">&lt;/&gt;</span>
      {!compact && <span>{anchorLabel(anchor)}</span>}
    </button>
  );
}

function SourceIdentity({
  anchor,
  changeKind,
}: {
  anchor: SourceAnchor;
  changeKind: ChangeKind | null;
}) {
  return (
    <span
      className="structure-source-identity"
      data-source-path={anchor.path}
      data-source-change-kind={changeKind ?? undefined}
      title={anchor.path}
    >
      <FileEntryIcon path={anchor.path} kind="file" />
      {changeKind && <ChangeIcon kind={changeKind} />}
    </span>
  );
}

type EdgeSourceChangeKind = ChangeKind | "mixed";

interface EdgeSourcePresentation {
  anchor: SourceAnchor | null;
  anchorCount: number;
  additionalAnchorCount: number;
  changeKind: EdgeSourceChangeKind | null;
  changedAnchorCount: number;
  title: string;
}

function edgeSourcePresentation(
  edge: StructureEdge,
  sourceChangeKinds: ReadonlyMap<string, ChangeKind>,
): EdgeSourcePresentation {
  const changedKinds = edge.anchors.flatMap((anchor) => {
    const kind = sourceChangeKinds.get(anchor.path);
    return kind ? [kind] : [];
  });
  const distinctKinds = [...new Set(changedKinds)].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  return {
    anchor: edge.anchors[0] ?? null,
    anchorCount: edge.anchors.length,
    additionalAnchorCount: Math.max(0, edge.anchors.length - 1),
    changeKind:
      distinctKinds.length > 1 ? "mixed" : distinctKinds.length === 1 ? distinctKinds[0]! : null,
    changedAnchorCount: changedKinds.length,
    title: edge.anchors.map(anchorLabel).join("\n"),
  };
}

function EdgeSourceIdentity({ presentation }: { presentation: EdgeSourcePresentation }) {
  const { anchor, additionalAnchorCount, changeKind, changedAnchorCount, title } = presentation;
  if (!anchor) return null;
  return (
    <span
      className="structure-source-identity"
      data-source-path={anchor.path}
      data-source-anchor-count={presentation.anchorCount}
      data-source-change-kind={changeKind ?? undefined}
      title={title}
    >
      <FileEntryIcon path={anchor.path} kind="file" />
      {additionalAnchorCount > 0 && changedAnchorCount > 0 ? (
        <span
          className="structure-source-change-aggregate"
          role="img"
          aria-label={`変更対象のsource ${changedAnchorCount}件${changeKind === "mixed" ? "（複数種別）" : ""}`}
        >
          Δ{changedAnchorCount}
        </span>
      ) : (
        changeKind && changeKind !== "mixed" && <ChangeIcon kind={changeKind} />
      )}
      {additionalAnchorCount > 0 && (
        <span className="structure-source-count" aria-label={`ほか${additionalAnchorCount}件`}>
          +{additionalAnchorCount}
        </span>
      )}
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

function edgePath(
  edge: StructureEdge,
  positions: Readonly<Record<string, StructurePoint>>,
  laneOffset = 0,
): {
  path: string;
  labelX: number;
  labelY: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
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
    const loopShift = laneOffset * 0.3;
    const loopReach = 88 + Math.abs(laneOffset) * 0.35;
    return {
      path: `M ${right + gap} ${top + 34 + loopShift} C ${right + loopReach} ${top - 84 + loopShift}, ${right + loopReach} ${top + STRUCTURE_NODE_HEIGHT + 84 + loopShift}, ${right + gap} ${top + STRUCTURE_NODE_HEIGHT - 34 + loopShift}`,
      labelX: right + 52 + Math.abs(laneOffset) * 0.28,
      labelY: top - 4 + loopShift,
      fromX,
      fromY,
      toX,
      toY,
      startX: right + gap,
      startY: top + 34 + loopShift,
      endX: right + gap,
      endY: top + STRUCTURE_NODE_HEIGHT - 34 + loopShift,
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
  const endpointDistance = boundaryDistance + 8;
  const startX = fromX + unitX * endpointDistance + perpendicularX * laneOffset;
  const startY = fromY + unitY * endpointDistance + perpendicularY * laneOffset;
  const endX = toX - unitX * endpointDistance + perpendicularX * laneOffset;
  const endY = toY - unitY * endpointDistance + perpendicularY * laneOffset;
  // Every ordinary relation keeps a gentle curve. Stable lane offsets separate
  // parallel relations, while reversing an edge naturally bends it to the other side.
  const curve = Math.min(72, Math.max(28, length * 0.1)) + laneOffset * 0.45;
  const control1X = startX + (endX - startX) * 0.36 + perpendicularX * curve;
  const control1Y = startY + (endY - startY) * 0.36 + perpendicularY * curve;
  const control2X = startX + (endX - startX) * 0.64 + perpendicularX * curve;
  const control2Y = startY + (endY - startY) * 0.64 + perpendicularY * curve;
  return {
    path: `M ${startX} ${startY} C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${endX} ${endY}`,
    labelX: (startX + endX) / 2 + perpendicularX * curve * 0.75,
    labelY: (startY + endY) / 2 + perpendicularY * curve * 0.75,
    fromX: fromX + perpendicularX * laneOffset,
    fromY: fromY + perpendicularY * laneOffset,
    toX: toX + perpendicularX * laneOffset,
    toY: toY + perpendicularY * laneOffset,
    startX,
    startY,
    endX,
    endY,
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
  source: EdgeSourcePresentation;
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
const EDGE_LABEL_AGGREGATE_CHANGE_WIDTH = 24;
const EDGE_LABEL_SOURCE_COUNT_WIDTH = 25;
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
  source: EdgeSourcePresentation;
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
  const source = edgeSourcePresentation(edge, sourceChangeKinds);
  const sourceIdentityWidth = source.anchor
    ? EDGE_LABEL_FILE_ICON_WIDTH +
      (source.additionalAnchorCount > 0 && source.changedAnchorCount > 0
        ? EDGE_LABEL_AGGREGATE_CHANGE_WIDTH
        : source.changeKind
          ? EDGE_LABEL_CHANGE_ICON_WIDTH
          : 0) +
      (source.additionalAnchorCount > 0 ? EDGE_LABEL_SOURCE_COUNT_WIDTH : 0)
    : 0;
  const selectWidth = textWidth + sourceIdentityWidth;
  return {
    selectWidth,
    boxWidth: selectWidth + (source.anchor ? EDGE_LABEL_SOURCE_WIDTH : 0),
    height,
    source,
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
  const collisionCellSize = 128;
  const collisionCellLimit = 48;
  const occupiedLabels = new Map<string, { boxes: StructureBox[]; saturated: boolean }>();
  const cellKeys = (box: StructureBox): string[] => {
    const keys: string[] = [];
    const left = Math.floor(box.left / collisionCellSize);
    const right = Math.floor(box.right / collisionCellSize);
    const top = Math.floor(box.top / collisionCellSize);
    const bottom = Math.floor(box.bottom / collisionCellSize);
    for (let x = left; x <= right; x += 1) {
      for (let y = top; y <= bottom; y += 1) keys.push(`${x}:${y}`);
    }
    return keys;
  };
  const overlapsOccupiedLabel = (box: StructureBox): boolean => {
    const seen = new Set<StructureBox>();
    for (const key of cellKeys(box)) {
      const cell = occupiedLabels.get(key);
      if (!cell) continue;
      if (cell.saturated) return true;
      for (const occupied of cell.boxes) {
        if (seen.has(occupied)) continue;
        seen.add(occupied);
        if (boxesOverlap(box, occupied)) return true;
      }
    }
    return false;
  };
  const occupyLabel = (box: StructureBox): void => {
    for (const key of cellKeys(box)) {
      const cell = occupiedLabels.get(key) ?? { boxes: [], saturated: false };
      if (!cell.saturated) {
        cell.boxes.push(box);
        if (cell.boxes.length >= collisionCellLimit) {
          cell.boxes = [];
          cell.saturated = true;
        }
      }
      occupiedLabels.set(key, cell);
    }
  };
  const placements: StructureEdgeLabelPlacement[] = [];
  const candidateFractions = [0.5, 0.38, 0.62, 0.26, 0.74] as const;
  const candidateOffsets = [0, 48, -48, 96, -96, 144, -144, 204, -204, 276, -276] as const;
  const candidates = candidateOffsets.flatMap((offset) =>
    candidateFractions.map((fraction) => [fraction, offset] as const),
  );

  const stableEdges = [...edges].sort((left, right) => left.id.localeCompare(right.id, "en"));
  for (const [edgeIndex, edge] of stableEdges.entries()) {
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
      return !overlapsOccupiedLabel(box);
    });
    const fallback = nodeSafe.length > 0 ? nodeSafe[edgeIndex % nodeSafe.length] : undefined;
    const chosen = available ?? fallback ?? possible[edgeIndex % possible.length]!;
    occupyLabel(labelBox(chosen.x, chosen.y, size.boxWidth, size.height, 4));
    placements.push({
      edge,
      source: size.source,
      x: chosen.x,
      y: chosen.y,
      selectWidth: size.selectWidth,
      height: size.height,
      crowded: !available,
    });
  }
  return placements;
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

export function StructureViewer({
  pullRequestId,
  structure,
  changedFiles,
  onOpenAnchor,
  onDeleted,
}: {
  pullRequestId: string;
  structure: Structure;
  changedFiles: readonly ChangedFile[];
  onOpenAnchor: (anchor: SourceAnchor, openInRightPane: boolean) => Promise<string | null>;
  onDeleted: () => void;
}) {
  const cachedSession = sessions.get(structure.id);
  const initial = cachedSession ?? initialSession(structure);
  const [focusId, setFocusId] = useState(initial.focusId);
  const [depth, setDepth] = useState<StructureNeighborhoodDepth>(initial.depth);
  const [expanded, setExpanded] = useState(initial.expanded);
  const [focusTrail, setFocusTrail] = useState(initial.focusTrail);
  const [detailsOpen, setDetailsOpen] = useState(initial.detailsOpen);
  const [positions, setPositions] = useState(initial.positions);
  const [viewport, setViewport] = useState(initial.viewport);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const [status, setStatus] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const surfaceSizeRef = useRef(initial.surfaceSize);
  const focusIdRef = useRef(focusId);
  const positionsRef = useRef(positions);
  const initialCenterPendingRef = useRef(!cachedSession && initial.focusId !== null);
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    nodeId: string;
    x: number;
    y: number;
    distance: number;
  } | null>(null);
  focusIdRef.current = focusId;
  positionsRef.current = positions;

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const update = (): void => {
      const next = { width: surface.clientWidth, height: surface.clientHeight };
      if (next.width === 0 || next.height === 0) return;
      const previous = surfaceSizeRef.current;
      surfaceSizeRef.current = next;
      setSurfaceSize(next);
      if (previous.width === 0 || previous.height === 0) return;
      setViewport((current) => {
        const resized = {
          ...current,
          x: current.x + (next.width - previous.width) / 2,
          y: current.y + (next.height - previous.height) / 2,
        };
        const focusedPoint = focusIdRef.current
          ? positionsRef.current[focusIdRef.current]
          : undefined;
        if (!focusedPoint) return resized;
        const padding = 12;
        const nodeWidth = STRUCTURE_NODE_WIDTH * resized.scale;
        const nodeHeight = STRUCTURE_NODE_HEIGHT * resized.scale;
        const nodeLeft = resized.x + focusedPoint.x * resized.scale;
        const nodeTop = resized.y + focusedPoint.y * resized.scale;
        if (nodeWidth > next.width - padding * 2) {
          resized.x = next.width / 2 - (focusedPoint.x + STRUCTURE_NODE_WIDTH / 2) * resized.scale;
        } else if (nodeLeft < padding) {
          resized.x += padding - nodeLeft;
        } else if (nodeLeft + nodeWidth > next.width - padding) {
          resized.x -= nodeLeft + nodeWidth - (next.width - padding);
        }
        if (nodeHeight > next.height - padding * 2) {
          resized.y =
            next.height / 2 - (focusedPoint.y + STRUCTURE_NODE_HEIGHT / 2) * resized.scale;
        } else if (nodeTop < padding) {
          resized.y += padding - nodeTop;
        } else if (nodeTop + nodeHeight > next.height - padding) {
          resized.y -= nodeTop + nodeHeight - (next.height - padding);
        }
        return resized;
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const previous = sessions.get(structure.id);
    if (previous?.updatedAt === structure.updatedAt) return;
    setPositions((current) => reconcileStructureLayout(structure, current));
    const fallbackFocus = structure.initialFocus ?? null;
    const retainedFocus =
      focusIdRef.current && structure.nodes.some((node) => node.id === focusIdRef.current)
        ? focusIdRef.current
        : null;
    const nextFocus = retainedFocus ?? fallbackFocus;
    setFocusId(nextFocus);
    if (nextFocus === null) {
      setDepth("all");
      setExpanded(false);
    }
    setFocusTrail((current) => {
      const retained = current.filter((nodeId) =>
        structure.nodes.some((node) => node.id === nodeId),
      );
      return nextFocus && !retained.includes(nextFocus)
        ? [...retained, nextFocus].slice(-6)
        : retained;
    });
  }, [structure, structure.updatedAt]);

  useEffect(() => {
    sessions.set(structure.id, {
      focusId,
      depth,
      expanded,
      focusTrail,
      detailsOpen,
      positions,
      viewport,
      surfaceSize: surfaceSizeRef.current,
      updatedAt: structure.updatedAt,
    });
  }, [
    depth,
    detailsOpen,
    expanded,
    focusId,
    focusTrail,
    positions,
    structure.id,
    structure.updatedAt,
    viewport,
  ]);

  useLayoutEffect(() => {
    if (
      !initialCenterPendingRef.current ||
      !focusId ||
      surfaceSize.width === 0 ||
      surfaceSize.height === 0
    ) {
      return;
    }
    const point = positions[focusId];
    if (!point) return;
    initialCenterPendingRef.current = false;
    setViewport({
      scale: 1,
      x: surfaceSize.width / 2 - (point.x + STRUCTURE_NODE_WIDTH / 2),
      y: surfaceSize.height / 2 - (point.y + STRUCTURE_NODE_HEIGHT / 2),
    });
  }, [focusId, positions, surfaceSize]);

  const visible = useMemo(
    () => visibleStructureGraph(structure, focusId, depth, expanded),
    [depth, expanded, focusId, structure],
  );
  const nodesById = useMemo(
    () => new Map(structure.nodes.map((node) => [node.id, node])),
    [structure.nodes],
  );
  const focusedNode = focusId ? (nodesById.get(focusId) ?? null) : null;
  const incident = useMemo(
    () => (focusId ? incidentStructureEdges(structure, focusId) : []),
    [focusId, structure],
  );
  const routeOffsets = useMemo(() => structureEdgeRouteOffsets(structure.edges), [structure.edges]);
  const sourceChangeKinds = useMemo(() => {
    const result = new Map<string, ChangeKind>();
    for (const change of changedFiles) {
      const path = changedFilePath(change);
      if (path) result.set(path, change.kind);
      if (change.oldPath) result.set(change.oldPath, change.kind);
      if (change.newPath) result.set(change.newPath, change.kind);
    }
    return result;
  }, [changedFiles]);
  const bounds = useMemo(
    () => structureLayoutBounds(visible.nodeIds, positions),
    [positions, visible.nodeIds],
  );
  const renderNodeIds = useMemo(() => {
    if (visible.nodeIds.size <= 100 || surfaceSize.width === 0) return visible.nodeIds;
    const overscan = 480;
    const minX = -viewport.x / viewport.scale - overscan;
    const minY = -viewport.y / viewport.scale - overscan;
    const maxX = (surfaceSize.width - viewport.x) / viewport.scale + overscan;
    const maxY = (surfaceSize.height - viewport.y) / viewport.scale + overscan;
    return new Set(
      [...visible.nodeIds].filter((nodeId) => {
        if (nodeId === focusId) return true;
        const point = positions[nodeId];
        return (
          point &&
          point.x + STRUCTURE_NODE_WIDTH >= minX &&
          point.x <= maxX &&
          point.y + STRUCTURE_NODE_HEIGHT >= minY &&
          point.y <= maxY
        );
      }),
    );
  }, [focusId, positions, surfaceSize, viewport, visible.nodeIds]);
  const renderedEdges = useMemo(
    () =>
      structure.edges.filter(
        (edge) =>
          visible.edgeIds.has(edge.id) &&
          renderNodeIds.has(edge.from) &&
          renderNodeIds.has(edge.to),
      ),
    [renderNodeIds, structure.edges, visible.edgeIds],
  );
  const renderedNodes = useMemo(
    () => structure.nodes.filter((node) => renderNodeIds.has(node.id)),
    [renderNodeIds, structure.nodes],
  );
  const focusedRenderedEdges = useMemo(
    () => renderedEdges.filter((edge) => edge.from === focusId || edge.to === focusId),
    [focusId, renderedEdges],
  );
  const edgeLabelPlacements = useMemo(
    () =>
      placeEdgeLabels(
        focusedRenderedEdges,
        renderedNodes,
        positions,
        sourceChangeKinds,
        routeOffsets,
      ),
    [focusedRenderedEdges, positions, renderedNodes, routeOffsets, sourceChangeKinds],
  );
  const worldWidth = Math.max(1_200, (bounds?.maxX ?? 1_000) + 180);
  const worldHeight = Math.max(800, (bounds?.maxY ?? 600) + 180);

  const fitVisible = (): void => {
    if (!bounds || surfaceSize.width === 0 || surfaceSize.height === 0) return;
    const padding = 72;
    const scale = Math.min(
      1.25,
      Math.max(
        0.18,
        Math.min(
          (surfaceSize.width - padding * 2) / Math.max(1, bounds.maxX - bounds.minX),
          (surfaceSize.height - padding * 2) / Math.max(1, bounds.maxY - bounds.minY),
        ),
      ),
    );
    setViewport({
      scale,
      x: padding - bounds.minX * scale,
      y: padding - bounds.minY * scale,
    });
  };

  const centerNode = (nodeId: string, scale?: number): void => {
    const point = positions[nodeId];
    if (!point) return;
    setViewport((current) => ({
      scale: scale ?? current.scale,
      x: surfaceSize.width / 2 - (point.x + STRUCTURE_NODE_WIDTH / 2) * (scale ?? current.scale),
      y: surfaceSize.height / 2 - (point.y + STRUCTURE_NODE_HEIGHT / 2) * (scale ?? current.scale),
    }));
  };

  const centerFocus = (): void => {
    if (focusId) centerNode(focusId);
  };

  const focusNode = (nodeId: string, recenter = false): void => {
    if (!focusId && depth === "all") setDepth(1);
    setFocusId(nodeId);
    setExpanded(false);
    setFocusTrail((current) =>
      [...current.filter((candidate) => candidate !== nodeId), nodeId].slice(-6),
    );
    if (recenter) centerNode(nodeId);
  };

  const zoomAtCenter = (factor: number): void => {
    setViewport((current) => {
      const nextScale = Math.min(2.5, Math.max(0.15, current.scale * factor));
      const centerX = surfaceSize.width / 2;
      const centerY = surfaceSize.height / 2;
      const worldX = (centerX - current.x) / current.scale;
      const worldY = (centerY - current.y) / current.scale;
      return {
        scale: nextScale,
        x: centerX - worldX * nextScale,
        y: centerY - worldY * nextScale,
      };
    });
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const rectangle = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - rectangle.left;
    const pointerY = event.clientY - rectangle.top;
    setViewport((current) => {
      const nextScale = Math.min(
        2.5,
        Math.max(0.15, current.scale * Math.exp(-event.deltaY * 0.001)),
      );
      const worldX = (pointerX - current.x) / current.scale;
      const worldY = (pointerY - current.y) / current.scale;
      return {
        scale: nextScale,
        x: pointerX - worldX * nextScale,
        y: pointerY - worldY * nextScale,
      };
    });
  };

  const openAnchor = async (anchor: SourceAnchor, openInRightPane: boolean): Promise<void> => {
    setStatus(null);
    try {
      const nextStatus = await onOpenAnchor(anchor, openInRightPane);
      setStatus(nextStatus);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `参照先を開けません · ${anchor.path}`);
    }
  };

  const deleteStructure = async (): Promise<void> => {
    if (deleting) return;
    const anchorCount =
      structure.nodes.filter((node) => node.anchor !== null).length +
      structure.edges.reduce((count, edge) => count + edge.anchors.length, 0);
    if (
      !window.confirm(
        `Structure「${structure.title}」を削除します。\n\nNode ${structure.nodes.length}\nEdge ${structure.edges.length}\nSource anchor ${anchorCount}\n\nこの操作は元に戻せません。`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setStatus(null);
    try {
      await api<DeleteStructureResponse>(
        `/api/pull-requests/${pullRequestId}/structures/${structure.id}`,
        { method: "DELETE", headers: { "content-type": "application/json" } },
      );
      sessions.delete(structure.id);
      onDeleted();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Structureを削除できませんでした。");
    } finally {
      setDeleting(false);
    }
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      const deltaX = (event.clientX - drag.x) / viewport.scale;
      const deltaY = (event.clientY - drag.y) / viewport.scale;
      dragRef.current = {
        ...drag,
        x: event.clientX,
        y: event.clientY,
        distance: drag.distance + Math.hypot(event.clientX - drag.x, event.clientY - drag.y),
      };
      setPositions((current) => {
        const point = current[drag.nodeId];
        return point
          ? { ...current, [drag.nodeId]: { x: point.x + deltaX, y: point.y + deltaY } }
          : current;
      });
      return;
    }
    const pan = panRef.current;
    if (pan?.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - pan.x;
    const deltaY = event.clientY - pan.y;
    panRef.current = { ...pan, x: event.clientX, y: event.clientY };
    setViewport((current) => ({ ...current, x: current.x + deltaX, y: current.y + deltaY }));
  };

  const stopPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
    if (dragRef.current?.pointerId === event.pointerId) {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag.distance < 4) {
        focusNode(drag.nodeId);
      }
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <article
      className="structure-viewer"
      data-structure-id={structure.id}
      data-visible-node-count={visible.nodeIds.size}
      data-total-node-count={structure.nodes.length}
      data-visible-edge-count={visible.edgeIds.size}
      data-total-edge-count={structure.edges.length}
      data-rendered-node-count={renderedNodes.length}
      data-rendered-edge-count={renderedEdges.length}
      data-viewport-scale={viewport.scale.toFixed(3)}
    >
      <header className="structure-header">
        <div>
          <span className="structure-kicker">
            Structure · exact source {structure.sourceOid.slice(0, 8)}
          </span>
          <h2>{structure.title}</h2>
          <p>{structure.scope}</p>
        </div>
        <div className="structure-header-side">
          <div className="structure-claim-note">
            Producerのclaim · source anchorは確認可能にする入口で、意味的正しさを保証しません。
          </div>
          <button
            type="button"
            className="danger structure-delete"
            disabled={deleting}
            onClick={() => void deleteStructure()}
          >
            {deleting ? "削除中…" : "削除"}
          </button>
        </div>
      </header>
      <div className="structure-toolbar" aria-label="Structure表示操作">
        <div className="structure-toolbar-group" role="group" aria-label="近傍の深さ">
          <span>近傍</span>
          {([1, 2, "all"] as const).map((candidate) => (
            <button
              type="button"
              key={candidate}
              className={depth === candidate ? "active" : ""}
              aria-pressed={depth === candidate}
              onClick={() => setDepth(candidate)}
            >
              {candidate === "all" ? "全体" : `${candidate}-hop`}
            </button>
          ))}
        </div>
        <div className="structure-toolbar-group">
          <button type="button" onClick={() => zoomAtCenter(1 / 1.2)} aria-label="縮小">
            −
          </button>
          <span>{Math.round(viewport.scale * 100)}%</span>
          <button type="button" onClick={() => zoomAtCenter(1.2)} aria-label="拡大">
            ＋
          </button>
          <button type="button" onClick={fitVisible}>
            表示中を収める
          </button>
          <button type="button" disabled={!focusId} onClick={centerFocus}>
            focusを中央へ
          </button>
        </div>
        <div className="structure-toolbar-group structure-toolbar-group--end">
          <button
            type="button"
            className={detailsOpen ? "active" : ""}
            aria-expanded={detailsOpen}
            aria-controls={`structure-details-${structure.id}`}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {detailsOpen ? "詳細サイドバーを隠す" : "詳細サイドバーを表示"}
          </button>
        </div>
      </div>
      {status && (
        <div className="structure-status" role="status" aria-live="polite">
          {status}
        </div>
      )}
      <div className={`structure-body${detailsOpen ? " with-details" : ""}`}>
        <section className="structure-canvas-shell" aria-label={`${structure.title} graph`}>
          <div
            ref={surfaceRef}
            className="structure-canvas"
            onWheel={handleWheel}
            onPointerDown={(event) => {
              if (
                event.button !== 0 ||
                (event.target instanceof Element &&
                  event.target.closest(".structure-node, .structure-edge-label, button"))
              ) {
                return;
              }
              panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={pointerMove}
            onPointerUp={stopPointer}
            onPointerCancel={stopPointer}
            onDoubleClick={(event) => {
              if (event.target === event.currentTarget) fitVisible();
            }}
          >
            <div
              className="structure-world"
              style={
                {
                  width: worldWidth,
                  height: worldHeight,
                  transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
                  "--structure-scale": viewport.scale,
                } as CSSProperties
              }
            >
              <svg
                className="structure-edges"
                width={worldWidth}
                height={worldHeight}
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id={`structure-arrow-${structure.id}`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" />
                  </marker>
                </defs>
                {renderedEdges.map((edge) => {
                  const route = edgePath(edge, positions, routeOffsets.get(edge.id) ?? 0);
                  if (!route) return null;
                  const focused = edge.from === focusId || edge.to === focusId;
                  return (
                    <path
                      key={edge.id}
                      className={`structure-edge${focused ? " focused" : ""}`}
                      data-edge-id={edge.id}
                      data-start-x={route.startX}
                      data-start-y={route.startY}
                      data-end-x={route.endX}
                      data-end-y={route.endY}
                      d={route.path}
                      markerEnd={
                        edge.directed ? `url(#structure-arrow-${structure.id})` : undefined
                      }
                    />
                  );
                })}
              </svg>
              {edgeLabelPlacements.map(({ edge, source, x, y, selectWidth, height, crowded }) => {
                const anchor = source.anchor;
                const changeKind = source.changeKind;
                return (
                  <div
                    key={`label:${edge.id}`}
                    className={`structure-edge-label${crowded ? " crowded" : ""}`}
                    data-edge-id={edge.id}
                    data-source-anchor-count={source.anchorCount}
                    data-source-change-kind={changeKind ?? undefined}
                    style={{ left: x, top: y, minHeight: height }}
                  >
                    <button
                      type="button"
                      className="structure-edge-select"
                      title={edge.label}
                      style={{ width: selectWidth }}
                      onClick={() => {
                        const nextId = edge.from === focusId ? edge.to : edge.from;
                        focusNode(nextId);
                      }}
                    >
                      {anchor && <EdgeSourceIdentity presentation={source} />}
                      <span className="structure-edge-label-text">{edge.label}</span>
                    </button>
                    {anchor && (
                      <SourceButton
                        compact
                        anchor={anchor}
                        relatedAnchorCount={source.additionalAnchorCount}
                        onOpen={(right) => void openAnchor(anchor, right)}
                      />
                    )}
                  </div>
                );
              })}
              {renderedNodes.map((node) => {
                const point = positions[node.id];
                if (!point) return null;
                const selected = node.id === focusId;
                const incidentToFocus = incident.some(
                  (edge) => edge.from === node.id || edge.to === node.id,
                );
                const changeKind = node.anchor
                  ? (sourceChangeKinds.get(node.anchor.path) ?? null)
                  : null;
                return (
                  <div
                    key={node.id}
                    className={`structure-node${selected ? " focused" : ""}${incidentToFocus ? " neighboring" : ""}`}
                    data-node-id={node.id}
                    data-source-change-kind={changeKind ?? undefined}
                    style={{ left: point.x, top: point.y }}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.stopPropagation();
                      dragRef.current = {
                        pointerId: event.pointerId,
                        nodeId: node.id,
                        x: event.clientX,
                        y: event.clientY,
                        distance: 0,
                      };
                      surfaceRef.current?.setPointerCapture(event.pointerId);
                    }}
                  >
                    <button
                      type="button"
                      className="structure-node-focus"
                      aria-pressed={selected}
                      onClick={(event) => {
                        if (event.detail === 0) focusNode(node.id);
                      }}
                    >
                      {node.kind && <span className="structure-kind">{node.kind}</span>}
                      <strong className="structure-node-title">
                        {node.anchor && (
                          <SourceIdentity anchor={node.anchor} changeKind={changeKind} />
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
                      <SourceButton
                        compact
                        anchor={node.anchor}
                        onOpen={(right) => void openAnchor(node.anchor!, right)}
                      />
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
              positions={positions}
              focusedNodeId={focusId}
              viewport={viewport}
              viewportElement={surfaceRef.current}
            />
          </div>
        </section>
        {detailsOpen && (
          <aside
            id={`structure-details-${structure.id}`}
            className="structure-details"
            aria-label="Structure details"
          >
            {focusedNode ? (
              <>
                <span className="structure-details-label">Focused Node</span>
                <h3>{focusedNode.label}</h3>
                {focusedNode.kind && <span className="structure-kind">{focusedNode.kind}</span>}
                <p>{focusedNode.description ?? "説明はありません。"}</p>
                {focusedNode.anchor ? (
                  <SourceButton
                    anchor={focusedNode.anchor}
                    onOpen={(right) => void openAnchor(focusedNode.anchor!, right)}
                  />
                ) : (
                  <span className="structure-unanchored">source anchorなし</span>
                )}
                <div className="structure-focus-trail" aria-label="focus履歴">
                  <span>focus履歴</span>
                  <div>
                    {focusTrail.map((nodeId) => {
                      const trailNode = structure.nodes.find((node) => node.id === nodeId);
                      return trailNode ? (
                        <button type="button" key={nodeId} onClick={() => focusNode(nodeId, true)}>
                          {trailNode.label}
                        </button>
                      ) : null;
                    })}
                  </div>
                </div>
                <div className="structure-relations-heading">
                  <strong>Relations</strong>
                  <span>{incident.length}</span>
                </div>
                {visible.relationsCollapsed && (
                  <button
                    type="button"
                    className="structure-expand-relations"
                    onClick={() => setExpanded(true)}
                  >
                    {visible.hiddenRelationCount}件のrelationを表示
                  </button>
                )}
                {expanded && incident.length > 12 && (
                  <button
                    type="button"
                    className="structure-expand-relations"
                    onClick={() => setExpanded(false)}
                  >
                    stable Edge ID順に折りたたむ
                  </button>
                )}
                <ul className="structure-relation-list">
                  {incident.map((edge) => {
                    const otherId = edge.from === focusId ? edge.to : edge.from;
                    const other = nodesById.get(otherId);
                    return (
                      <li key={edge.id} className={visible.edgeIds.has(edge.id) ? "" : "collapsed"}>
                        <button type="button" onClick={() => focusNode(otherId, true)}>
                          <span>{edge.directed ? (edge.from === focusId ? "→" : "←") : "—"}</span>
                          <strong>{edge.label}</strong>
                          <span>{other?.label ?? otherId}</span>
                        </button>
                        {edge.anchors.map((anchor, index) => (
                          <SourceButton
                            key={`${edge.id}:${index}`}
                            anchor={anchor}
                            onOpen={(right) => void openAnchor(anchor, right)}
                          />
                        ))}
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p>Nodeを選ぶとclaimとrelationを確認できます。</p>
            )}
          </aside>
        )}
      </div>
    </article>
  );
}
