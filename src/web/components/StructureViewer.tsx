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
  reconcileStructureLayout,
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
  MIN_STRUCTURE_ZOOM,
  scaledStructureZoom,
  setStructureSession,
  type StructureViewport,
  type StructureNavigationTarget,
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
  const cachedSession = getStructureSession(paneId, structure.id);
  const initial = cachedSession ?? createStructureSession(structure);
  const [focusId, setFocusId] = useState(initial.focusId);
  const [selectedEdgeId, setSelectedEdgeId] = useState(initial.selectedEdgeId);
  const [depth, setDepth] = useState<StructureNeighborhoodDepth>(initial.depth);
  const [positions, setPositions] = useState(initial.positions);
  const [viewport, setViewport] = useState(initial.viewport);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const [status, setStatus] = useState<string | null>(null);
  const [exporting, setExporting] = useState<StructureExportFormat | null>(null);
  const [deleting, setDeleting] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const surfaceSizeRef = useRef(initial.surfaceSize);
  const focusIdRef = useRef(focusId);
  const positionsRef = useRef(positions);
  const observedStructureRef = useRef({
    sourceOid: structure.sourceOid,
    updatedAt: structure.updatedAt,
  });
  const pendingViewportActionRef = useRef<"initial" | null>(cachedSession ? null : "initial");
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
    const previous = getStructureSession(paneId, structure.id);
    if (previous?.updatedAt === structure.updatedAt) return;
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
    setPositions((current) => reconcileStructureLayout(structure, current));
    const retainedFocus =
      focusIdRef.current && structure.nodes.some((node) => node.id === focusIdRef.current)
        ? focusIdRef.current
        : null;
    const nextFocus = retainedFocus;
    setFocusId(nextFocus);
    if (nextFocus === null) {
      setDepth("all");
    }
    setSelectedEdgeId((current) =>
      current && structure.edges.some((edge) => edge.id === current) ? current : null,
    );
  }, [paneId, structure, structure.updatedAt]);

  useEffect(() => {
    setStructureSession(paneId, structure.id, {
      focusId,
      selectedEdgeId,
      depth,
      positions,
      viewport,
      surfaceSize: surfaceSizeRef.current,
      updatedAt: structure.updatedAt,
    });
  }, [depth, focusId, positions, paneId, selectedEdgeId, structure.updatedAt, viewport]);

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
  const labelEdgeIds = useMemo(
    () =>
      new Set(
        structure.edges
          .filter(
            (edge) =>
              visible.edgeIds.has(edge.id) &&
              (!focusId ||
                edge.from === focusId ||
                edge.to === focusId ||
                edge.id === selectedEdgeId),
          )
          .map((edge) => edge.id),
      ),
    [focusId, selectedEdgeId, structure.edges, visible.edgeIds],
  );
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
      }),
    [labelEdgeIds, positions, sourceChangeKinds, structure, visible.edgeIds, visible.nodeIds],
  );
  const renderedEdges = renderModel.edges.map(({ edge }) => edge);
  const renderedNodes = renderModel.nodes.map(({ node }) => node);
  const edgeLabelPlacements = renderModel.labels;
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
    setPositions(initialStructureLayout(structure));
  };

  const focusNode = (nodeId: string, recenter = false): void => {
    setSelectedEdgeId(null);
    setFocusId(nodeId);
    if (recenter) centerNode(nodeId);
  };

  const clearFocus = (): void => {
    setSelectedEdgeId(null);
    setFocusId(null);
    setDepth("all");
  };

  const selectDepth = (nextDepth: StructureNeighborhoodDepth): void => {
    if (nextDepth === depth) return;
    setDepth(nextDepth);
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
      <div className="structure-body">
        <div className="structure-toolbar" aria-label="Structure表示操作">
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
                {renderModel.edges.map(({ edge, geometry: route, source }) => {
                  const focused = edge.from === focusId || edge.to === focusId;
                  const selected = edge.id === selectedEdgeId;
                  const muted = selectedEdgeId !== null && !selected;
                  const changeKind = source.changeKind;
                  return (
                    <path
                      key={edge.id}
                      className={`structure-edge${focused ? " focused" : ""}${selected ? " selected" : ""}${muted ? " muted" : ""}`}
                      data-edge-id={edge.id}
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
              </svg>
              {edgeLabelPlacements.map(
                ({ edge, displayLines, source, x, y, selectWidth, height, crowded }) => {
                  const changeKind = source.changeKind;
                  const fromNode = nodesById.get(edge.from);
                  const toNode = nodesById.get(edge.to);
                  const relationLabel = edge.directed
                    ? `${fromNode?.label ?? edge.from} から ${toNode?.label ?? edge.to} へ: ${edge.label}`
                    : `${fromNode?.label ?? edge.from} と ${toNode?.label ?? edge.to} の関係: ${edge.label}`;
                  const selected = edge.id === selectedEdgeId;
                  const muted = selectedEdgeId !== null && !selected;
                  return (
                    <div
                      key={`label:${edge.id}`}
                      className={`structure-edge-label${crowded ? " crowded" : ""}${muted ? " muted" : ""}`}
                      data-edge-id={edge.id}
                      data-source-anchor-count={source.anchorCount}
                      data-source-change-kind={changeKind ?? undefined}
                      style={{ left: x, top: y, minHeight: height }}
                    >
                      <button
                        type="button"
                        className={`structure-edge-select${selected ? " selected" : ""}`}
                        title={edge.label}
                        aria-label={relationLabel}
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
                const incidentToFocus = incident.some(
                  (edge) => edge.from === node.id || edge.to === node.id,
                );
                return (
                  <div
                    key={node.id}
                    className={`structure-node notation-${node.notation}${node.id === structure.originNodeId ? " origin" : ""}${selected ? " focused" : ""}${incidentToFocus ? " neighboring" : ""}${selectedEdgeNodeIds.has(node.id) ? " edge-endpoint" : ""}`}
                    data-node-id={node.id}
                    data-node-notation={node.notation}
                    data-origin-node={node.id === structure.originNodeId ? "true" : undefined}
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
              viewport={viewport}
              viewportElement={surfaceRef.current}
            />
          </div>
        </section>
      </div>
    </article>
  );
}
