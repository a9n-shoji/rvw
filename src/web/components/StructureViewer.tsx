import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { changedFilePath } from "../../domain/changed-file.js";
import type {
  ChangedFile,
  ChangeKind,
  SourceAnchor,
  Structure,
  StructureEdge,
  StructureSourceLocator,
} from "../../domain/models.js";
import { api, type DeleteStructureResponse } from "../api.js";
import type { DocumentPaneId } from "../document-workspace.js";
import {
  incidentStructureEdges,
  initialStructureLayout,
  STRUCTURE_NODE_HEIGHT,
  STRUCTURE_NODE_WIDTH,
  structureLayoutBounds,
  visibleStructureGraph,
  type StructureNeighborhoodDepth,
  type StructurePoint,
} from "../structure-graph.js";
import {
  appendStructureNavigationHistory,
  createStructureSession,
  deleteStructureSessions,
  getStructureSession,
  initialStructureViewport,
  MIN_STRUCTURE_ZOOM,
  preserveStructureLayoutScreenPosition,
  reconcileStructureSession,
  scaledStructureZoom,
  setStructureSession,
  structureBackboneNodeIds,
  structureHomeNodeIds,
  structureOneHopNodeIds,
  structureViewportForBounds,
  structureViewportForNodeIds,
  type StructureGuideDisclosure,
  type StructureNavigationHistoryEntry,
  type StructureNavigationTarget,
  type StructureViewport,
} from "../structure-session.js";
import {
  downloadStructureBlob,
  planStructurePngRaster,
  rasterizeStructureSvg,
  readStructureExportPalette,
  serializeStructureSvg,
  structureExportErrorMessage,
  structureExportFilename,
  type StructureExportFormat,
} from "../structure-export.js";
import {
  buildFullStructureRenderModel,
  buildStructureRenderModel,
} from "../structure-render-model.js";
import { ChangeIcon } from "./FileTree.js";
import { FileEntryIcon } from "./FileIcon.js";
import { StructureExportMenu } from "./StructureExportMenu.js";
import { StructurePresentationOverview } from "./StructurePresentationOverview.js";

const STRUCTURE_WHEEL_PAN_SENSITIVITY = 2;
const STRUCTURE_TRACKPAD_ZOOM_SENSITIVITY = 0.005;
const STRUCTURE_META_WHEEL_ZOOM_SENSITIVITY = 0.002;

function anchorLabel(anchor: SourceAnchor): string {
  return anchor.startLine === null
    ? anchor.path
    : `${anchor.path}:${anchor.startLine}${anchor.endLine === anchor.startLine ? "" : `-${anchor.endLine}`}`;
}

function SourceButton({
  anchor,
  compact = false,
  onOpen,
}: {
  anchor: SourceAnchor;
  compact?: boolean;
  onOpen: (openInRightPane: boolean) => void;
}) {
  const label = `${anchorLabel(anchor)}を開く`;
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

function EdgeSourceAction({
  edge,
  onOpen,
}: {
  edge: StructureEdge;
  onOpen: (locator: StructureSourceLocator, anchor: SourceAnchor, openInRightPane: boolean) => void;
}) {
  if (edge.anchors.length === 0) return null;
  if (edge.anchors.length === 1) {
    return (
      <SourceButton
        compact
        anchor={edge.anchors[0]!}
        onOpen={(right) =>
          onOpen({ kind: "edge", edgeId: edge.id, anchorIndex: 0 }, edge.anchors[0]!, right)
        }
      />
    );
  }
  return (
    <details className="structure-edge-sources">
      <summary
        className="structure-source compact"
        aria-label={`${edge.label}のsource evidence ${edge.anchors.length}件を表示`}
        title={`source evidence ${edge.anchors.length}件`}
      >
        <span aria-hidden="true">&lt;/&gt;</span>
        <span className="structure-edge-source-count" aria-hidden="true">
          {edge.anchors.length}
        </span>
      </summary>
      <div className="structure-edge-source-menu">
        {edge.anchors.map((anchor, index) => (
          <SourceButton
            key={`${edge.id}:${index}`}
            anchor={anchor}
            onOpen={(right) =>
              onOpen({ kind: "edge", edgeId: edge.id, anchorIndex: index }, anchor, right)
            }
          />
        ))}
      </div>
    </details>
  );
}

function SourceIdentity({
  anchor,
  changeKind,
  sourceLabel,
}: {
  anchor: SourceAnchor;
  changeKind: ChangeKind | null;
  sourceLabel: string;
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
      <span className="structure-source-name">{sourceLabel}</span>
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
  framedRegionIndex,
  viewport,
  viewportElement,
}: {
  structure: Structure;
  positions: Readonly<Record<string, StructurePoint>>;
  focusedNodeId: string | null;
  framedRegionIndex: number | null;
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
  const primaryBackboneEdgeIds = new Set(structure.presentation?.primaryBackbone?.edgeIds ?? []);
  const primaryBackboneNodeIds = structureBackboneNodeIds(structure);
  const regionByNodeId = new Map(
    (structure.presentation?.regions ?? []).flatMap((region, index) =>
      region.nodeIds.map((nodeId) => [nodeId, index] as const),
    ),
  );
  const presentationStartPoint = structure.presentation
    ? positions[structure.presentation.startNodeId]
    : undefined;
  return (
    <svg
      className="structure-minimap"
      viewBox={`0 0 ${mapWidth} ${mapHeight}`}
      aria-label="Structure minimap"
    >
      {structure.edges.flatMap((edge) => {
        if (!primaryBackboneEdgeIds.has(edge.id)) return [];
        const from = positions[edge.from];
        const to = positions[edge.to];
        if (!from || !to) return [];
        return [
          <line
            key={edge.id}
            className="structure-minimap-primary-backbone"
            data-edge-id={edge.id}
            x1={mapX(from.x + STRUCTURE_NODE_WIDTH / 2)}
            y1={mapY(from.y + STRUCTURE_NODE_HEIGHT / 2)}
            x2={mapX(to.x + STRUCTURE_NODE_WIDTH / 2)}
            y2={mapY(to.y + STRUCTURE_NODE_HEIGHT / 2)}
          />,
        ];
      })}
      {structure.nodes.map((node) => {
        const point = positions[node.id];
        if (!point) return null;
        const classes = [
          node.id === focusedNodeId ? "focused" : null,
          primaryBackboneNodeIds.has(node.id) ? "primary-backbone" : null,
          regionByNodeId.has(node.id) ? "region-member" : null,
          regionByNodeId.get(node.id) === framedRegionIndex ? "framed-region-member" : null,
        ].filter((value): value is string => value !== null);
        return (
          <circle
            key={node.id}
            cx={mapX(point.x + STRUCTURE_NODE_WIDTH / 2)}
            cy={mapY(point.y + STRUCTURE_NODE_HEIGHT / 2)}
            r={node.id === focusedNodeId ? 3.2 : 1.7}
            className={classes.join(" ")}
            data-region-index={regionByNodeId.get(node.id)}
          />
        );
      })}
      {presentationStartPoint && (
        <circle
          className="structure-minimap-presentation-start"
          cx={mapX(presentationStartPoint.x + STRUCTURE_NODE_WIDTH / 2)}
          cy={mapY(presentationStartPoint.y + STRUCTURE_NODE_HEIGHT / 2)}
          r="4.6"
        />
      )}
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
  paneId,
  pullRequestId,
  structure,
  changedFiles,
  navigationTarget = null,
  onNavigationApplied,
  onNavigationFailed,
  onOpenSource,
  onDeleted,
}: {
  paneId: DocumentPaneId;
  pullRequestId: string;
  structure: Structure;
  changedFiles: readonly ChangedFile[];
  navigationTarget?: StructureNavigationTarget | null;
  onNavigationApplied: (requestId: number) => void;
  onNavigationFailed: (requestId: number) => void;
  onOpenSource: (
    locator: StructureSourceLocator,
    openInRightPane: boolean,
  ) => Promise<string | null>;
  onDeleted: () => void;
}) {
  const domId = `structure-${paneId}-${structure.id}`;
  const [initialState] = useState(() => {
    const cachedSession = getStructureSession(paneId, structure.id);
    return {
      hadCachedSession: cachedSession !== undefined,
      session: cachedSession
        ? reconcileStructureSession(structure, cachedSession)
        : createStructureSession(structure),
    };
  });
  const initial = initialState.session;
  const [focusId, setFocusId] = useState(initial.focusId);
  const [selectedEdgeId, setSelectedEdgeId] = useState(initial.selectedEdgeId);
  const [depth, setDepth] = useState<StructureNeighborhoodDepth>(initial.depth);
  const [framedRegionIndex, setFramedRegionIndex] = useState(initial.framedRegionIndex);
  const [positions, setPositions] = useState(initial.positions);
  const [viewport, setViewport] = useState(initial.viewport);
  const [guideDisclosure, setGuideDisclosure] = useState(initial.guideDisclosure);
  const [navigationHistory, setNavigationHistory] = useState(initial.navigationHistory);
  const [cameraAnimating, setCameraAnimating] = useState(false);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const [status, setStatus] = useState<string | null>(null);
  const [exporting, setExporting] = useState<StructureExportFormat | null>(null);
  const [deleting, setDeleting] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const surfaceSizeRef = useRef(initial.surfaceSize);
  const focusIdRef = useRef(focusId);
  const depthRef = useRef(depth);
  const framedRegionIndexRef = useRef(framedRegionIndex);
  const positionsRef = useRef(positions);
  const viewportRef = useRef(viewport);
  const navigationHistoryRef = useRef(navigationHistory);
  const cameraAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionStateRef = useRef(initial);
  const observedStructureRef = useRef({
    sourceOid: structure.sourceOid,
    updatedAt: structure.updatedAt,
  });
  const pendingViewportActionRef = useRef<"initial" | null>(
    initialState.hadCachedSession ? null : "initial",
  );
  const appliedNavigationRequestRef = useRef<number | null>(null);
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    nodeId: string;
    x: number;
    y: number;
    distance: number;
  } | null>(null);
  focusIdRef.current = focusId;
  depthRef.current = depth;
  framedRegionIndexRef.current = framedRegionIndex;
  positionsRef.current = positions;
  viewportRef.current = viewport;
  navigationHistoryRef.current = navigationHistory;
  sessionStateRef.current = {
    focusId,
    selectedEdgeId,
    depth,
    framedRegionIndex,
    positions,
    viewport,
    surfaceSize: surfaceSizeRef.current,
    guideDisclosure,
    navigationHistory,
    layoutBasisKey: sessionStateRef.current.layoutBasisKey,
    updatedAt: sessionStateRef.current.updatedAt,
  };

  useEffect(
    () => () => {
      if (cameraAnimationTimerRef.current) clearTimeout(cameraAnimationTimerRef.current);
    },
    [],
  );

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
    const surface = surfaceRef.current;
    if (!surface) return;
    const handleWheel = (event: WheelEvent): void => {
      const wantsCanvasZoom = event.ctrlKey || event.metaKey;
      if (event.target instanceof Element) {
        const nodeScroller = event.target.closest<HTMLElement>(".structure-node-focus");
        const mostlyVertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
        const canScrollVertically = nodeScroller
          ? event.deltaY < 0
            ? nodeScroller.scrollTop > 0
            : event.deltaY > 0
              ? nodeScroller.scrollTop + nodeScroller.clientHeight < nodeScroller.scrollHeight - 1
              : false
          : false;
        if (!wantsCanvasZoom && mostlyVertical && canScrollVertically) return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (cameraAnimationTimerRef.current) {
        clearTimeout(cameraAnimationTimerRef.current);
        cameraAnimationTimerRef.current = null;
        setCameraAnimating(false);
      }
      const deltaUnit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? Math.max(1, surface.clientHeight)
            : 1;
      if (!wantsCanvasZoom) {
        setViewport((current) => ({
          ...current,
          x: current.x - event.deltaX * deltaUnit * STRUCTURE_WHEEL_PAN_SENSITIVITY,
          y: current.y - event.deltaY * deltaUnit * STRUCTURE_WHEEL_PAN_SENSITIVITY,
        }));
        return;
      }
      const rectangle = surface.getBoundingClientRect();
      const pointerX = event.clientX - rectangle.left;
      const pointerY = event.clientY - rectangle.top;
      setViewport((current) => {
        const sensitivity =
          event.ctrlKey && !event.metaKey
            ? STRUCTURE_TRACKPAD_ZOOM_SENSITIVITY
            : STRUCTURE_META_WHEEL_ZOOM_SENSITIVITY;
        const nextScale = scaledStructureZoom(
          current.scale,
          Math.exp(-event.deltaY * deltaUnit * sensitivity),
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
    surface.addEventListener("wheel", handleWheel, { passive: false });
    return () => surface.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const previous = sessionStateRef.current;
    const next = reconcileStructureSession(structure, previous);
    if (previous.updatedAt === next.updatedAt && previous.layoutBasisKey === next.layoutBasisKey) {
      return;
    }
    const observed = observedStructureRef.current;
    if (observed.updatedAt !== structure.updatedAt) {
      setStatus(
        observed.sourceOid === structure.sourceOid
          ? "Structureが更新されました。閲覧状態を保ったまま最新のclaimへ反映しています。"
          : `Structureが更新されました。exact source ${observed.sourceOid.slice(0, 8)} → ${structure.sourceOid.slice(0, 8)}`,
      );
    }
    observedStructureRef.current = {
      sourceOid: structure.sourceOid,
      updatedAt: structure.updatedAt,
    };
    sessionStateRef.current = next;
    focusIdRef.current = next.focusId;
    depthRef.current = next.depth;
    framedRegionIndexRef.current = next.framedRegionIndex;
    positionsRef.current = next.positions;
    viewportRef.current = next.viewport;
    navigationHistoryRef.current = next.navigationHistory;
    setFocusId(next.focusId);
    setSelectedEdgeId(next.selectedEdgeId);
    setDepth(next.depth);
    setFramedRegionIndex(next.framedRegionIndex);
    setPositions(next.positions);
    setViewport(next.viewport);
    setGuideDisclosure(next.guideDisclosure);
    setNavigationHistory(next.navigationHistory);
  }, [structure]);

  useEffect(() => {
    setStructureSession(paneId, structure.id, sessionStateRef.current);
  }, [
    depth,
    focusId,
    framedRegionIndex,
    guideDisclosure,
    navigationHistory,
    positions,
    paneId,
    selectedEdgeId,
    structure.id,
    structure.updatedAt,
    surfaceSize,
    viewport,
  ]);

  const visible = useMemo(
    () => visibleStructureGraph(structure, focusId, depth),
    [depth, focusId, structure],
  );
  const nodesById = useMemo(
    () => new Map(structure.nodes.map((node) => [node.id, node])),
    [structure.nodes],
  );
  const focusedNode = focusId ? (nodesById.get(focusId) ?? null) : null;
  const originNode = nodesById.get(structure.originNodeId)!;
  const selectedEdge = selectedEdgeId
    ? (structure.edges.find((edge) => edge.id === selectedEdgeId) ?? null)
    : null;
  const selectedEdgeNodeIds = useMemo(
    () => new Set(selectedEdge ? [selectedEdge.from, selectedEdge.to] : []),
    [selectedEdge],
  );
  const incident = useMemo(
    () => (focusId ? incidentStructureEdges(structure, focusId) : []),
    [focusId, structure],
  );
  const primaryBackboneEdgeIds = useMemo(
    () => new Set(structure.presentation?.primaryBackbone?.edgeIds ?? []),
    [structure.presentation],
  );
  const primaryBackboneNodeIds = useMemo(() => structureBackboneNodeIds(structure), [structure]);
  const oneHopNodeIds = useMemo(
    () => (focusId ? structureOneHopNodeIds(structure, [focusId]) : visible.nodeIds),
    [focusId, structure, visible.nodeIds],
  );
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
  const labelEdgeIds = useMemo(() => new Set(visible.edgeIds), [visible.edgeIds]);
  const renderModel = useMemo(
    () =>
      buildStructureRenderModel({
        structure,
        positions,
        sourceChangeKinds,
        selection: {
          nodeIds: visible.nodeIds,
          edgeIds: visible.edgeIds,
          labelEdgeIds,
        },
        labelAccessory: "source-actions",
        edgeLabelMode: "viewer-clamped",
      }),
    [labelEdgeIds, positions, sourceChangeKinds, structure, visible.edgeIds, visible.nodeIds],
  );
  const renderedEdges = renderModel.edges.map(({ edge }) => edge);
  const renderedNodes = renderModel.nodes.map(({ node }) => node);
  const edgeLabelPlacements = renderModel.labels;
  const presentationRegionByNodeId = useMemo(
    () =>
      new Map(
        (structure.presentation?.regions ?? []).flatMap((region, index) =>
          region.nodeIds.map((nodeId) => [nodeId, { index, label: region.label }] as const),
        ),
      ),
    [structure.presentation],
  );
  const framedRegionNodeIds = useMemo(
    () =>
      new Set(
        framedRegionIndex === null
          ? []
          : (structure.presentation?.regions[framedRegionIndex]?.nodeIds ?? []),
      ),
    [framedRegionIndex, structure.presentation],
  );
  const displayBounds = renderModel.bounds;
  const worldWidth = Math.max(1_200, (displayBounds?.right ?? 1_000) + 180);
  const worldHeight = Math.max(800, (displayBounds?.bottom ?? 600) + 180);

  const fittedViewport = (): StructureViewport | null => {
    if (!displayBounds || surfaceSize.width === 0 || surfaceSize.height === 0) return null;
    const padding = 36;
    const scale = Math.min(
      1.25,
      Math.max(
        MIN_STRUCTURE_ZOOM,
        Math.min(
          (surfaceSize.width - padding * 2) / Math.max(1, displayBounds.right - displayBounds.left),
          (surfaceSize.height - padding * 2) /
            Math.max(1, displayBounds.bottom - displayBounds.top),
        ),
      ),
    );
    const width = (displayBounds.right - displayBounds.left) * scale;
    const height = (displayBounds.bottom - displayBounds.top) * scale;
    return {
      scale,
      x: (surfaceSize.width - width) / 2 - displayBounds.left * scale,
      y: (surfaceSize.height - height) / 2 - displayBounds.top * scale,
    };
  };

  const fitVisible = (): void => {
    const fitted = fittedViewport();
    if (!fitted) return;
    setViewport(fitted);
  };

  useLayoutEffect(() => {
    const action = pendingViewportActionRef.current;
    if (!action || !displayBounds || surfaceSize.width === 0 || surfaceSize.height === 0) return;
    pendingViewportActionRef.current = null;
    setViewport(initialStructureViewport({ structure, positions, surfaceSize }));
  }, [displayBounds, positions, structure, surfaceSize]);

  const centerNode = useCallback(
    (nodeId: string, scale?: number): void => {
      const point = positions[nodeId];
      if (!point) return;
      setViewport((current) => ({
        scale: scale ?? current.scale,
        x: surfaceSize.width / 2 - (point.x + STRUCTURE_NODE_WIDTH / 2) * (scale ?? current.scale),
        y:
          surfaceSize.height / 2 - (point.y + STRUCTURE_NODE_HEIGHT / 2) * (scale ?? current.scale),
      }));
    },
    [positions, surfaceSize.height, surfaceSize.width],
  );

  const animateCameraTo = useCallback((nextViewport: StructureViewport): void => {
    if (cameraAnimationTimerRef.current) clearTimeout(cameraAnimationTimerRef.current);
    setCameraAnimating(true);
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
    cameraAnimationTimerRef.current = setTimeout(() => {
      cameraAnimationTimerRef.current = null;
      setCameraAnimating(false);
    }, 220);
  }, []);

  const recordCurrentNavigation = useCallback((target?: StructureNavigationHistoryEntry): void => {
    const current = {
      focusId: focusIdRef.current,
      depth: depthRef.current,
      framedRegionIndex: framedRegionIndexRef.current,
      viewport: viewportRef.current,
    };
    if (
      target &&
      current.focusId === target.focusId &&
      current.depth === target.depth &&
      current.framedRegionIndex === target.framedRegionIndex &&
      current.viewport.x === target.viewport.x &&
      current.viewport.y === target.viewport.y &&
      current.viewport.scale === target.viewport.scale
    ) {
      return;
    }
    const nextHistory = appendStructureNavigationHistory(navigationHistoryRef.current, {
      focusId: current.focusId,
      depth: current.depth,
      framedRegionIndex: current.framedRegionIndex,
      viewport: current.viewport,
    });
    navigationHistoryRef.current = nextHistory;
    setNavigationHistory(nextHistory);
  }, []);

  const activateNode = useCallback(
    (nodeId: string, recordHistory = true): void => {
      if (!positions[nodeId]) return;
      const nextViewport = structureViewportForNodeIds({
        nodeIds: structureOneHopNodeIds(structure, [nodeId]),
        positions,
        surfaceSize,
      });
      const initializing = pendingViewportActionRef.current === "initial";
      pendingViewportActionRef.current = null;
      if (recordHistory && !initializing) {
        recordCurrentNavigation({
          focusId: nodeId,
          depth: depthRef.current,
          framedRegionIndex: null,
          viewport: nextViewport ?? viewportRef.current,
        });
      }
      setSelectedEdgeId(null);
      framedRegionIndexRef.current = null;
      setFramedRegionIndex(null);
      focusIdRef.current = nodeId;
      setFocusId(nodeId);
      if (nextViewport) animateCameraTo(nextViewport);
    },
    [animateCameraTo, positions, recordCurrentNavigation, structure, surfaceSize],
  );

  const navigateHome = (): void => {
    const homeFocusId = structure.presentation?.startNodeId ?? structure.originNodeId;
    const nextViewport = structureViewportForNodeIds({
      nodeIds: structureHomeNodeIds(structure),
      positions,
      surfaceSize,
    });
    const initializing = pendingViewportActionRef.current === "initial";
    pendingViewportActionRef.current = null;
    if (!initializing) {
      recordCurrentNavigation({
        focusId: homeFocusId,
        depth: "all",
        framedRegionIndex: null,
        viewport: nextViewport ?? viewportRef.current,
      });
    }
    setSelectedEdgeId(null);
    framedRegionIndexRef.current = null;
    setFramedRegionIndex(null);
    focusIdRef.current = homeFocusId;
    setFocusId(homeFocusId);
    depthRef.current = "all";
    setDepth("all");
    if (nextViewport) animateCameraTo(nextViewport);
  };

  const navigateBack = (): void => {
    const history = navigationHistoryRef.current;
    const previous = history.at(-1);
    if (!previous) return;
    const nextHistory = history.slice(0, -1);
    navigationHistoryRef.current = nextHistory;
    setNavigationHistory(nextHistory);
    setSelectedEdgeId(null);
    focusIdRef.current = previous.focusId;
    setFocusId(previous.focusId);
    depthRef.current = previous.focusId === null ? "all" : previous.depth;
    setDepth(depthRef.current);
    framedRegionIndexRef.current = previous.framedRegionIndex;
    setFramedRegionIndex(previous.framedRegionIndex);
    animateCameraTo(previous.viewport);
  };

  const frameRegion = (regionIndex: number): void => {
    const region = structure.presentation?.regions[regionIndex];
    if (!region) return;

    const renderRegion = renderModel.presentation?.regions.find(
      (candidate) => candidate.index === regionIndex,
    );
    const nextViewport = renderRegion
      ? structureViewportForBounds({ bounds: renderRegion.bounds, surfaceSize })
      : structureViewportForNodeIds({
          nodeIds: region.nodeIds,
          positions,
          surfaceSize,
        });
    if (!nextViewport) return;
    const initializing = pendingViewportActionRef.current === "initial";
    pendingViewportActionRef.current = null;
    if (!initializing) {
      recordCurrentNavigation({
        focusId: focusIdRef.current,
        depth: "all",
        framedRegionIndex: regionIndex,
        viewport: nextViewport,
      });
    }
    depthRef.current = "all";
    setDepth("all");
    framedRegionIndexRef.current = regionIndex;
    setFramedRegionIndex(regionIndex);
    animateCameraTo(nextViewport);
  };

  useLayoutEffect(() => {
    if (
      !navigationTarget ||
      navigationTarget.structureId !== structure.id ||
      navigationTarget.pane !== paneId ||
      appliedNavigationRequestRef.current === navigationTarget.requestId
    ) {
      return;
    }
    if (structure.updatedAt < navigationTarget.structureUpdatedAt) return;
    if (structure.updatedAt > navigationTarget.structureUpdatedAt) {
      appliedNavigationRequestRef.current = navigationTarget.requestId;
      setStatus(
        "Structureが更新されたため、ファイル参照を更新しました。もう一度選択してください。",
      );
      onNavigationFailed(navigationTarget.requestId);
      return;
    }
    const requestedNode = structure.nodes.find((node) => node.id === navigationTarget.nodeId);
    if (!requestedNode) {
      appliedNavigationRequestRef.current = navigationTarget.requestId;
      setStatus(
        "移動先のNodeはStructureの更新により削除されています。ファイル参照を更新しました。",
      );
      onNavigationFailed(navigationTarget.requestId);
      return;
    }
    if (!positions[requestedNode.id] || surfaceSize.width === 0 || surfaceSize.height === 0) {
      return;
    }
    pendingViewportActionRef.current = null;
    setStatus(null);
    setSelectedEdgeId(null);
    framedRegionIndexRef.current = null;
    setFramedRegionIndex(null);
    focusIdRef.current = requestedNode.id;
    setFocusId(requestedNode.id);
    centerNode(requestedNode.id);
    appliedNavigationRequestRef.current = navigationTarget.requestId;
    onNavigationApplied(navigationTarget.requestId);
  }, [
    centerNode,
    navigationTarget,
    onNavigationApplied,
    onNavigationFailed,
    paneId,
    positions,
    structure.id,
    structure.nodes,
    surfaceSize.height,
    surfaceSize.width,
  ]);

  const centerFocus = (): void => {
    if (focusId) centerNode(focusId);
  };

  const resetLayout = (): void => {
    const nextPositions = initialStructureLayout(structure);
    setViewport((current) =>
      preserveStructureLayoutScreenPosition({
        viewport: current,
        surfaceSize: surfaceSizeRef.current,
        nodeId: focusIdRef.current,
        nodeIds: structure.nodes.map((node) => node.id),
        previousPositions: positionsRef.current,
        nextPositions,
      }),
    );
    setPositions(nextPositions);
  };

  const clearFocus = (): void => {
    if (framedRegionIndexRef.current !== null) {
      recordCurrentNavigation({
        focusId: null,
        depth: "all",
        framedRegionIndex: null,
        viewport: viewportRef.current,
      });
    }
    setSelectedEdgeId(null);
    focusIdRef.current = null;
    setFocusId(null);
    depthRef.current = "all";
    setDepth("all");
    framedRegionIndexRef.current = null;
    setFramedRegionIndex(null);
  };

  const selectDepth = (nextDepth: StructureNeighborhoodDepth): void => {
    if (nextDepth === depth) return;
    if (framedRegionIndexRef.current !== null) {
      recordCurrentNavigation({
        focusId: focusIdRef.current,
        depth: nextDepth,
        framedRegionIndex: null,
        viewport: viewportRef.current,
      });
    }
    depthRef.current = nextDepth;
    setDepth(nextDepth);
    framedRegionIndexRef.current = null;
    setFramedRegionIndex(null);
  };

  const copyStructureRef = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(structure.ref);
      setStatus("Structure参照をコピーしました。");
    } catch {
      setStatus("Structure参照をコピーできませんでした。");
    }
  };

  const exportStructure = async (format: StructureExportFormat): Promise<void> => {
    if (exporting) return;
    setExporting(format);
    setStatus(null);
    try {
      const model = buildFullStructureRenderModel({ structure, positions, sourceChangeKinds });
      const palette = readStructureExportPalette(document.documentElement);
      const svg = serializeStructureSvg({ structure, model, palette });
      if (format === "svg") {
        downloadStructureBlob(
          new Blob([svg.source], { type: "image/svg+xml;charset=utf-8" }),
          structureExportFilename(structure, "svg"),
        );
        return;
      }
      const rasterPlan = planStructurePngRaster(svg.width, svg.height);
      const png = await rasterizeStructureSvg(svg, rasterPlan);
      downloadStructureBlob(png, structureExportFilename(structure, "png"));
      if (rasterPlan.downscaled) {
        setStatus(
          `PNGを${Math.round(rasterPlan.scale * 100)}%で出力しました。より高い解像度にはSVGを使用してください。`,
        );
      }
    } catch (error) {
      setStatus(structureExportErrorMessage(error));
    } finally {
      setExporting(null);
    }
  };

  const zoomAtCenter = (factor: number): void => {
    setViewport((current) => {
      const nextScale = scaledStructureZoom(current.scale, factor);
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

  const openSource = async (
    locator: StructureSourceLocator,
    anchor: SourceAnchor,
    openInRightPane: boolean,
  ): Promise<void> => {
    setStatus(null);
    try {
      const nextStatus = await onOpenSource(locator, openInRightPane);
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
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedUpdatedAt: structure.updatedAt }),
        },
      );
      deleteStructureSessions(structure.id);
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
        activateNode(drag.nodeId);
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
      data-has-presentation={structure.presentation ? "true" : undefined}
      data-viewport-scale={viewport.scale.toFixed(3)}
      data-semantic-zoom={viewport.scale < 0.42 ? "overview" : "detail"}
      data-navigation-history-count={navigationHistory.length}
      data-framed-region-index={framedRegionIndex ?? undefined}
      data-selected-edge-id={selectedEdgeId ?? undefined}
    >
      <header className="structure-header">
        <div className="structure-header-main">
          <span className="structure-kicker">Structure</span>
          <h2 title={structure.title}>{structure.title}</h2>
          <span className="structure-source-oid" title={`exact source ${structure.sourceOid}`}>
            {structure.sourceOid.slice(0, 8)}
          </span>
          <details className="structure-scope-details">
            <summary aria-label="scopeを表示">scope</summary>
            <p>{structure.scope}</p>
          </details>
        </div>
        <div className="structure-header-side">
          <button
            type="button"
            className="structure-header-action"
            aria-label="参照をコピー"
            title="Structure参照をコピー"
            onClick={() => void copyStructureRef()}
          >
            参照
          </button>
          <StructureExportMenu
            disabled={deleting || exporting !== null}
            exporting={exporting}
            onExport={(format) => void exportStructure(format)}
          />
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
      <StructurePresentationOverview
        structure={structure}
        focusedNodeId={focusId}
        framedRegionIndex={framedRegionIndex}
        disclosure={guideDisclosure}
        onToggleDisclosure={(section: keyof StructureGuideDisclosure) =>
          setGuideDisclosure((current) => ({ ...current, [section]: !current[section] }))
        }
        onFocusNode={activateNode}
        onFrameRegion={frameRegion}
      />
      <div className="structure-body">
        <div className="structure-toolbar" aria-label="Structure表示操作">
          <div className="structure-toolbar-group" role="group" aria-label="Structure内navigation">
            <button
              type="button"
              aria-label="Back"
              title="一つ前のfocusとcameraへ戻る"
              disabled={navigationHistory.length === 0}
              onClick={navigateBack}
            >
              Back
            </button>
            <button
              type="button"
              aria-label="Home"
              title="説明のbackboneと近傍を表示"
              onClick={navigateHome}
            >
              Home
            </button>
          </div>
          <div className="structure-toolbar-group" role="group" aria-label="近傍の深さ">
            {([1, 2, "all"] as const).map((candidate) => (
              <button
                type="button"
                key={candidate}
                className={depth === candidate ? "active" : ""}
                aria-pressed={depth === candidate}
                disabled={!focusId && candidate !== "all"}
                onClick={() => selectDepth(candidate)}
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
            <button
              type="button"
              aria-label="表示中を収める"
              title="表示中を収める"
              onClick={fitVisible}
            >
              Fit
            </button>
            <button
              type="button"
              aria-label="focusを中央へ"
              title="focusを中央へ"
              disabled={!focusId}
              onClick={centerFocus}
            >
              中央
            </button>
            <button
              type="button"
              aria-label="focusを解除"
              title="focusを解除"
              disabled={!focusId}
              onClick={clearFocus}
            >
              解除
            </button>
            <button
              type="button"
              aria-label="レイアウトを戻す"
              title="レイアウトを戻す"
              onClick={resetLayout}
            >
              Reset
            </button>
          </div>
        </div>
        {status && (
          <div className="structure-status" role="status" aria-live="polite">
            {status}
          </div>
        )}
        <section className="structure-canvas-shell" aria-label={`${structure.title} graph`}>
          <div
            ref={surfaceRef}
            className="structure-canvas"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || (!selectedEdgeId && !focusId)) return;
              event.preventDefault();
              if (selectedEdgeId) setSelectedEdgeId(null);
              else clearFocus();
            }}
            onPointerDown={(event) => {
              if (
                event.button !== 0 ||
                (event.target instanceof Element &&
                  event.target.closest(".structure-node, .structure-edge-label, button"))
              ) {
                return;
              }
              if (cameraAnimationTimerRef.current) {
                clearTimeout(cameraAnimationTimerRef.current);
                cameraAnimationTimerRef.current = null;
                setCameraAnimating(false);
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
              className={`structure-world${cameraAnimating ? " camera-transition" : ""}`}
              style={{
                width: worldWidth,
                height: worldHeight,
                transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
              }}
            >
              {(structure.presentation?.regions ?? []).flatMap((region, regionIndex) =>
                region.nodeIds.flatMap((nodeId) => {
                  if (!visible.nodeIds.has(nodeId)) return [];
                  const point = positions[nodeId];
                  if (!point) return [];
                  return [
                    <span
                      key={`region:${regionIndex}:${nodeId}`}
                      className="structure-region-member"
                      data-region-index={regionIndex}
                      data-region-node-id={nodeId}
                      data-framed-region-member={
                        framedRegionIndex === regionIndex ? "true" : undefined
                      }
                      title={`Region ${regionIndex + 1}: ${region.label}`}
                      aria-hidden="true"
                      style={{
                        left: point.x + STRUCTURE_NODE_WIDTH - 25,
                        top: point.y - 14,
                      }}
                    >
                      R{regionIndex + 1}
                    </span>,
                  ];
                }),
              )}
              <svg
                className="structure-edges"
                width={worldWidth}
                height={worldHeight}
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id={`${domId}-arrow`}
                    viewBox="0 0 10 10"
                    refX="10"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" />
                  </marker>
                </defs>
                {renderModel.edges.map(({ edge, geometry: route, source }) => {
                  const focused = edge.from === focusId || edge.to === focusId;
                  const selected = edge.id === selectedEdgeId;
                  const muted = selectedEdgeId !== null && !selected;
                  const primaryBackbone = primaryBackboneEdgeIds.has(edge.id);
                  const focusDistant =
                    focusId !== null &&
                    !focused &&
                    !oneHopNodeIds.has(edge.from) &&
                    !oneHopNodeIds.has(edge.to);
                  const framedRegionRelation =
                    framedRegionNodeIds.has(edge.from) && framedRegionNodeIds.has(edge.to);
                  const contextDistant = focusDistant && !framedRegionRelation;
                  const changeKind = source.changeKind;
                  return (
                    <path
                      key={edge.id}
                      className={`structure-edge${primaryBackbone ? " primary-backbone" : ""}${focused ? " focused" : ""}${framedRegionRelation ? " framed-region-relation" : ""}${selected ? " selected" : ""}${contextDistant ? " context-distant" : ""}${muted ? " muted" : ""}`}
                      data-edge-id={edge.id}
                      data-primary-backbone={primaryBackbone ? "true" : undefined}
                      data-focus-relevance={
                        focused ? "incident" : focusDistant ? "distant" : "near"
                      }
                      data-framed-region-relation={framedRegionRelation ? "true" : undefined}
                      data-source-change-kind={changeKind ?? undefined}
                      data-start-x={route.startX}
                      data-start-y={route.startY}
                      data-end-x={route.endX}
                      data-end-y={route.endY}
                      d={route.path}
                      markerEnd={edge.directed ? `url(#${domId}-arrow)` : undefined}
                    />
                  );
                })}
                {edgeLabelPlacements.flatMap(({ edge, leaderPath, source }) => {
                  if (!leaderPath) return [];
                  const primaryBackbone = primaryBackboneEdgeIds.has(edge.id);
                  const focused = edge.from === focusId || edge.to === focusId;
                  const selected = edge.id === selectedEdgeId;
                  const muted = selectedEdgeId !== null && !selected;
                  const focusDistant =
                    focusId !== null &&
                    !focused &&
                    !oneHopNodeIds.has(edge.from) &&
                    !oneHopNodeIds.has(edge.to);
                  const framedRegionRelation =
                    framedRegionNodeIds.has(edge.from) && framedRegionNodeIds.has(edge.to);
                  const contextDistant = focusDistant && !framedRegionRelation;
                  return [
                    <path
                      key={`label-leader:${edge.id}`}
                      className={`structure-edge-label-leader${primaryBackbone ? " primary-backbone" : ""}${focused ? " focus-incident" : ""}${framedRegionRelation ? " framed-region-relation" : ""}${selected ? " selected" : ""}${contextDistant ? " context-distant" : ""}${muted ? " muted" : ""}`}
                      data-edge-id={edge.id}
                      data-primary-backbone={primaryBackbone ? "true" : undefined}
                      data-framed-region-relation={framedRegionRelation ? "true" : undefined}
                      data-source-change-kind={source.changeKind ?? undefined}
                      d={leaderPath}
                    />,
                  ];
                })}
              </svg>
              {edgeLabelPlacements.map(
                ({ edge, displayLines, source, x, y, selectWidth, height, crowded, displaced }) => {
                  const changeKind = source.changeKind;
                  const fromNode = nodesById.get(edge.from);
                  const toNode = nodesById.get(edge.to);
                  const primaryBackbone = primaryBackboneEdgeIds.has(edge.id);
                  const focused = edge.from === focusId || edge.to === focusId;
                  const relationLabel = edge.directed
                    ? `${fromNode?.label ?? edge.from} から ${toNode?.label ?? edge.to} へ: ${edge.label}`
                    : `${fromNode?.label ?? edge.from} と ${toNode?.label ?? edge.to} の関係: ${edge.label}`;
                  const accessibleRelationLabel = `${relationLabel}${primaryBackbone ? " · explanation backbone relation" : ""}`;
                  const selected = edge.id === selectedEdgeId;
                  const muted = selectedEdgeId !== null && !selected;
                  const focusDistant =
                    focusId !== null &&
                    !focused &&
                    !oneHopNodeIds.has(edge.from) &&
                    !oneHopNodeIds.has(edge.to);
                  const framedRegionRelation =
                    framedRegionNodeIds.has(edge.from) && framedRegionNodeIds.has(edge.to);
                  const contextDistant = focusDistant && !framedRegionRelation;
                  return (
                    <div
                      key={`label:${edge.id}`}
                      className={`structure-edge-label${primaryBackbone ? " primary-backbone" : ""}${focused ? " focus-incident" : ""}${framedRegionRelation ? " framed-region-relation" : ""}${selected ? " selected" : ""}${contextDistant ? " context-distant" : ""}${crowded ? " crowded" : ""}${muted ? " muted" : ""}`}
                      data-edge-id={edge.id}
                      data-label-displaced={displaced ? "true" : "false"}
                      data-primary-backbone={primaryBackbone ? "true" : undefined}
                      data-framed-region-relation={framedRegionRelation ? "true" : undefined}
                      data-focus-relevance={
                        focused ? "incident" : focusDistant ? "distant" : "near"
                      }
                      data-source-anchor-count={source.anchorCount}
                      data-source-change-kind={changeKind ?? undefined}
                      style={{ left: x, top: y, minHeight: height }}
                    >
                      <button
                        type="button"
                        className={`structure-edge-select${selected ? " selected" : ""}`}
                        title={edge.label}
                        aria-label={accessibleRelationLabel}
                        aria-pressed={selected}
                        style={{ maxWidth: selectWidth }}
                        onClick={() =>
                          setSelectedEdgeId((current) => (current === edge.id ? null : edge.id))
                        }
                      >
                        <span className="structure-edge-label-text" aria-hidden="true">
                          {displayLines.map((line, index) => (
                            <Fragment key={`${edge.id}:line:${index}`}>
                              {index > 0 && <br />}
                              {line}
                            </Fragment>
                          ))}
                        </span>
                      </button>
                      <EdgeSourceAction
                        edge={edge}
                        onOpen={(locator, anchor, right) => void openSource(locator, anchor, right)}
                      />
                    </div>
                  );
                },
              )}
              {renderModel.nodes.map(({ node, point, changeKind, sourceLabel }) => {
                const selected = node.id === focusId;
                const primaryBackbone = primaryBackboneNodeIds.has(node.id);
                const presentationStart = structure.presentation?.startNodeId === node.id;
                const presentationRegion = presentationRegionByNodeId.get(node.id);
                const incidentToFocus = incident.some(
                  (edge) => edge.from === node.id || edge.to === node.id,
                );
                const focusDistant = focusId !== null && !oneHopNodeIds.has(node.id);
                const framedRegionMember = framedRegionNodeIds.has(node.id);
                const contextDistant = focusDistant && !framedRegionMember;
                return (
                  <div
                    key={node.id}
                    className={`structure-node notation-${node.notation}${node.id === structure.originNodeId ? " origin" : ""}${presentationStart ? " presentation-start" : ""}${primaryBackbone ? " primary-backbone" : ""}${framedRegionMember ? " framed-region-member" : ""}${selected ? " focused" : ""}${incidentToFocus ? " neighboring" : ""}${contextDistant ? " context-distant" : ""}${selectedEdgeNodeIds.has(node.id) ? " edge-endpoint" : ""}`}
                    data-node-id={node.id}
                    data-node-notation={node.notation}
                    data-origin-node={node.id === structure.originNodeId ? "true" : undefined}
                    data-presentation-start-node={presentationStart ? "true" : undefined}
                    data-primary-backbone={primaryBackbone ? "true" : undefined}
                    data-focus-relevance={selected ? "active" : focusDistant ? "distant" : "near"}
                    data-framed-region-member={framedRegionMember ? "true" : undefined}
                    data-region-index={presentationRegion?.index}
                    data-region-label={presentationRegion?.label}
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
                    {presentationStart && (
                      <span
                        className="structure-node-presentation-start"
                        aria-hidden="true"
                        title="Authorial start"
                      />
                    )}
                    <button
                      type="button"
                      className="structure-node-focus"
                      aria-label={`${node.label}${node.id === structure.originNodeId ? " · factual origin" : ""}${presentationStart ? " · authorial start" : ""}${primaryBackbone ? " · explanation backbone member" : ""}${presentationRegion ? ` · region R${presentationRegion.index + 1}: ${presentationRegion.label}` : ""}`}
                      aria-pressed={selected}
                      onClick={(event) => {
                        if (event.detail === 0) activateNode(node.id);
                      }}
                    >
                      {node.anchor && (
                        <SourceIdentity
                          anchor={node.anchor}
                          changeKind={changeKind}
                          sourceLabel={sourceLabel ?? node.anchor.path}
                        />
                      )}
                      <strong className="structure-node-title">
                        <span className="structure-node-title-text" title={node.label}>
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
                        onOpen={(right) =>
                          void openSource({ kind: "node", nodeId: node.id }, node.anchor!, right)
                        }
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="structure-canvas-status">
              <strong>{focusedNode?.label ?? "focusなし"}</strong>
              <span>origin · {originNode.label}</span>
              <span>
                {visible.nodeIds.size}/{structure.nodes.length} Node · {visible.edgeIds.size}/
                {structure.edges.length} Relation
              </span>
            </div>
            <StructureMiniMap
              structure={structure}
              positions={positions}
              focusedNodeId={focusId}
              framedRegionIndex={framedRegionIndex}
              viewport={viewport}
              viewportElement={surfaceRef.current}
            />
          </div>
        </section>
      </div>
    </article>
  );
}
