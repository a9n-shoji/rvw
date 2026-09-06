import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
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
  createStructureSession,
  deleteStructureSessions,
  getStructureSession,
  initialStructureViewport,
  preserveStructureLayoutScreenPosition,
  reconcileStructureSession,
  restoreStructureRegionsViewFromHistory,
  structureCameraFrameForHistoryRestore,
  scaledStructureZoom,
  setStructureSession,
  structureBackboneNodeIds,
  structureHomeNodeIds,
  structureOneHopNodeIds,
  structureRegionsViewportForHome,
  structureRegionsViewportForFit,
  structureViewportForBounds,
  structureViewportForCameraFrame,
  structureViewportForNodeIds,
  type StructureCameraBounds,
  type StructureGuideDisclosure,
  type StructureCameraFrame,
  type StructureNavigationTarget,
  type StructureRegionsViewState,
  type StructureViewMode,
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
  buildStructureRenderFoundation,
  selectStructureRenderModel,
  STRUCTURE_EDGE_ARROW_LENGTH,
  STRUCTURE_EDGE_ARROW_WIDTH,
} from "../structure-render-model.js";
import { structureSourceAnchorLabel } from "../structure-source.js";
import type { StructureReadingSnapshot } from "../reading-history.js";
import { ChangeIcon } from "./FileTree.js";
import { FileEntryIcon } from "./FileIcon.js";
import { StructureExportMenu } from "./StructureExportMenu.js";
import { StructurePresentationOverview } from "./StructurePresentationOverview.js";
import {
  buildStructureRegionCanvasModel,
  structureRegionCanvasStartBounds,
  StructureRegionCanvas,
} from "./StructureRegionCanvas.js";

const STRUCTURE_WHEEL_PAN_SENSITIVITY = 2;
const STRUCTURE_TRACKPAD_ZOOM_SENSITIVITY = 0.005;
const STRUCTURE_META_WHEEL_ZOOM_SENSITIVITY = 0.002;

function SourceButton({
  anchor,
  compact = false,
  onOpen,
}: {
  anchor: SourceAnchor;
  compact?: boolean;
  onOpen: (openInRightPane: boolean) => void;
}) {
  const label = `${structureSourceAnchorLabel(anchor)}を開く`;
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
      {!compact && <span>{structureSourceAnchorLabel(anchor)}</span>}
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
  framedRegionId,
  viewport,
  viewportElement,
}: {
  structure: Structure;
  positions: Readonly<Record<string, StructurePoint>>;
  focusedNodeId: string | null;
  framedRegionId: string | null;
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
    (structure.presentation?.regions ?? []).flatMap((region) =>
      region.nodeIds.map((nodeId) => [nodeId, region.id] as const),
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
          regionByNodeId.get(node.id) === framedRegionId ? "framed-region-member" : null,
        ].filter((value): value is string => value !== null);
        return (
          <circle
            key={node.id}
            cx={mapX(point.x + STRUCTURE_NODE_WIDTH / 2)}
            cy={mapY(point.y + STRUCTURE_NODE_HEIGHT / 2)}
            r={node.id === focusedNodeId ? 3.2 : 1.7}
            className={classes.join(" ")}
            data-region-id={regionByNodeId.get(node.id)}
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
  readingNavigationTarget = null,
  onNavigationApplied,
  onNavigationFailed,
  onOpenSource,
  onReadingNavigationApplied,
  onPushReadingHistory,
  onReadingSnapshotChanged,
  onReplaceReadingHistory,
  onBrowserBack,
  onDeleted,
}: {
  paneId: DocumentPaneId;
  pullRequestId: string;
  structure: Structure;
  changedFiles: readonly ChangedFile[];
  navigationTarget?: StructureNavigationTarget | null;
  readingNavigationTarget?: {
    structureId: string;
    pane: DocumentPaneId;
    snapshot: StructureReadingSnapshot;
    requestId: number;
  } | null;
  onNavigationApplied: (requestId: number) => void;
  onNavigationFailed: (requestId: number) => void;
  onOpenSource: (
    locator: StructureSourceLocator,
    openInRightPane: boolean,
  ) => Promise<string | null>;
  onReadingNavigationApplied: (requestId: number) => void;
  onPushReadingHistory: (
    source: StructureReadingSnapshot,
    destination: StructureReadingSnapshot,
  ) => void;
  onReadingSnapshotChanged: (snapshot: StructureReadingSnapshot) => void;
  onReplaceReadingHistory: (snapshot: StructureReadingSnapshot) => void;
  onBrowserBack: () => void;
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
  const [viewMode, setViewMode] = useState<StructureViewMode>(initial.viewMode);
  const [focusId, setFocusId] = useState(initial.focusId);
  const [selectedEdgeId, setSelectedEdgeId] = useState(initial.selectedEdgeId);
  const [depth, setDepth] = useState<StructureNeighborhoodDepth>(initial.depth);
  const [framedRegionId, setFramedRegionId] = useState(initial.framedRegionId);
  const [positions, setPositions] = useState(initial.positions);
  const [viewport, setViewport] = useState(initial.viewport);
  const [regionsView, setRegionsView] = useState(initial.regionsView);
  const [guideDisclosure, setGuideDisclosure] = useState(initial.guideDisclosure);
  const [cameraAnimating, setCameraAnimating] = useState(false);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const [status, setStatus] = useState<string | null>(null);
  const [exporting, setExporting] = useState<StructureExportFormat | null>(null);
  const [deleting, setDeleting] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const regionsSurfaceRef = useRef<HTMLDivElement>(null);
  const graphModeButtonRef = useRef<HTMLButtonElement>(null);
  const surfaceSizeRef = useRef(initial.surfaceSize);
  const viewModeRef = useRef(viewMode);
  const focusIdRef = useRef(focusId);
  const selectedEdgeIdRef = useRef(selectedEdgeId);
  const depthRef = useRef(depth);
  const framedRegionIdRef = useRef(framedRegionId);
  const positionsRef = useRef(positions);
  const viewportRef = useRef(viewport);
  const regionsViewRef = useRef(regionsView);
  const cameraFrameIntentRef = useRef<StructureCameraFrame | null>(initial.cameraFrame ?? null);
  const regionFrameBoundsRef = useRef<ReadonlyMap<string, StructureCameraBounds>>(new Map());
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
  const appliedReadingNavigationRequestRef = useRef<number | null>(null);
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const regionsPanRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    nodeId: string;
    focusTarget: HTMLButtonElement | null;
    x: number;
    y: number;
    distance: number;
  } | null>(null);
  const measureSurfaceSize = useCallback((): { width: number; height: number } => {
    const surface = surfaceRef.current;
    const measured = surface
      ? { width: surface.clientWidth, height: surface.clientHeight }
      : { width: 0, height: 0 };
    if (measured.width > 0 && measured.height > 0) {
      surfaceSizeRef.current = measured;
      return measured;
    }
    return surfaceSizeRef.current;
  }, []);
  const regionCanvasModel = useMemo(() => buildStructureRegionCanvasModel(structure), [structure]);
  const updateRegionsView = useCallback(
    (update: (current: StructureRegionsViewState) => StructureRegionsViewState): void => {
      setRegionsView((current) => {
        const next = update(current);
        regionsViewRef.current = next;
        return next;
      });
    },
    [],
  );
  const projectedRegionsViewport = useCallback(
    (
      cameraMode: Exclude<StructureRegionsViewState["cameraMode"], "manual">,
      nextSurfaceSize: { width: number; height: number },
    ): StructureViewport | null => {
      if (!regionCanvasModel) return null;
      const input = {
        contentSize: { width: regionCanvasModel.width, height: regionCanvasModel.height },
        surfaceSize: nextSurfaceSize,
      };
      return cameraMode === "fit"
        ? structureRegionsViewportForFit(input)
        : structureRegionsViewportForHome({
            ...input,
            attentionBounds: structureRegionCanvasStartBounds(structure, regionCanvasModel),
          });
    },
    [regionCanvasModel, structure],
  );
  viewModeRef.current = viewMode;
  focusIdRef.current = focusId;
  selectedEdgeIdRef.current = selectedEdgeId;
  depthRef.current = depth;
  framedRegionIdRef.current = framedRegionId;
  positionsRef.current = positions;
  viewportRef.current = viewport;
  regionsViewRef.current = regionsView;
  sessionStateRef.current = {
    viewMode,
    focusId,
    selectedEdgeId,
    depth,
    framedRegionId,
    cameraFrame: cameraFrameIntentRef.current,
    positions,
    viewport,
    surfaceSize: surfaceSizeRef.current,
    regionsView,
    guideDisclosure,
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
      const frameIntent = cameraFrameIntentRef.current;
      if (frameIntent) {
        const reframed = structureViewportForCameraFrame({
          frame: frameIntent,
          positions: positionsRef.current,
          regionBounds: regionFrameBoundsRef.current,
          surfaceSize: next,
        });
        if (reframed) {
          viewportRef.current = reframed;
          setViewport(reframed);
          return;
        }
      }
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
        viewportRef.current = resized;
        return resized;
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const surface = regionsSurfaceRef.current;
    if (viewMode !== "regions" || !surface || !regionCanvasModel) return;
    const update = (): void => {
      const nextSurfaceSize = { width: surface.clientWidth, height: surface.clientHeight };
      if (nextSurfaceSize.width === 0 || nextSurfaceSize.height === 0) return;
      updateRegionsView((current) => {
        const previousSurfaceSize = current.surfaceSize;
        const shouldProject =
          current.cameraMode !== "manual" ||
          previousSurfaceSize.width === 0 ||
          previousSurfaceSize.height === 0;
        const projectionMode = current.cameraMode === "fit" ? "fit" : "home";
        const viewport = shouldProject
          ? (projectedRegionsViewport(projectionMode, nextSurfaceSize) ?? current.viewport)
          : {
              ...current.viewport,
              x: current.viewport.x + (nextSurfaceSize.width - previousSurfaceSize.width) / 2,
              y: current.viewport.y + (nextSurfaceSize.height - previousSurfaceSize.height) / 2,
            };
        if (
          previousSurfaceSize.width === nextSurfaceSize.width &&
          previousSurfaceSize.height === nextSurfaceSize.height &&
          viewport.x === current.viewport.x &&
          viewport.y === current.viewport.y &&
          viewport.scale === current.viewport.scale
        ) {
          return current;
        }
        return { ...current, viewport, surfaceSize: nextSurfaceSize };
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [
    projectedRegionsViewport,
    regionsView.cameraMode,
    regionsView.layoutBasisKey,
    updateRegionsView,
    viewMode,
  ]);

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
      cameraFrameIntentRef.current = null;
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
    const surface = regionsSurfaceRef.current;
    if (viewMode !== "regions" || !surface) return;
    const handleWheel = (event: WheelEvent): void => {
      const wantsCanvasZoom = event.ctrlKey || event.metaKey;
      if (!wantsCanvasZoom && event.target instanceof Element) {
        const cardSummary = event.target.closest<HTMLElement>(".structure-region-map-card-summary");
        const mostlyVertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
        const canScrollVertically = cardSummary
          ? event.deltaY < 0
            ? cardSummary.scrollTop > 0
            : event.deltaY > 0
              ? cardSummary.scrollTop + cardSummary.clientHeight < cardSummary.scrollHeight - 1
              : false
          : false;
        if (mostlyVertical && canScrollVertically) return;
      }
      event.preventDefault();
      event.stopPropagation();
      const deltaUnit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? Math.max(1, surface.clientHeight)
            : 1;
      if (!wantsCanvasZoom) {
        updateRegionsView((current) => ({
          ...current,
          cameraMode: "manual",
          viewport: {
            ...current.viewport,
            x: current.viewport.x - event.deltaX * deltaUnit * STRUCTURE_WHEEL_PAN_SENSITIVITY,
            y: current.viewport.y - event.deltaY * deltaUnit * STRUCTURE_WHEEL_PAN_SENSITIVITY,
          },
        }));
        return;
      }
      const rectangle = surface.getBoundingClientRect();
      const pointerX = event.clientX - rectangle.left;
      const pointerY = event.clientY - rectangle.top;
      updateRegionsView((current) => {
        const sensitivity =
          event.ctrlKey && !event.metaKey
            ? STRUCTURE_TRACKPAD_ZOOM_SENSITIVITY
            : STRUCTURE_META_WHEEL_ZOOM_SENSITIVITY;
        const nextScale = scaledStructureZoom(
          current.viewport.scale,
          Math.exp(-event.deltaY * deltaUnit * sensitivity),
        );
        const worldX = (pointerX - current.viewport.x) / current.viewport.scale;
        const worldY = (pointerY - current.viewport.y) / current.viewport.scale;
        return {
          ...current,
          cameraMode: "manual",
          viewport: {
            scale: nextScale,
            x: pointerX - worldX * nextScale,
            y: pointerY - worldY * nextScale,
          },
        };
      });
    };
    surface.addEventListener("wheel", handleWheel, { passive: false });
    return () => surface.removeEventListener("wheel", handleWheel);
  }, [updateRegionsView, viewMode]);

  useEffect(() => {
    const previous = sessionStateRef.current;
    const next = reconcileStructureSession(structure, previous);
    if (
      previous.updatedAt === next.updatedAt &&
      previous.layoutBasisKey === next.layoutBasisKey &&
      previous.regionsView.layoutBasisKey === next.regionsView.layoutBasisKey
    ) {
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
    cameraFrameIntentRef.current = next.cameraFrame;
    sessionStateRef.current = next;
    viewModeRef.current = next.viewMode;
    focusIdRef.current = next.focusId;
    depthRef.current = next.depth;
    framedRegionIdRef.current = next.framedRegionId;
    positionsRef.current = next.positions;
    viewportRef.current = next.viewport;
    regionsViewRef.current = next.regionsView;
    setViewMode(next.viewMode);
    setFocusId(next.focusId);
    setSelectedEdgeId(next.selectedEdgeId);
    setDepth(next.depth);
    setFramedRegionId(next.framedRegionId);
    setPositions(next.positions);
    setViewport(next.viewport);
    setRegionsView(next.regionsView);
    setGuideDisclosure(next.guideDisclosure);
  }, [structure]);

  useEffect(() => {
    setStructureSession(paneId, structure.id, sessionStateRef.current);
  }, [
    depth,
    focusId,
    framedRegionId,
    guideDisclosure,
    positions,
    paneId,
    selectedEdgeId,
    structure.id,
    structure.updatedAt,
    surfaceSize,
    regionsView,
    viewMode,
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
  const hasRegions = (structure.presentation?.regions.length ?? 0) > 0;
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
  const renderFoundation = useMemo(
    () =>
      buildStructureRenderFoundation({
        structure,
        positions,
        sourceChangeKinds,
        labelAccessory: "source-actions",
        edgeLabelMode: "viewer-adaptive",
      }),
    [positions, sourceChangeKinds, structure],
  );
  const renderModel = useMemo(
    () =>
      selectStructureRenderModel(renderFoundation, {
        nodeIds: visible.nodeIds,
        edgeIds: visible.edgeIds,
        labelEdgeIds,
      }),
    [labelEdgeIds, renderFoundation, visible.edgeIds, visible.nodeIds],
  );
  const regionFrameBounds = useMemo<ReadonlyMap<string, StructureCameraBounds>>(
    () =>
      new Map(
        (renderModel.presentation?.regions ?? []).map(
          (region) => [region.id, region.bounds] as const,
        ),
      ),
    [renderModel.presentation?.regions],
  );
  regionFrameBoundsRef.current = regionFrameBounds;
  const renderedEdges = renderModel.edges.map(({ edge }) => edge);
  const renderedNodes = renderModel.nodes.map(({ node }) => node);
  const edgeLabelPlacements = renderModel.labels;
  const presentationRegionByNodeId = useMemo(
    () =>
      new Map(
        (structure.presentation?.regions ?? []).flatMap((region) =>
          region.nodeIds.map(
            (nodeId) =>
              [nodeId, { id: region.id, label: region.label, summary: region.summary }] as const,
          ),
        ),
      ),
    [structure.presentation],
  );
  const framedRegion = useMemo(
    () =>
      framedRegionId === null
        ? null
        : (structure.presentation?.regions.find((region) => region.id === framedRegionId) ?? null),
    [framedRegionId, structure.presentation],
  );
  const framedRegionNodeIds = useMemo(() => new Set(framedRegion?.nodeIds ?? []), [framedRegion]);
  const framedRegionInternalEdgeCount = useMemo(
    () =>
      framedRegion === null
        ? 0
        : structure.edges.filter(
            (edge) => framedRegionNodeIds.has(edge.from) && framedRegionNodeIds.has(edge.to),
          ).length,
    [framedRegion, framedRegionNodeIds, structure.edges],
  );
  const displayBounds = renderModel.bounds;
  const worldWidth = Math.max(1_200, (displayBounds?.right ?? 1_000) + 180);
  const worldHeight = Math.max(800, (displayBounds?.bottom ?? 600) + 180);

  useLayoutEffect(() => {
    const frameIntent = cameraFrameIntentRef.current;
    if (frameIntent?.kind !== "region" || dragRef.current !== null) return;
    const reframed = structureViewportForCameraFrame({
      frame: frameIntent,
      positions,
      regionBounds: regionFrameBounds,
      surfaceSize,
    });
    if (!reframed) return;
    viewportRef.current = reframed;
    setViewport(reframed);
  }, [positions, regionFrameBounds, surfaceSize]);

  const fittedViewport = (): StructureViewport | null => {
    const measuredSurfaceSize = measureSurfaceSize();
    if (!displayBounds || measuredSurfaceSize.width === 0 || measuredSurfaceSize.height === 0) {
      return null;
    }
    return structureViewportForBounds({ bounds: displayBounds, surfaceSize: measuredSurfaceSize });
  };

  const fitVisible = (): void => {
    const fitted = fittedViewport();
    if (!fitted) return;
    if (displayBounds) {
      cameraFrameIntentRef.current = { kind: "bounds", bounds: displayBounds };
    }
    viewportRef.current = fitted;
    setViewport(fitted);
  };

  useLayoutEffect(() => {
    const action = pendingViewportActionRef.current;
    if (!action || !displayBounds || surfaceSize.width === 0 || surfaceSize.height === 0) return;
    pendingViewportActionRef.current = null;
    const homeNodeIds = [...structureHomeNodeIds(structure)];
    const frameIntent: StructureCameraFrame = { kind: "nodes", nodeIds: homeNodeIds };
    const nextViewport =
      structureViewportForNodeIds({ nodeIds: homeNodeIds, positions, surfaceSize }) ??
      initialStructureViewport({ structure, positions, surfaceSize });
    cameraFrameIntentRef.current = frameIntent;
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
  }, [displayBounds, positions, structure, surfaceSize]);

  const centerNode = useCallback(
    (nodeId: string, scale?: number): void => {
      const point = positions[nodeId];
      if (!point) return;
      const measuredSurfaceSize = measureSurfaceSize();
      const targetScale = scale ?? viewportRef.current.scale;
      cameraFrameIntentRef.current = { kind: "center-node", nodeId, scale: targetScale };
      const nextViewport = {
        scale: targetScale,
        x: measuredSurfaceSize.width / 2 - (point.x + STRUCTURE_NODE_WIDTH / 2) * targetScale,
        y: measuredSurfaceSize.height / 2 - (point.y + STRUCTURE_NODE_HEIGHT / 2) * targetScale,
      };
      viewportRef.current = nextViewport;
      setViewport(nextViewport);
    },
    [measureSurfaceSize, positions],
  );

  const animateCameraTo = useCallback(
    (nextViewport: StructureViewport, frameIntent: StructureCameraFrame | null = null): void => {
      if (cameraAnimationTimerRef.current) clearTimeout(cameraAnimationTimerRef.current);
      cameraFrameIntentRef.current = frameIntent;
      setCameraAnimating(true);
      viewportRef.current = nextViewport;
      setViewport(nextViewport);
      cameraAnimationTimerRef.current = setTimeout(() => {
        cameraAnimationTimerRef.current = null;
        setCameraAnimating(false);
      }, 220);
    },
    [],
  );

  const captureReadingSnapshot = useCallback(
    (overrides: Partial<StructureReadingSnapshot> = {}): StructureReadingSnapshot => ({
      artifactUpdatedAt: structure.updatedAt,
      viewMode: viewModeRef.current,
      focusId: focusIdRef.current,
      selectedEdgeId: selectedEdgeIdRef.current,
      depth: depthRef.current,
      framedRegionId: framedRegionIdRef.current,
      cameraFrame: cameraFrameIntentRef.current,
      viewport: viewportRef.current,
      surfaceSize: surfaceSizeRef.current,
      regionsViewport: regionsViewRef.current.viewport,
      regionsSurfaceSize: regionsViewRef.current.surfaceSize,
      regionsCameraMode: regionsViewRef.current.cameraMode,
      layoutBasisKey: sessionStateRef.current.layoutBasisKey,
      positionsKey: JSON.stringify(
        Object.entries(positionsRef.current).sort(([left], [right]) =>
          left.localeCompare(right, "en"),
        ),
      ),
      regionsLayoutBasisKey: regionsViewRef.current.layoutBasisKey,
      ...overrides,
    }),
    [structure.updatedAt],
  );

  const pushReadingCheckpoint = useCallback(
    (source: StructureReadingSnapshot): void => {
      const destination = captureReadingSnapshot();
      if (JSON.stringify(source) === JSON.stringify(destination)) return;
      onPushReadingHistory(source, destination);
    },
    [captureReadingSnapshot, onPushReadingHistory],
  );

  useLayoutEffect(() => {
    const snapshot = captureReadingSnapshot();
    onReadingSnapshotChanged(snapshot);
  }, [
    captureReadingSnapshot,
    depth,
    focusId,
    framedRegionId,
    onReadingSnapshotChanged,
    positions,
    regionsView,
    selectedEdgeId,
    viewMode,
    viewport,
  ]);

  useEffect(() => {
    const snapshot = captureReadingSnapshot();
    const timeout = window.setTimeout(() => onReplaceReadingHistory(snapshot), 150);
    return () => window.clearTimeout(timeout);
  }, [
    captureReadingSnapshot,
    depth,
    focusId,
    framedRegionId,
    onReplaceReadingHistory,
    positions,
    regionsView,
    selectedEdgeId,
    viewMode,
    viewport,
  ]);

  const activateNode = useCallback(
    (nodeId: string, recordHistory = true): void => {
      if (!positions[nodeId]) return;
      const readingSource = recordHistory ? captureReadingSnapshot() : null;
      const measuredSurfaceSize = measureSurfaceSize();
      const framedNodeIds = [...structureOneHopNodeIds(structure, [nodeId])];
      const nextCameraFrame: StructureCameraFrame = {
        kind: "nodes",
        nodeIds: framedNodeIds,
      };
      const nextViewport = structureViewportForNodeIds({
        nodeIds: framedNodeIds,
        positions,
        surfaceSize: measuredSurfaceSize,
      });
      const initializing = pendingViewportActionRef.current === "initial";
      pendingViewportActionRef.current = null;
      selectedEdgeIdRef.current = null;
      setSelectedEdgeId(null);
      viewModeRef.current = "graph";
      setViewMode("graph");
      framedRegionIdRef.current = null;
      setFramedRegionId(null);
      focusIdRef.current = nodeId;
      setFocusId(nodeId);
      if (nextViewport) {
        animateCameraTo(nextViewport, nextCameraFrame);
      }
      if (readingSource && !initializing) pushReadingCheckpoint(readingSource);
    },
    [
      animateCameraTo,
      captureReadingSnapshot,
      measureSurfaceSize,
      positions,
      pushReadingCheckpoint,
      structure,
    ],
  );

  const navigateHome = (): void => {
    const readingSource = captureReadingSnapshot();
    const homeFocusId = structure.presentation?.startNodeId ?? structure.originNodeId;
    const homeNodeIds = [...structureHomeNodeIds(structure)];
    const nextCameraFrame: StructureCameraFrame = { kind: "nodes", nodeIds: homeNodeIds };
    const nextViewport = structureViewportForNodeIds({
      nodeIds: homeNodeIds,
      positions,
      surfaceSize: measureSurfaceSize(),
    });
    const initializing = pendingViewportActionRef.current === "initial";
    pendingViewportActionRef.current = null;
    selectedEdgeIdRef.current = null;
    setSelectedEdgeId(null);
    viewModeRef.current = "graph";
    setViewMode("graph");
    framedRegionIdRef.current = null;
    setFramedRegionId(null);
    focusIdRef.current = homeFocusId;
    setFocusId(homeFocusId);
    depthRef.current = "all";
    setDepth("all");
    if (nextViewport) {
      animateCameraTo(nextViewport, nextCameraFrame);
    }
    if (!initializing) pushReadingCheckpoint(readingSource);
  };

  const navigateBack = (): void => {
    onReplaceReadingHistory(captureReadingSnapshot());
    onBrowserBack();
  };

  const frameRegion = (regionId: string): void => {
    const regions = structure.presentation?.regions ?? [];
    const regionIndex = regions.findIndex((candidate) => candidate.id === regionId);
    if (regionIndex < 0) return;
    const region = regions[regionIndex]!;

    const renderRegion = renderModel.presentation?.regions.find(
      (candidate) => candidate.id === regionId,
    );
    const measuredSurfaceSize = measureSurfaceSize();
    const frameIntent: StructureCameraFrame = { kind: "region", regionId: region.id };
    const nextViewport = renderRegion
      ? structureViewportForBounds({
          bounds: renderRegion.bounds,
          surfaceSize: measuredSurfaceSize,
        })
      : structureViewportForNodeIds({
          nodeIds: region.nodeIds,
          positions,
          surfaceSize: measuredSurfaceSize,
        });
    if (!nextViewport) return;
    const readingSource = captureReadingSnapshot();
    const initializing = pendingViewportActionRef.current === "initial";
    pendingViewportActionRef.current = null;
    depthRef.current = "all";
    setDepth("all");
    framedRegionIdRef.current = region.id;
    setFramedRegionId(region.id);
    viewModeRef.current = "graph";
    setViewMode("graph");
    animateCameraTo(nextViewport, frameIntent);
    if (!initializing) pushReadingCheckpoint(readingSource);
    setStatus(`${region.label} RegionをGraphで表示しました。`);
    requestAnimationFrame(() => graphModeButtonRef.current?.focus());
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
    selectedEdgeIdRef.current = null;
    setSelectedEdgeId(null);
    viewModeRef.current = "graph";
    setViewMode("graph");
    framedRegionIdRef.current = null;
    setFramedRegionId(null);
    focusIdRef.current = requestedNode.id;
    setFocusId(requestedNode.id);
    centerNode(requestedNode.id);
    const readingSnapshot = captureReadingSnapshot();
    onReadingSnapshotChanged(readingSnapshot);
    onReplaceReadingHistory(readingSnapshot);
    appliedNavigationRequestRef.current = navigationTarget.requestId;
    onNavigationApplied(navigationTarget.requestId);
  }, [
    captureReadingSnapshot,
    centerNode,
    navigationTarget,
    onNavigationApplied,
    onNavigationFailed,
    onReadingSnapshotChanged,
    onReplaceReadingHistory,
    paneId,
    positions,
    structure.id,
    structure.nodes,
    surfaceSize.height,
    surfaceSize.width,
  ]);

  useLayoutEffect(() => {
    if (
      !readingNavigationTarget ||
      readingNavigationTarget.structureId !== structure.id ||
      readingNavigationTarget.pane !== paneId ||
      appliedReadingNavigationRequestRef.current === readingNavigationTarget.requestId ||
      surfaceSize.width === 0 ||
      surfaceSize.height === 0
    ) {
      return;
    }
    const snapshot = readingNavigationTarget.snapshot;
    const current = sessionStateRef.current;
    const reconciled = reconcileStructureSession(structure, {
      ...current,
      viewMode: snapshot.viewMode,
      focusId: snapshot.focusId,
      selectedEdgeId: snapshot.selectedEdgeId,
      depth: snapshot.depth,
      framedRegionId: snapshot.framedRegionId,
      cameraFrame: snapshot.cameraFrame,
    });
    const currentPositionsKey = JSON.stringify(
      Object.entries(positionsRef.current).sort(([left], [right]) =>
        left.localeCompare(right, "en"),
      ),
    );
    const geometryMatches =
      snapshot.layoutBasisKey === current.layoutBasisKey &&
      snapshot.positionsKey === currentPositionsKey;
    const restoredCameraFrame = structureCameraFrameForHistoryRestore({
      frame: reconciled.cameraFrame,
      snapshotArtifactUpdatedAt: snapshot.artifactUpdatedAt,
      currentArtifactUpdatedAt: structure.updatedAt,
      geometryMatches,
    });
    const droppedDerivedBounds =
      reconciled.cameraFrame?.kind === "bounds" && restoredCameraFrame === null;
    const measuredGraphSurface = measureSurfaceSize();
    const rawViewport = {
      ...snapshot.viewport,
      x: snapshot.viewport.x + (measuredGraphSurface.width - snapshot.surfaceSize.width) / 2,
      y: snapshot.viewport.y + (measuredGraphSurface.height - snapshot.surfaceSize.height) / 2,
    };
    const restoredViewport = restoredCameraFrame
      ? (structureViewportForCameraFrame({
          frame: restoredCameraFrame,
          positions: positionsRef.current,
          regionBounds: regionFrameBoundsRef.current,
          surfaceSize: measuredGraphSurface,
        }) ?? (geometryMatches ? rawViewport : current.viewport))
      : geometryMatches && !droppedDerivedBounds
        ? rawViewport
        : current.viewport;
    const regionsBasisMatches =
      snapshot.regionsLayoutBasisKey === regionsViewRef.current.layoutBasisKey;
    const restoredRegionsView = regionsBasisMatches
      ? restoreStructureRegionsViewFromHistory(
          regionsViewRef.current,
          {
            regionsViewport: snapshot.regionsViewport,
            regionsSurfaceSize: snapshot.regionsSurfaceSize,
            regionsCameraMode: snapshot.regionsCameraMode,
          },
          regionsViewRef.current.surfaceSize,
        )
      : regionsViewRef.current;

    pendingViewportActionRef.current = null;
    setStatus(null);
    viewModeRef.current = reconciled.viewMode;
    setViewMode(reconciled.viewMode);
    focusIdRef.current = reconciled.focusId;
    setFocusId(reconciled.focusId);
    selectedEdgeIdRef.current = reconciled.selectedEdgeId;
    setSelectedEdgeId(reconciled.selectedEdgeId);
    depthRef.current = reconciled.depth;
    setDepth(reconciled.depth);
    framedRegionIdRef.current = reconciled.framedRegionId;
    setFramedRegionId(reconciled.framedRegionId);
    cameraFrameIntentRef.current = restoredCameraFrame;
    viewportRef.current = restoredViewport;
    setViewport(restoredViewport);
    regionsViewRef.current = restoredRegionsView;
    setRegionsView(restoredRegionsView);
    appliedReadingNavigationRequestRef.current = readingNavigationTarget.requestId;
    onReadingNavigationApplied(readingNavigationTarget.requestId);
  }, [
    measureSurfaceSize,
    onReadingNavigationApplied,
    paneId,
    readingNavigationTarget,
    structure,
    surfaceSize.height,
    surfaceSize.width,
  ]);

  const centerFocus = (): void => {
    if (focusId) centerNode(focusId);
  };

  const resetLayout = (): void => {
    cameraFrameIntentRef.current = null;
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
    cameraFrameIntentRef.current = null;
    selectedEdgeIdRef.current = null;
    setSelectedEdgeId(null);
    focusIdRef.current = null;
    setFocusId(null);
    depthRef.current = "all";
    setDepth("all");
    framedRegionIdRef.current = null;
    setFramedRegionId(null);
  };

  const selectDepth = (nextDepth: StructureNeighborhoodDepth): void => {
    if (nextDepth === depth) return;
    cameraFrameIntentRef.current = null;
    depthRef.current = nextDepth;
    setDepth(nextDepth);
    framedRegionIdRef.current = null;
    setFramedRegionId(null);
    const snapshot = captureReadingSnapshot();
    onReadingSnapshotChanged(snapshot);
    onReplaceReadingHistory(snapshot);
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
    cameraFrameIntentRef.current = null;
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

  const fitRegions = (): void => {
    const surface = regionsSurfaceRef.current;
    const nextSurfaceSize = surface
      ? { width: surface.clientWidth, height: surface.clientHeight }
      : regionsViewRef.current.surfaceSize;
    const nextViewport = projectedRegionsViewport("fit", nextSurfaceSize);
    if (!nextViewport) return;
    updateRegionsView((current) => ({
      ...current,
      viewport: nextViewport,
      surfaceSize: nextSurfaceSize,
      cameraMode: "fit",
    }));
  };

  const resetRegionsView = (): void => {
    const surface = regionsSurfaceRef.current;
    const nextSurfaceSize = surface
      ? { width: surface.clientWidth, height: surface.clientHeight }
      : regionsViewRef.current.surfaceSize;
    const nextViewport = projectedRegionsViewport("home", nextSurfaceSize);
    if (!nextViewport) return;
    updateRegionsView((current) => ({
      ...current,
      viewport: nextViewport,
      surfaceSize: nextSurfaceSize,
      cameraMode: "home",
    }));
  };

  const zoomRegionsAtCenter = (factor: number): void => {
    const surface = regionsSurfaceRef.current;
    const size = surface
      ? { width: surface.clientWidth, height: surface.clientHeight }
      : regionsViewRef.current.surfaceSize;
    updateRegionsView((current) => {
      const nextScale = scaledStructureZoom(current.viewport.scale, factor);
      const centerX = size.width / 2;
      const centerY = size.height / 2;
      const worldX = (centerX - current.viewport.x) / current.viewport.scale;
      const worldY = (centerY - current.viewport.y) / current.viewport.scale;
      return {
        ...current,
        cameraMode: "manual",
        viewport: {
          scale: nextScale,
          x: centerX - worldX * nextScale,
          y: centerY - worldY * nextScale,
        },
      };
    });
  };

  const openSource = async (
    locator: StructureSourceLocator,
    anchor: SourceAnchor,
    openInRightPane: boolean,
  ): Promise<void> => {
    setStatus(null);
    const readingSnapshot = captureReadingSnapshot();
    onReadingSnapshotChanged(readingSnapshot);
    onReplaceReadingHistory(readingSnapshot);
    try {
      const nextStatus = await onOpenSource(locator, openInRightPane);
      setStatus(nextStatus);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `参照先を開けません · ${anchor.path}`);
    }
  };

  const openContextInGraph = (requestedNodeIds: readonly string[]): void => {
    const currentNodeIds = new Set(structure.nodes.map((node) => node.id));
    const nodeIds = requestedNodeIds.filter((nodeId) => currentNodeIds.has(nodeId));
    if (nodeIds.length === 0) return;
    const measuredSurfaceSize = measureSurfaceSize();
    const frameIntent: StructureCameraFrame = { kind: "nodes", nodeIds };
    const nextViewport = structureViewportForNodeIds({
      nodeIds,
      positions,
      surfaceSize: measuredSurfaceSize,
    });
    if (!nextViewport) return;
    const readingSource = captureReadingSnapshot();
    selectedEdgeIdRef.current = null;
    setSelectedEdgeId(null);
    depthRef.current = "all";
    setDepth("all");
    framedRegionIdRef.current = null;
    setFramedRegionId(null);
    viewModeRef.current = "graph";
    setViewMode("graph");
    animateCameraTo(nextViewport, frameIntent);
    pushReadingCheckpoint(readingSource);
    setStatus(`Context componentのexact ${nodeIds.length} NodeをGraphで表示しました。`);
    requestAnimationFrame(() => graphModeButtonRef.current?.focus());
  };

  const openExactEdgeInGraph = (edgeId: string): void => {
    const edge = structure.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) return;
    const nodeIds = [...new Set([edge.from, edge.to])];
    const measuredSurfaceSize = measureSurfaceSize();
    const frameIntent: StructureCameraFrame = { kind: "nodes", nodeIds };
    const nextViewport = structureViewportForNodeIds({
      nodeIds,
      positions,
      surfaceSize: measuredSurfaceSize,
    });
    if (!nextViewport) return;
    const readingSource = captureReadingSnapshot();
    selectedEdgeIdRef.current = edge.id;
    setSelectedEdgeId(edge.id);
    depthRef.current = "all";
    setDepth("all");
    framedRegionIdRef.current = null;
    setFramedRegionId(null);
    viewModeRef.current = "graph";
    setViewMode("graph");
    animateCameraTo(nextViewport, frameIntent);
    pushReadingCheckpoint(readingSource);
    setStatus(`exact Edge「${edge.label}」をGraphで選択しました。`);
    requestAnimationFrame(() => graphModeButtonRef.current?.focus());
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
      const nextDistance =
        drag.distance + Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
      if (nextDistance >= 4) cameraFrameIntentRef.current = null;
      dragRef.current = {
        ...drag,
        x: event.clientX,
        y: event.clientY,
        distance: nextDistance,
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
        drag.focusTarget?.focus({ preventScroll: true });
        activateNode(drag.nodeId);
      }
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const moveRegionsPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = regionsPanRef.current;
    if (pan?.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - pan.x;
    const deltaY = event.clientY - pan.y;
    regionsPanRef.current = { ...pan, x: event.clientX, y: event.clientY };
    updateRegionsView((current) => ({
      ...current,
      cameraMode: "manual",
      viewport: {
        ...current.viewport,
        x: current.viewport.x + deltaX,
        y: current.viewport.y + deltaY,
      },
    }));
  };

  const stopRegionsPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (regionsPanRef.current?.pointerId === event.pointerId) regionsPanRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const revealFocusedRegion = (event: ReactFocusEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof HTMLElement)) return;
    const card = event.target.closest<HTMLElement>(
      ".structure-region-map-card, .structure-region-context-card, .structure-region-map-relation-action",
    );
    const surface = regionsSurfaceRef.current;
    if (!card || !surface) return;
    const surfaceBox = surface.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    const padding = 16;
    let deltaX = 0;
    let deltaY = 0;
    if (cardBox.left < surfaceBox.left + padding) {
      deltaX = surfaceBox.left + padding - cardBox.left;
    } else if (cardBox.right > surfaceBox.right - padding) {
      deltaX = surfaceBox.right - padding - cardBox.right;
    }
    if (cardBox.top < surfaceBox.top + padding) {
      deltaY = surfaceBox.top + padding - cardBox.top;
    } else if (cardBox.bottom > surfaceBox.bottom - padding) {
      deltaY = surfaceBox.bottom - padding - cardBox.bottom;
    }
    if (deltaX === 0 && deltaY === 0) return;
    updateRegionsView((current) => ({
      ...current,
      cameraMode: "manual",
      viewport: {
        ...current.viewport,
        x: current.viewport.x + deltaX,
        y: current.viewport.y + deltaY,
      },
    }));
  };

  return (
    <article
      className="structure-viewer"
      data-structure-id={structure.id}
      data-visible-node-count={viewMode === "graph" ? visible.nodeIds.size : undefined}
      data-total-node-count={viewMode === "graph" ? structure.nodes.length : undefined}
      data-visible-edge-count={viewMode === "graph" ? visible.edgeIds.size : undefined}
      data-total-edge-count={viewMode === "graph" ? structure.edges.length : undefined}
      data-rendered-node-count={viewMode === "graph" ? renderedNodes.length : undefined}
      data-rendered-edge-count={viewMode === "graph" ? renderedEdges.length : undefined}
      data-has-presentation={structure.presentation ? "true" : undefined}
      data-view-mode={viewMode}
      data-viewport-scale={viewMode === "graph" ? viewport.scale.toFixed(3) : undefined}
      data-regions-viewport-scale={
        viewMode === "regions" ? regionsView.viewport.scale.toFixed(3) : undefined
      }
      data-regions-camera-mode={viewMode === "regions" ? regionsView.cameraMode : undefined}
      data-semantic-zoom={
        viewMode === "graph" ? (viewport.scale < 0.42 ? "overview" : "detail") : undefined
      }
      data-framed-region-id={framedRegionId ?? undefined}
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
        disclosure={guideDisclosure}
        onToggleDisclosure={(section: keyof StructureGuideDisclosure) =>
          setGuideDisclosure((current) => ({ ...current, [section]: !current[section] }))
        }
        onFocusNode={activateNode}
      />
      <div className="structure-body">
        <div className="structure-toolbar" aria-label="Structure表示操作">
          <div
            className="structure-toolbar-group structure-view-mode"
            role="group"
            aria-label="Structure表示モード"
          >
            <button
              ref={graphModeButtonRef}
              type="button"
              className={viewMode === "graph" ? "active" : ""}
              aria-pressed={viewMode === "graph"}
              onClick={() => {
                viewModeRef.current = "graph";
                setViewMode("graph");
                const snapshot = captureReadingSnapshot();
                onReadingSnapshotChanged(snapshot);
                onReplaceReadingHistory(snapshot);
              }}
            >
              Graph
            </button>
            <button
              type="button"
              className={viewMode === "regions" ? "active" : ""}
              aria-pressed={viewMode === "regions"}
              disabled={!hasRegions}
              title={
                hasRegions
                  ? "責務chunkと直接のfactual relationを表示"
                  : "このStructureにはRegionがありません"
              }
              onClick={() => {
                viewModeRef.current = "regions";
                setViewMode("regions");
                const snapshot = captureReadingSnapshot();
                onReadingSnapshotChanged(snapshot);
                onReplaceReadingHistory(snapshot);
              }}
            >
              Regions
            </button>
          </div>
          <div className="structure-toolbar-group" role="group" aria-label="Structure内navigation">
            <button
              type="button"
              aria-label="Back"
              title="ブラウザの一つ前のreading destinationへ戻る"
              onClick={navigateBack}
            >
              Back
            </button>
            <button
              type="button"
              aria-label="Home"
              title="説明のstartと1-hopを表示"
              onClick={navigateHome}
            >
              Home
            </button>
          </div>
          <div
            className="structure-toolbar-group"
            role="group"
            aria-label="近傍の深さ"
            hidden={viewMode !== "graph"}
          >
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
          <div className="structure-toolbar-group" hidden={viewMode !== "graph"}>
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
          <div
            className="structure-toolbar-group"
            role="group"
            aria-label="Regions map表示操作"
            hidden={viewMode !== "regions"}
          >
            <button
              type="button"
              onClick={() => zoomRegionsAtCenter(1 / 1.2)}
              aria-label="Regionsを縮小"
            >
              −
            </button>
            <span>{Math.round(regionsView.viewport.scale * 100)}%</span>
            <button
              type="button"
              onClick={() => zoomRegionsAtCenter(1.2)}
              aria-label="Regionsを拡大"
            >
              ＋
            </button>
            <button
              type="button"
              aria-label="Regions全体を収める"
              title="Regions全体を収める"
              onClick={fitRegions}
            >
              Fit
            </button>
            <button
              type="button"
              aria-label="Regions表示を戻す"
              title="RegionsのcameraをStartが読める初期表示へ戻す"
              onClick={resetRegionsView}
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
        <section
          className="structure-canvas-shell"
          aria-label={`${structure.title} ${viewMode === "graph" ? "graph" : "Regions"}`}
        >
          <div
            ref={surfaceRef}
            className="structure-canvas"
            hidden={viewMode !== "graph"}
            tabIndex={0}
            onFocusCapture={(event) => {
              event.currentTarget.scrollLeft = 0;
              event.currentTarget.scrollTop = 0;
            }}
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
              cameraFrameIntentRef.current = null;
              panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={pointerMove}
            onPointerUp={stopPointer}
            onPointerCancel={stopPointer}
            onScroll={(event) => {
              // Native focus scrolling is not part of reviewer session state and
              // must never compose with the persisted camera transform.
              event.currentTarget.scrollLeft = 0;
              event.currentTarget.scrollTop = 0;
            }}
            onDoubleClick={(event) => {
              if (event.target === event.currentTarget) fitVisible();
            }}
          >
            {framedRegion && (
              <aside
                className="structure-region-lens"
                data-region-id={framedRegion.id}
                aria-label={`${framedRegion.label} Region lens. ${framedRegion.nodeIds.length} exact member ${framedRegion.nodeIds.length === 1 ? "Node" : "Nodes"}. ${framedRegion.summary}`}
                tabIndex={0}
              >
                <div className="structure-region-lens-heading">
                  <span className="structure-region-lens-kicker">Region lens</span>
                  <strong>{framedRegion.label}</strong>
                  <span className="structure-region-lens-count">
                    {framedRegion.nodeIds.length} exact member
                    {framedRegion.nodeIds.length === 1 ? " Node" : " Nodes"} ·{" "}
                    {framedRegionInternalEdgeCount} internal
                    {framedRegionInternalEdgeCount === 1 ? " Relation" : " Relations"}
                  </span>
                </div>
                <p>{framedRegion.summary}</p>
                <span className="structure-region-lens-context">
                  focus · {focusedNode?.label ?? "なし"} · origin · {originNode.label} · Graph ·{" "}
                  {visible.nodeIds.size}/{structure.nodes.length} Node · {visible.edgeIds.size}/
                  {structure.edges.length} Relation
                </span>
              </aside>
            )}
            <div
              className={`structure-world${cameraAnimating ? " camera-transition" : ""}`}
              style={{
                width: worldWidth,
                height: worldHeight,
                transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
              }}
            >
              <svg
                className="structure-edges"
                width={worldWidth}
                height={worldHeight}
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id={`${domId}-arrow`}
                    viewBox={`0 0 ${STRUCTURE_EDGE_ARROW_LENGTH} ${STRUCTURE_EDGE_ARROW_WIDTH}`}
                    refX={STRUCTURE_EDGE_ARROW_LENGTH}
                    refY={STRUCTURE_EDGE_ARROW_WIDTH / 2}
                    markerWidth={STRUCTURE_EDGE_ARROW_LENGTH}
                    markerHeight={STRUCTURE_EDGE_ARROW_WIDTH}
                    markerUnits="userSpaceOnUse"
                    orient="auto"
                  >
                    <path
                      d={`M 0 0 L ${STRUCTURE_EDGE_ARROW_LENGTH} ${STRUCTURE_EDGE_ARROW_WIDTH / 2} L 0 ${STRUCTURE_EDGE_ARROW_WIDTH} z`}
                    />
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
                  const regionFrameContext = framedRegion !== null && !framedRegionRelation;
                  const contextDistant = focusDistant && !framedRegionRelation;
                  const changeKind = source.changeKind;
                  const stateClasses = `${primaryBackbone ? " primary-backbone" : ""}${focused ? " focused" : ""}${framedRegionRelation ? " framed-region-relation" : ""}${regionFrameContext ? " region-frame-context" : ""}${selected ? " selected" : ""}${contextDistant ? " context-distant" : ""}${muted ? " muted" : ""}`;
                  return (
                    <Fragment key={edge.id}>
                      <path
                        className={`structure-edge${stateClasses}`}
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
                        data-arrow-base-x={edge.directed ? route.arrowBaseX : undefined}
                        data-arrow-base-y={edge.directed ? route.arrowBaseY : undefined}
                        data-arrow-tangent-x={edge.directed ? route.arrowTangentX : undefined}
                        data-arrow-tangent-y={edge.directed ? route.arrowTangentY : undefined}
                        d={edge.directed ? route.strokePath : route.path}
                      />
                      {edge.directed && (
                        <path
                          className={`structure-edge-arrow-carrier${stateClasses}`}
                          data-edge-arrow-id={edge.id}
                          data-source-change-kind={changeKind ?? undefined}
                          d={route.arrowPath}
                          markerEnd={`url(#${domId}-arrow)`}
                        />
                      )}
                    </Fragment>
                  );
                })}
                {edgeLabelPlacements.flatMap(({ edge, leaderPath, leaderEdgeAnchor, source }) => {
                  if (!leaderPath || !leaderEdgeAnchor) return [];
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
                  const regionFrameContext = framedRegion !== null && !framedRegionRelation;
                  const contextDistant = focusDistant && !framedRegionRelation;
                  return [
                    <g
                      key={`label-leader:${edge.id}`}
                      className={`structure-edge-label-leader${primaryBackbone ? " primary-backbone" : ""}${focused ? " focus-incident" : ""}${framedRegionRelation ? " framed-region-relation" : ""}${regionFrameContext ? " region-frame-context" : ""}${selected ? " selected" : ""}${contextDistant ? " context-distant" : ""}${muted ? " muted" : ""}`}
                      data-edge-id={edge.id}
                      data-primary-backbone={primaryBackbone ? "true" : undefined}
                      data-framed-region-relation={framedRegionRelation ? "true" : undefined}
                      data-source-change-kind={source.changeKind ?? undefined}
                    >
                      <path className="structure-edge-label-leader-halo" d={leaderPath} />
                      <path className="structure-edge-label-leader-line" d={leaderPath} />
                      <circle
                        className="structure-edge-label-leader-anchor"
                        cx={leaderEdgeAnchor.x}
                        cy={leaderEdgeAnchor.y}
                        r={2.5}
                      />
                    </g>,
                  ];
                })}
              </svg>
              {edgeLabelPlacements.map(
                ({
                  edge,
                  displayLines,
                  source,
                  x,
                  y,
                  selectWidth,
                  boxWidth,
                  height,
                  crowded,
                  displaced,
                }) => {
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
                  const regionFrameContext = framedRegion !== null && !framedRegionRelation;
                  const contextDistant = focusDistant && !framedRegionRelation;
                  return (
                    <div
                      key={`label:${edge.id}`}
                      className={`structure-edge-label${primaryBackbone ? " primary-backbone" : ""}${focused ? " focus-incident" : ""}${framedRegionRelation ? " framed-region-relation" : ""}${regionFrameContext ? " region-frame-context" : ""}${selected ? " selected" : ""}${contextDistant ? " context-distant" : ""}${crowded ? " crowded" : ""}${muted ? " muted" : ""}`}
                      data-edge-id={edge.id}
                      data-label-displaced={displaced ? "true" : "false"}
                      data-primary-backbone={primaryBackbone ? "true" : undefined}
                      data-framed-region-relation={framedRegionRelation ? "true" : undefined}
                      data-focus-relevance={
                        focused ? "incident" : focusDistant ? "distant" : "near"
                      }
                      data-source-anchor-count={source.anchorCount}
                      data-source-change-kind={changeKind ?? undefined}
                      style={{ left: x, top: y, width: boxWidth, height }}
                      onPointerDownCapture={(event) => {
                        if (event.button !== 0) return;
                        // Edge labels live inside the transformed world. Native pointer
                        // focus would try to reveal their untransformed layout boxes by
                        // scrolling the clipping surface, composing a second camera with
                        // the persisted transform (and potentially moving the control
                        // between pointerdown and pointerup).
                        event.preventDefault();
                        if (surfaceRef.current) {
                          surfaceRef.current.scrollLeft = 0;
                          surfaceRef.current.scrollTop = 0;
                        }
                      }}
                      onPointerUpCapture={(event) => {
                        if (event.button !== 0 || !(event.target instanceof Element)) return;
                        const control = event.target.closest<HTMLElement>("button, summary");
                        if (control && event.currentTarget.contains(control)) {
                          control.focus({ preventScroll: true });
                        }
                      }}
                    >
                      <button
                        type="button"
                        className={`structure-edge-select${selected ? " selected" : ""}`}
                        title={edge.label}
                        aria-label={accessibleRelationLabel}
                        aria-pressed={selected}
                        style={{ width: selectWidth }}
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
                const regionFrameContext = framedRegion !== null && !framedRegionMember;
                const contextDistant = focusDistant && !framedRegionMember;
                return (
                  <div
                    key={node.id}
                    className={`structure-node notation-${node.notation}${node.id === structure.originNodeId ? " origin" : ""}${presentationStart ? " presentation-start" : ""}${primaryBackbone ? " primary-backbone" : ""}${framedRegionMember ? " framed-region-member" : ""}${regionFrameContext ? " region-frame-context" : ""}${selected ? " focused" : ""}${incidentToFocus ? " neighboring" : ""}${contextDistant ? " context-distant" : ""}${selectedEdgeNodeIds.has(node.id) ? " edge-endpoint" : ""}`}
                    data-node-id={node.id}
                    data-node-notation={node.notation}
                    data-origin-node={node.id === structure.originNodeId ? "true" : undefined}
                    data-presentation-start-node={presentationStart ? "true" : undefined}
                    data-primary-backbone={primaryBackbone ? "true" : undefined}
                    data-focus-relevance={selected ? "active" : focusDistant ? "distant" : "near"}
                    data-framed-region-member={framedRegionMember ? "true" : undefined}
                    data-region-id={presentationRegion?.id}
                    data-region-label={presentationRegion?.label}
                    data-source-change-kind={changeKind ?? undefined}
                    style={{ left: point.x, top: point.y }}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      // The rendered card can be visible while its untransformed layout
                      // box is outside the clipping surface. Prevent native button focus
                      // from scrolling that box; pointer activation restores focus with
                      // `preventScroll` in stopPointer.
                      event.preventDefault();
                      event.stopPropagation();
                      if (surfaceRef.current) {
                        surfaceRef.current.scrollLeft = 0;
                        surfaceRef.current.scrollTop = 0;
                      }
                      dragRef.current = {
                        pointerId: event.pointerId,
                        nodeId: node.id,
                        focusTarget: event.currentTarget.querySelector<HTMLButtonElement>(
                          ":scope > .structure-node-focus",
                        ),
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
                      aria-label={`${node.label}${node.id === structure.originNodeId ? " · factual origin" : ""}${presentationStart ? " · authorial start" : ""}${primaryBackbone ? " · explanation backbone member" : ""}${presentationRegion ? ` · region: ${presentationRegion.label}` : ""}`}
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
            {!framedRegion && (
              <div className="structure-canvas-status">
                <strong>{focusedNode?.label ?? "focusなし"}</strong>
                <span>origin · {originNode.label}</span>
                <span>
                  {visible.nodeIds.size}/{structure.nodes.length} Node · {visible.edgeIds.size}/
                  {structure.edges.length} Relation
                </span>
              </div>
            )}
            <StructureMiniMap
              structure={structure}
              positions={positions}
              focusedNodeId={focusId}
              framedRegionId={framedRegionId}
              viewport={viewport}
              viewportElement={surfaceRef.current}
            />
          </div>
          {viewMode === "regions" && (
            <StructureRegionCanvas
              structure={structure}
              model={regionCanvasModel}
              viewport={regionsView.viewport}
              surfaceRef={regionsSurfaceRef}
              framedRegionId={framedRegionId}
              onOpenRegion={frameRegion}
              onOpenContext={openContextInGraph}
              onOpenEdge={openExactEdgeInGraph}
              onOpenEdgeSource={(edgeId, anchorIndex, anchor, right) =>
                void openSource({ kind: "edge", edgeId, anchorIndex }, anchor, right)
              }
              onPointerDown={(event) => {
                if (
                  event.button !== 0 ||
                  (event.target instanceof Element &&
                    event.target.closest(
                      ".structure-region-map-card, .structure-region-map-relation-label, button",
                    ))
                ) {
                  return;
                }
                regionsPanRef.current = {
                  pointerId: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={moveRegionsPointer}
              onPointerUp={stopRegionsPointer}
              onPointerCancel={stopRegionsPointer}
              onFocusCapture={revealFocusedRegion}
              onDoubleClick={(event) => {
                if (
                  event.target instanceof Element &&
                  event.target.closest(".structure-region-map-card, button")
                ) {
                  return;
                }
                fitRegions();
              }}
            />
          )}
        </section>
      </div>
    </article>
  );
}
