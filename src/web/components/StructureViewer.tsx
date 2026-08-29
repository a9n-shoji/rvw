import {
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
  positions: Record<string, StructurePoint>;
  viewport: StructureViewport;
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
    positions: initialStructureLayout(structure),
    viewport: { x: 24, y: 24, scale: 1 },
    updatedAt: structure.updatedAt,
  };
}

function changeKindForPath(changedFiles: readonly ChangedFile[], path: string): ChangeKind | null {
  return (
    changedFiles.find(
      (change) =>
        changedFilePath(change) === path || change.oldPath === path || change.newPath === path,
    )?.kind ?? null
  );
}

function anchorLabel(anchor: SourceAnchor): string {
  return anchor.startLine === null
    ? anchor.path
    : `${anchor.path}:${anchor.startLine}${anchor.endLine === anchor.startLine ? "" : `-${anchor.endLine}`}`;
}

function SourceButton({
  anchor,
  changeKind,
  compact = false,
  onOpen,
}: {
  anchor: SourceAnchor;
  changeKind: ChangeKind | null;
  compact?: boolean;
  onOpen: (openInRightPane: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`structure-source${compact ? " compact" : ""}`}
      title={`${anchorLabel(anchor)}を開く`}
      aria-label={`${anchorLabel(anchor)}を開く`}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        if (!event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        event.stopPropagation();
        onOpen(true);
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (!event.metaKey && !event.ctrlKey) onOpen(false);
      }}
    >
      <span className="structure-source-icons" aria-hidden="true">
        <FileEntryIcon path={anchor.path} kind="file" />
        {changeKind && <ChangeIcon kind={changeKind} />}
      </span>
      {compact ? <span>&lt;/&gt;</span> : <span>{anchorLabel(anchor)}</span>}
    </button>
  );
}

function edgePath(
  edge: StructureEdge,
  positions: Readonly<Record<string, StructurePoint>>,
  laneOffset: number,
): { path: string; label: StructurePoint } | null {
  const from = positions[edge.from];
  const to = positions[edge.to];
  if (!from || !to) return null;
  const start = { x: from.x + STRUCTURE_NODE_WIDTH / 2, y: from.y + STRUCTURE_NODE_HEIGHT / 2 };
  if (edge.from === edge.to) {
    return {
      path: `M ${start.x + 60} ${start.y - 42} C ${start.x + 150} ${start.y - 130}, ${start.x - 70} ${start.y - 130}, ${start.x - 55} ${start.y - 42}`,
      label: { x: start.x + 18, y: start.y - 112 },
    };
  }
  const end = { x: to.x + STRUCTURE_NODE_WIDTH / 2, y: to.y + STRUCTURE_NODE_HEIGHT / 2 };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const perpendicular = { x: -dy / length, y: dx / length };
  const control = {
    x: (start.x + end.x) / 2 + perpendicular.x * laneOffset,
    y: (start.y + end.y) / 2 + perpendicular.y * laneOffset,
  };
  return {
    path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
    label: control,
  };
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
  const initial = sessions.get(structure.id) ?? initialSession(structure);
  const [focusId, setFocusId] = useState(initial.focusId);
  const [depth, setDepth] = useState<StructureNeighborhoodDepth>(initial.depth);
  const [expanded, setExpanded] = useState(initial.expanded);
  const [positions, setPositions] = useState(initial.positions);
  const [viewport, setViewport] = useState(initial.viewport);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const [status, setStatus] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    nodeId: string;
    x: number;
    y: number;
    distance: number;
  } | null>(null);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const update = (): void =>
      setSurfaceSize({ width: surface.clientWidth, height: surface.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const previous = sessions.get(structure.id);
    if (previous?.updatedAt === structure.updatedAt) return;
    setPositions((current) => reconcileStructureLayout(structure, current));
    setFocusId((current) =>
      current && structure.nodes.some((node) => node.id === current)
        ? current
        : (structure.initialFocus ?? null),
    );
  }, [structure, structure.updatedAt]);

  useEffect(() => {
    sessions.set(structure.id, {
      focusId,
      depth,
      expanded,
      positions,
      viewport,
      updatedAt: structure.updatedAt,
    });
  }, [depth, expanded, focusId, positions, structure.id, structure.updatedAt, viewport]);

  const visible = useMemo(
    () => visibleStructureGraph(structure, focusId, depth, expanded),
    [depth, expanded, focusId, structure],
  );
  const focusedNode = structure.nodes.find((node) => node.id === focusId) ?? null;
  const incident = focusId ? incidentStructureEdges(structure, focusId) : [];
  const routeOffsets = useMemo(() => structureEdgeRouteOffsets(structure.edges), [structure.edges]);
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
  const renderedEdges = structure.edges.filter(
    (edge) =>
      visible.edgeIds.has(edge.id) && renderNodeIds.has(edge.from) && renderNodeIds.has(edge.to),
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

  const centerFocus = (): void => {
    if (!focusId) return;
    const point = positions[focusId];
    if (!point) return;
    setViewport((current) => ({
      ...current,
      x: surfaceSize.width / 2 - (point.x + STRUCTURE_NODE_WIDTH / 2) * current.scale,
      y: surfaceSize.height / 2 - (point.y + STRUCTURE_NODE_HEIGHT / 2) * current.scale,
    }));
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
        setFocusId(drag.nodeId);
        setExpanded(false);
      }
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <article className="structure-viewer" data-structure-id={structure.id}>
      <header className="structure-header">
        <div>
          <span className="structure-kicker">
            Structure · exact source {structure.sourceOid.slice(0, 8)}
          </span>
          <h2>{structure.title}</h2>
          <p>{structure.scope}</p>
        </div>
        <div className="structure-header-actions">
          <button type="button" onClick={() => setDetailsOpen((open) => !open)}>
            {detailsOpen ? "詳細を閉じる" : "詳細を開く"}
          </button>
          <button
            type="button"
            className="danger"
            disabled={deleting}
            onClick={() => void deleteStructure()}
          >
            {deleting ? "削除中…" : "削除"}
          </button>
        </div>
      </header>
      <div className={`structure-body${detailsOpen ? " with-details" : ""}`}>
        <section className="structure-canvas-shell" aria-label={`${structure.title} graph`}>
          <div className="structure-toolbar" aria-label="Structure表示操作">
            <div className="structure-depth" role="group" aria-label="近傍の深さ">
              {([1, 2, "all"] as const).map((candidate) => (
                <button
                  type="button"
                  key={candidate}
                  className={depth === candidate ? "active" : ""}
                  aria-pressed={depth === candidate}
                  onClick={() => setDepth(candidate)}
                >
                  {candidate === "all" ? "All" : `${candidate}-hop`}
                </button>
              ))}
            </div>
            <span>
              {visible.nodeIds.size} / {structure.nodes.length} Nodes
            </span>
            <button type="button" onClick={() => zoomAtCenter(1.2)} aria-label="拡大">
              ＋
            </button>
            <button type="button" onClick={() => zoomAtCenter(1 / 1.2)} aria-label="縮小">
              −
            </button>
            <button type="button" onClick={fitVisible}>
              全体表示
            </button>
            <button type="button" disabled={!focusId} onClick={centerFocus}>
              Focusへ
            </button>
          </div>
          {status && (
            <div className="structure-status" role="status" aria-live="polite">
              {status}
            </div>
          )}
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
                    orient="auto-start-reverse"
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
                      d={route.path}
                      markerEnd={
                        edge.directed ? `url(#structure-arrow-${structure.id})` : undefined
                      }
                    />
                  );
                })}
              </svg>
              {renderedEdges.map((edge) => {
                if (edge.from !== focusId && edge.to !== focusId) return null;
                const route = edgePath(edge, positions, routeOffsets.get(edge.id) ?? 0);
                if (!route) return null;
                const changed = edge.anchors
                  .map((anchor) => changeKindForPath(changedFiles, anchor.path))
                  .find((kind) => kind !== null);
                return (
                  <button
                    key={`label:${edge.id}`}
                    type="button"
                    className={`structure-edge-label${changed ? ` change-${changed}` : ""}`}
                    style={{ left: route.label.x, top: route.label.y }}
                    onClick={() => {
                      const nextId = edge.from === focusId ? edge.to : edge.from;
                      setFocusId(nextId);
                      setExpanded(false);
                    }}
                  >
                    {edge.label}
                  </button>
                );
              })}
              {structure.nodes
                .filter((node) => renderNodeIds.has(node.id))
                .map((node) => {
                  const point = positions[node.id];
                  if (!point) return null;
                  const selected = node.id === focusId;
                  const incidentToFocus = incident.some(
                    (edge) => edge.from === node.id || edge.to === node.id,
                  );
                  const changeKind = node.anchor
                    ? changeKindForPath(changedFiles, node.anchor.path)
                    : null;
                  return (
                    <div
                      key={node.id}
                      className={`structure-node${selected ? " focused" : ""}${incidentToFocus ? " neighboring" : ""}${changeKind ? ` change-${changeKind}` : ""}`}
                      data-node-id={node.id}
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
                        onClick={() => {
                          setFocusId(node.id);
                          setExpanded(false);
                        }}
                      >
                        <span className="structure-node-topline">
                          {node.kind && <span className="structure-kind">{node.kind}</span>}
                          {changeKind && <ChangeIcon kind={changeKind} />}
                        </span>
                        <strong>{node.label}</strong>
                        {node.description && (
                          <span className="structure-node-description">{node.description}</span>
                        )}
                      </button>
                      {node.anchor && (
                        <SourceButton
                          compact
                          anchor={node.anchor}
                          changeKind={changeKind}
                          onOpen={(right) => void openAnchor(node.anchor!, right)}
                        />
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        </section>
        {detailsOpen && (
          <aside className="structure-details" aria-label="Structure details">
            {focusedNode ? (
              <>
                <span className="structure-details-label">Focused Node</span>
                <h3>{focusedNode.label}</h3>
                {focusedNode.kind && <span className="structure-kind">{focusedNode.kind}</span>}
                <p>{focusedNode.description ?? "説明はありません。"}</p>
                {focusedNode.anchor && (
                  <SourceButton
                    anchor={focusedNode.anchor}
                    changeKind={changeKindForPath(changedFiles, focusedNode.anchor.path)}
                    onOpen={(right) => void openAnchor(focusedNode.anchor!, right)}
                  />
                )}
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
                    const other = structure.nodes.find((node) => node.id === otherId);
                    return (
                      <li key={edge.id} className={visible.edgeIds.has(edge.id) ? "" : "collapsed"}>
                        <button
                          type="button"
                          onClick={() => {
                            setFocusId(otherId);
                            setExpanded(false);
                          }}
                        >
                          <span>{edge.directed ? (edge.from === focusId ? "→" : "←") : "—"}</span>
                          <strong>{edge.label}</strong>
                          <span>{other?.label ?? otherId}</span>
                        </button>
                        {edge.anchors.map((anchor, index) => (
                          <SourceButton
                            key={`${edge.id}:${index}`}
                            anchor={anchor}
                            changeKind={changeKindForPath(changedFiles, anchor.path)}
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
