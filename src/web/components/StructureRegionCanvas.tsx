import {
  useId,
  type FocusEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
  type Ref,
} from "react";
import type { Structure } from "../../domain/models.js";
import {
  aggregateStructureRegionOverview,
  deriveStructureRegionContextSurface,
  layoutStructureRegionOverview,
  routeStructureRegionOverviewRelations,
  STRUCTURE_REGION_OVERVIEW_CARD_HEIGHT,
  STRUCTURE_REGION_OVERVIEW_CARD_WIDTH,
  STRUCTURE_REGION_OVERVIEW_COLUMN_GAP,
  STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE,
  STRUCTURE_REGION_OVERVIEW_RELATION_LABEL_WIDTH,
  STRUCTURE_REGION_OVERVIEW_ROW_GAP,
  STRUCTURE_REGION_OVERVIEW_TERMINAL_RUNWAY,
  type StructureRegionContext,
  type StructureRegionContextRelation,
  type StructureRegionContextSurface,
  type StructureRegionDirectRelation,
  type StructureRegionOverviewLayout,
  type StructureRegionOverviewModel,
  type StructureRegionOverviewPoint,
  type StructureRegionOverviewRoutedRelation,
} from "../structure-region-overview.js";
import { wrapStructureText } from "../structure-render-model.js";
import type { StructureCameraBounds, StructureViewport } from "../structure-session.js";

const CONTEXT_CARD_WIDTH = 210;
const CONTEXT_CARD_HEIGHT = 104;
const CONTEXT_ROW_GAP = 62;
const CONTEXT_SECTION_GAP = 112;
const MAP_PADDING = 48;

interface StructureRegionContextLayout {
  contextId: string;
  column: number;
  row: number;
  center: StructureRegionOverviewPoint;
}

export interface StructureRegionCanvasModel {
  regionOverview: StructureRegionOverviewModel;
  regionLayout: StructureRegionOverviewLayout;
  contextSurface: StructureRegionContextSurface;
  contextLayouts: readonly StructureRegionContextLayout[];
  relationRoutes: readonly StructureRegionOverviewRoutedRelation[];
  width: number;
  height: number;
  assignedNodeCount: number;
  unassignedNodeCount: number;
}

function directRelationRouteId(relation: StructureRegionDirectRelation): string {
  return `region:${JSON.stringify(relation.regionIds)}`;
}

function contextRelationRouteId(relation: StructureRegionContextRelation): string {
  return `context:${JSON.stringify([relation.regionId, relation.contextId])}`;
}

function relationLabelHeight(lines: readonly string[]): number {
  return 16 + lines.length * 15;
}

function stableCompare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function layoutContextComponents(
  regionLayout: StructureRegionOverviewLayout,
  contextSurface: StructureRegionContextSurface,
  startNodeId: string,
  sectionGap: number,
): {
  contexts: StructureRegionContextLayout[];
  width: number;
  height: number;
} {
  if (contextSurface.contexts.length === 0) {
    return { contexts: [], width: regionLayout.width, height: regionLayout.height };
  }
  const columnCount = Math.max(
    regionLayout.columnCount,
    Math.min(4, Math.ceil(Math.sqrt(contextSurface.contexts.length))),
  );
  const rowCount = Math.ceil(contextSurface.contexts.length / columnCount);
  const regionColumnById = new Map(
    regionLayout.regions.map(({ regionId, column }) => [regionId, column]),
  );
  const orderedContexts = [...contextSurface.contexts].sort(
    (left, right) =>
      Number(right.nodeIds.includes(startNodeId)) - Number(left.nodeIds.includes(startNodeId)) ||
      Number(right.backboneEdgeIds.length > 0) - Number(left.backboneEdgeIds.length > 0) ||
      stableCompare(left.id, right.id),
  );
  const available = Array.from({ length: rowCount * columnCount }, (_, index) => ({
    column: index % columnCount,
    row: Math.floor(index / columnCount),
  }));
  const contexts = orderedContexts.map((context): StructureRegionContextLayout => {
    const adjacentColumns = context.adjacentRegionIds.flatMap((regionId) => {
      const column = regionColumnById.get(regionId);
      return column === undefined ? [] : [column];
    });
    const preferredColumn =
      adjacentColumns.length > 0
        ? adjacentColumns.reduce((sum, column) => sum + column, 0) / adjacentColumns.length
        : (columnCount - 1) / 2;
    const selected = [...available].sort(
      (left, right) =>
        left.row - right.row ||
        Math.abs(left.column - preferredColumn) - Math.abs(right.column - preferredColumn) ||
        left.column - right.column,
    )[0]!;
    available.splice(
      available.findIndex(({ column, row }) => column === selected.column && row === selected.row),
      1,
    );
    return {
      contextId: context.id,
      ...selected,
      center: {
        x:
          selected.column *
            (STRUCTURE_REGION_OVERVIEW_CARD_WIDTH + STRUCTURE_REGION_OVERVIEW_COLUMN_GAP) +
          STRUCTURE_REGION_OVERVIEW_CARD_WIDTH / 2,
        y:
          regionLayout.height +
          sectionGap +
          selected.row * (CONTEXT_CARD_HEIGHT + CONTEXT_ROW_GAP) +
          CONTEXT_CARD_HEIGHT / 2,
      },
    };
  });
  return {
    contexts,
    width: Math.max(
      regionLayout.width,
      columnCount * STRUCTURE_REGION_OVERVIEW_CARD_WIDTH +
        Math.max(0, columnCount - 1) * STRUCTURE_REGION_OVERVIEW_COLUMN_GAP,
    ),
    height:
      regionLayout.height +
      sectionGap +
      rowCount * CONTEXT_CARD_HEIGHT +
      Math.max(0, rowCount - 1) * CONTEXT_ROW_GAP,
  };
}

export function buildStructureRegionCanvasModel(
  structure: Structure,
): StructureRegionCanvasModel | null {
  const regionOverview = aggregateStructureRegionOverview(structure);
  if (!regionOverview || regionOverview.regions.length === 0) return null;
  const contextSurface = deriveStructureRegionContextSurface(regionOverview);
  const edgeLabelsById = new Map(structure.edges.map((edge) => [edge.id, edge.label]));
  const regionLabelsById = new Map(
    regionOverview.regions.map((region) => [region.id, region.label]),
  );
  const directLabels = new Map(
    regionOverview.directRelations.map((relation) => [
      directRelationRouteId(relation),
      buildDirectRegionRelationLabel(relation, edgeLabelsById, regionLabelsById),
    ]),
  );
  const contextLabels = new Map(
    contextSurface.boundaryRelations.map((relation) => [
      contextRelationRouteId(relation),
      buildContextRegionRelationLabel(relation, edgeLabelsById, regionLabelsById),
    ]),
  );
  const relationLineCounts = [...directLabels.values(), ...contextLabels.values()].map(
    ({ lines }) => lines.length,
  );
  const maximumRelationLabelHeight = 16 + Math.max(1, ...relationLineCounts) * 15;
  const baseRegionLayout = layoutStructureRegionOverview(regionOverview);
  const regionLayout = respaceRegionLayout(
    baseRegionLayout,
    Math.max(
      STRUCTURE_REGION_OVERVIEW_COLUMN_GAP,
      STRUCTURE_REGION_OVERVIEW_RELATION_LABEL_WIDTH +
        2 * (STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE + STRUCTURE_REGION_OVERVIEW_TERMINAL_RUNWAY),
    ),
    Math.max(
      STRUCTURE_REGION_OVERVIEW_ROW_GAP,
      maximumRelationLabelHeight +
        2 * (STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE + STRUCTURE_REGION_OVERVIEW_TERMINAL_RUNWAY),
    ),
  );
  const contextLayout = layoutContextComponents(
    regionLayout,
    contextSurface,
    structure.presentation!.startNodeId,
    Math.max(CONTEXT_SECTION_GAP, maximumRelationLabelHeight + 24),
  );
  const routed = routeStructureRegionOverviewRelations({
    cards: [
      ...regionLayout.regions.map((region) => ({
        id: `region:${region.regionId}`,
        center: { x: region.center.x + MAP_PADDING, y: region.center.y + MAP_PADDING },
        width: STRUCTURE_REGION_OVERVIEW_CARD_WIDTH,
        height: STRUCTURE_REGION_OVERVIEW_CARD_HEIGHT,
      })),
      ...contextLayout.contexts.map((context) => ({
        id: `context:${context.contextId}`,
        center: { x: context.center.x + MAP_PADDING, y: context.center.y + MAP_PADDING },
        width: CONTEXT_CARD_WIDTH,
        height: CONTEXT_CARD_HEIGHT,
      })),
    ],
    relations: [
      ...regionOverview.directRelations.map((relation) => {
        const id = directRelationRouteId(relation);
        return {
          id,
          fromCardId: `region:${relation.regionIds[0]}`,
          toCardId: `region:${relation.regionIds[1]}`,
          labelWidth: STRUCTURE_REGION_OVERVIEW_RELATION_LABEL_WIDTH,
          labelHeight: relationLabelHeight(directLabels.get(id)!.lines),
          priority: 0,
        };
      }),
      ...contextSurface.boundaryRelations.map((relation) => {
        const id = contextRelationRouteId(relation);
        return {
          id,
          fromCardId: `region:${relation.regionId}`,
          toCardId: `context:${relation.contextId}`,
          labelWidth: STRUCTURE_REGION_OVERVIEW_RELATION_LABEL_WIDTH,
          labelHeight: relationLabelHeight(contextLabels.get(id)!.lines),
          priority: 1,
        };
      }),
    ],
    width: contextLayout.width + MAP_PADDING * 2,
    height: contextLayout.height + MAP_PADDING * 2,
  });
  const assignedNodeIds = new Set(regionOverview.regions.flatMap((region) => region.nodeIds));
  return {
    regionOverview,
    regionLayout,
    contextSurface,
    contextLayouts: contextLayout.contexts,
    relationRoutes: routed.routes,
    width: routed.width,
    height: routed.height,
    assignedNodeCount: assignedNodeIds.size,
    unassignedNodeCount: Math.max(0, structure.nodes.length - assignedNodeIds.size),
  };
}

export function structureRegionCanvasStartBounds(
  structure: Pick<Structure, "presentation">,
  model: StructureRegionCanvasModel,
): StructureCameraBounds | null {
  const startNodeId = structure.presentation?.startNodeId;
  if (!startNodeId) return null;
  const startRegionLayout = model.regionLayout.regions.find(
    ({ regionId }) => regionId === model.regionOverview.startRegionId,
  );
  if (startRegionLayout) {
    const centerX = startRegionLayout.center.x + MAP_PADDING;
    const centerY = startRegionLayout.center.y + MAP_PADDING;
    return {
      left: centerX - STRUCTURE_REGION_OVERVIEW_CARD_WIDTH / 2,
      top: centerY - STRUCTURE_REGION_OVERVIEW_CARD_HEIGHT / 2,
      right: centerX + STRUCTURE_REGION_OVERVIEW_CARD_WIDTH / 2,
      bottom: centerY + STRUCTURE_REGION_OVERVIEW_CARD_HEIGHT / 2,
    };
  }
  const startContextId = model.contextSurface.contexts.find(({ nodeIds }) =>
    nodeIds.includes(startNodeId),
  )?.id;
  const startContextLayout = model.contextLayouts.find(
    ({ contextId }) => contextId === startContextId,
  );
  if (!startContextLayout) return null;
  const centerX = startContextLayout.center.x + MAP_PADDING;
  const centerY = startContextLayout.center.y + MAP_PADDING;
  return {
    left: centerX - CONTEXT_CARD_WIDTH / 2,
    top: centerY - CONTEXT_CARD_HEIGHT / 2,
    right: centerX + CONTEXT_CARD_WIDTH / 2,
    bottom: centerY + CONTEXT_CARD_HEIGHT / 2,
  };
}

function respaceRegionLayout(
  layout: StructureRegionOverviewLayout,
  columnGap: number,
  rowGap: number,
): StructureRegionOverviewLayout {
  const regions = layout.regions.map((region) => ({
    ...region,
    center: {
      x:
        region.column * (STRUCTURE_REGION_OVERVIEW_CARD_WIDTH + columnGap) +
        STRUCTURE_REGION_OVERVIEW_CARD_WIDTH / 2,
      y:
        region.row * (STRUCTURE_REGION_OVERVIEW_CARD_HEIGHT + rowGap) +
        STRUCTURE_REGION_OVERVIEW_CARD_HEIGHT / 2,
    },
  }));
  const centerByRegionId = new Map(regions.map(({ regionId, center }) => [regionId, center]));
  return {
    ...layout,
    width:
      layout.columnCount * STRUCTURE_REGION_OVERVIEW_CARD_WIDTH +
      Math.max(0, layout.columnCount - 1) * columnGap,
    height:
      layout.rowCount * STRUCTURE_REGION_OVERVIEW_CARD_HEIGHT +
      Math.max(0, layout.rowCount - 1) * rowGap,
    regions,
    directRelations: layout.directRelations.map((relation) => ({
      ...relation,
      firstCenter: centerByRegionId.get(relation.regionIds[0])!,
      secondCenter: centerByRegionId.get(relation.regionIds[1])!,
    })),
  };
}

function directRelationDirection(
  relation: StructureRegionDirectRelation,
): "undirected" | "first-to-second" | "second-to-first" | "reciprocal" | "mixed" {
  const forward = relation.directions.fromFirstRegionEdgeIds.length > 0;
  const reverse = relation.directions.fromSecondRegionEdgeIds.length > 0;
  const undirected = relation.directions.undirectedEdgeIds.length > 0;
  if (undirected && (forward || reverse)) return "mixed";
  if (forward && reverse) return "reciprocal";
  if (forward) return "first-to-second";
  if (reverse) return "second-to-first";
  return "undirected";
}

function contextRelationDirection(
  relation: StructureRegionContextRelation,
): "undirected" | "region-to-context" | "context-to-region" | "reciprocal" | "mixed" {
  const forward = relation.directions.fromRegionEdgeIds.length > 0;
  const reverse = relation.directions.fromUnassignedNodeEdgeIds.length > 0;
  const undirected = relation.directions.undirectedEdgeIds.length > 0;
  if (undirected && (forward || reverse)) return "mixed";
  if (forward && reverse) return "reciprocal";
  if (forward) return "region-to-context";
  if (reverse) return "context-to-region";
  return "undirected";
}

interface DirectionalPredicate {
  edgeId: string;
  fromLabel: string;
  toLabel: string;
  symbol: "→" | "—";
  predicate: string;
  isCore: boolean;
}

export interface DirectionalRelationLabel {
  full: string;
  lines: readonly string[];
  edgeCount: number;
  coreEdgeCount: number;
}

const REGION_RELATION_LABEL_TEXT_UNITS = 17;

function directionalRelationLabel(
  entries: readonly DirectionalPredicate[],
): DirectionalRelationLabel {
  const uniqueEntries = [
    ...new Map(
      entries.map((entry) => [
        JSON.stringify([
          entry.fromLabel,
          entry.symbol,
          entry.toLabel,
          entry.predicate,
          entry.isCore,
        ]),
        entry,
      ]),
    ).values(),
  ];
  const visible = uniqueEntries.slice(0, 3);
  const visibleByDirection = new Map<string, DirectionalPredicate[]>();
  for (const entry of visible) {
    const key = JSON.stringify([entry.fromLabel, entry.symbol, entry.toLabel]);
    const grouped = visibleByDirection.get(key);
    if (grouped) grouped.push(entry);
    else visibleByDirection.set(key, [entry]);
  }
  const lines = [...visibleByDirection.values()].flatMap((group) => {
    const first = group[0]!;
    return [
      ...wrapStructureText({
        text: `${first.fromLabel} ${first.symbol} ${first.toLabel}`,
        maxUnits: REGION_RELATION_LABEL_TEXT_UNITS,
        maxLines: 2,
      }),
      ...group.flatMap((entry) =>
        wrapStructureText({
          text: `↳ ${entry.isCore ? "Core · " : ""}${entry.predicate}`,
          maxUnits: REGION_RELATION_LABEL_TEXT_UNITS,
          ...(uniqueEntries.length === 1 ? {} : { maxLines: 2 }),
        }),
      ),
    ];
  });
  const remainder = uniqueEntries.length - visible.length;
  if (remainder > 0) lines.push(`+${remainder} more predicates`);
  const coreEdgeCount = entries.filter(({ isCore }) => isCore).length;
  if (entries.length > 1) {
    lines.push(
      `${entries.length} exact Edges${coreEdgeCount > 0 ? ` · Core ${coreEdgeCount}/${entries.length}` : ""}`,
    );
  }
  return {
    full: entries
      .map(
        (entry) =>
          `${entry.fromLabel} ${entry.symbol} ${entry.toLabel}: ${entry.predicate}${entry.isCore ? " (Core)" : ""}`,
      )
      .join(" · "),
    lines: lines.length > 0 ? lines : ["relation"],
    edgeCount: entries.length,
    coreEdgeCount,
  };
}

export function buildDirectRegionRelationLabel(
  relation: StructureRegionDirectRelation,
  edgeLabelsById: ReadonlyMap<string, string>,
  regionLabelsById: ReadonlyMap<string, string>,
): DirectionalRelationLabel {
  const [firstRegionId, secondRegionId] = relation.regionIds;
  const firstLabel = regionLabelsById.get(firstRegionId) ?? firstRegionId;
  const secondLabel = regionLabelsById.get(secondRegionId) ?? secondRegionId;
  const firstToSecond = new Set(relation.directions.fromFirstRegionEdgeIds);
  const secondToFirst = new Set(relation.directions.fromSecondRegionEdgeIds);
  const core = new Set(relation.backboneEdgeIds);
  return directionalRelationLabel(
    relation.edgeIds.map((edgeId): DirectionalPredicate => {
      if (firstToSecond.has(edgeId)) {
        return {
          edgeId,
          fromLabel: firstLabel,
          toLabel: secondLabel,
          symbol: "→",
          predicate: edgeLabelsById.get(edgeId) ?? edgeId,
          isCore: core.has(edgeId),
        };
      }
      if (secondToFirst.has(edgeId)) {
        return {
          edgeId,
          fromLabel: secondLabel,
          toLabel: firstLabel,
          symbol: "→",
          predicate: edgeLabelsById.get(edgeId) ?? edgeId,
          isCore: core.has(edgeId),
        };
      }
      return {
        edgeId,
        fromLabel: firstLabel,
        toLabel: secondLabel,
        symbol: "—",
        predicate: edgeLabelsById.get(edgeId) ?? edgeId,
        isCore: core.has(edgeId),
      };
    }),
  );
}

export function buildContextRegionRelationLabel(
  relation: StructureRegionContextRelation,
  edgeLabelsById: ReadonlyMap<string, string>,
  regionLabelsById: ReadonlyMap<string, string>,
): DirectionalRelationLabel {
  const regionLabel = regionLabelsById.get(relation.regionId) ?? relation.regionId;
  const regionToContext = new Set(relation.directions.fromRegionEdgeIds);
  const contextToRegion = new Set(relation.directions.fromUnassignedNodeEdgeIds);
  const core = new Set(relation.backboneEdgeIds);
  return directionalRelationLabel(
    relation.edgeIds.map((edgeId): DirectionalPredicate => {
      if (regionToContext.has(edgeId)) {
        return {
          edgeId,
          fromLabel: regionLabel,
          toLabel: "Context",
          symbol: "→",
          predicate: edgeLabelsById.get(edgeId) ?? edgeId,
          isCore: core.has(edgeId),
        };
      }
      if (contextToRegion.has(edgeId)) {
        return {
          edgeId,
          fromLabel: "Context",
          toLabel: regionLabel,
          symbol: "→",
          predicate: edgeLabelsById.get(edgeId) ?? edgeId,
          isCore: core.has(edgeId),
        };
      }
      return {
        edgeId,
        fromLabel: regionLabel,
        toLabel: "Context",
        symbol: "—",
        predicate: edgeLabelsById.get(edgeId) ?? edgeId,
        isCore: core.has(edgeId),
      };
    }),
  );
}

function RelationLabel({ label }: { label: DirectionalRelationLabel }) {
  const height = relationLabelHeight(label.lines);
  return (
    <g
      className="structure-region-map-relation-label"
      data-edge-count={label.edgeCount}
      data-core-edge-count={label.coreEdgeCount}
    >
      <title>{label.full}</title>
      <rect
        x={-STRUCTURE_REGION_OVERVIEW_RELATION_LABEL_WIDTH / 2}
        y={-height / 2}
        width={STRUCTURE_REGION_OVERVIEW_RELATION_LABEL_WIDTH}
        height={height}
        rx="11"
      />
      <text textAnchor="middle">
        {label.lines.map((line, index) => (
          <tspan
            key={`${index}-${line}`}
            x="0"
            y={(index - (label.lines.length - 1) / 2) * 15 + 3.5}
          >
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function contextLabel(
  context: StructureRegionContext,
  nodeLabelsById: ReadonlyMap<string, string>,
): string {
  const labels = context.nodeIds.slice(0, 2).map((nodeId) => nodeLabelsById.get(nodeId) ?? nodeId);
  const remainder = context.nodeIds.length - labels.length;
  return `${labels.join(" · ")}${remainder > 0 ? ` · +${remainder}` : ""}`;
}

function orthogonalRoutePath(points: readonly StructureRegionOverviewPoint[]): string {
  return points.map(({ x, y }, index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
}

export function StructureRegionCanvas({
  structure,
  model: providedModel,
  viewport = { x: 0, y: 0, scale: 1 },
  surfaceRef,
  framedRegionId,
  onOpenRegion,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onFocusCapture,
  onDoubleClick,
}: {
  structure: Structure;
  model?: StructureRegionCanvasModel | null;
  viewport?: StructureViewport;
  surfaceRef?: Ref<HTMLDivElement>;
  framedRegionId: string | null;
  onOpenRegion: (regionId: string) => void;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
  onPointerCancel?: PointerEventHandler<HTMLDivElement>;
  onFocusCapture?: FocusEventHandler<HTMLDivElement>;
  onDoubleClick?: MouseEventHandler<HTMLDivElement>;
}) {
  const markerPrefix = `structure-region-${useId().replaceAll(":", "")}`;
  const model = providedModel ?? buildStructureRegionCanvasModel(structure);
  if (!model) return null;

  const { regionOverview, regionLayout, contextSurface } = model;
  const regionsById = new Map(regionOverview.regions.map((region) => [region.id, region]));
  const contextsById = new Map(contextSurface.contexts.map((context) => [context.id, context]));
  const relationRoutesById = new Map(model.relationRoutes.map((route) => [route.id, route]));
  const edgeLabelsById = new Map(structure.edges.map((edge) => [edge.id, edge.label]));
  const nodeLabelsById = new Map(structure.nodes.map((node) => [node.id, node.label]));
  const regionLabelsById = new Map(
    regionOverview.regions.map((region) => [region.id, region.label]),
  );
  const width = model.width;
  const height = model.height;

  const accessibleRelations = [
    ...regionOverview.directRelations.map((relation) => {
      const [firstId, secondId] = relation.regionIds;
      const first = regionsById.get(firstId)?.label ?? firstId;
      const second = regionsById.get(secondId)?.label ?? secondId;
      const direction = directRelationDirection(relation);
      const label = buildDirectRegionRelationLabel(relation, edgeLabelsById, regionLabelsById);
      const relationName =
        direction === "first-to-second"
          ? `${first} to ${second}`
          : direction === "second-to-first"
            ? `${second} to ${first}`
            : direction === "undirected"
              ? `${first} and ${second}, undirected`
              : `${first} and ${second}, reciprocal or mixed`;
      return `${relationName}: ${label.full}. ${relation.edgeIds.length} exact factual ${relation.edgeIds.length === 1 ? "Edge" : "Edges"}; ${label.coreEdgeCount} Core.`;
    }),
    ...contextSurface.boundaryRelations.map((relation) => {
      const region = regionsById.get(relation.regionId)?.label ?? relation.regionId;
      const context = contextsById.get(relation.contextId);
      const contextName = context ? contextLabel(context, nodeLabelsById) : "unassigned context";
      const direction = contextRelationDirection(relation);
      const label = buildContextRegionRelationLabel(relation, edgeLabelsById, regionLabelsById);
      const relationName =
        direction === "region-to-context"
          ? `${region} to Context ${contextName}`
          : direction === "context-to-region"
            ? `Context ${contextName} to ${region}`
            : direction === "undirected"
              ? `${region} and Context ${contextName}, undirected`
              : `${region} and Context ${contextName}, reciprocal or mixed`;
      return `${relationName}: ${label.full}. ${relation.edgeIds.length} exact factual ${relation.edgeIds.length === 1 ? "Edge" : "Edges"}; ${label.coreEdgeCount} Core.`;
    }),
  ];

  return (
    <section className="structure-regions-canvas" aria-label={`${structure.title} Regions`}>
      <div className="structure-regions-canvas-intro">
        <div>
          <strong>Comprehension Regions</strong>
          <span>
            {regionOverview.regions.length} Regions · {model.assignedNodeCount}/
            {structure.nodes.length} Nodes assigned
            {model.unassignedNodeCount > 0
              ? ` · ${contextSurface.contexts.length} Context ${contextSurface.contexts.length === 1 ? "component" : "components"}`
              : ""}
          </span>
        </div>
        <p>
          Connections are exact direct factual Edges. Open a Region to inspect its members in Graph.
        </p>
      </div>
      {accessibleRelations.length > 0 && (
        <ul className="structure-region-a11y-relations" aria-label="Exact factual relationships">
          {accessibleRelations.map((relation, index) => (
            <li key={`${index}:${relation}`}>{relation}</li>
          ))}
        </ul>
      )}
      <div
        ref={surfaceRef}
        className="structure-regions-canvas-scroll"
        tabIndex={0}
        aria-label="Regions map。ドラッグまたはホイールで移動、修飾キーとホイールで拡大縮小"
        data-viewport-scale={viewport.scale.toFixed(3)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onFocusCapture={(event) => {
          event.currentTarget.scrollLeft = 0;
          event.currentTarget.scrollTop = 0;
          onFocusCapture?.(event);
        }}
        onScroll={(event) => {
          // The transformed Region map owns its camera. Native focus scrolling
          // would otherwise add an untracked offset to the authored viewport.
          event.currentTarget.scrollLeft = 0;
          event.currentTarget.scrollTop = 0;
        }}
        onDoubleClick={onDoubleClick}
      >
        <div
          className="structure-region-map"
          style={{
            width,
            height,
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          }}
          data-region-count={regionOverview.regions.length}
          data-context-count={contextSurface.contexts.length}
          data-direct-relation-count={regionOverview.directRelations.length}
        >
          <svg
            className="structure-region-map-relations"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id={`${markerPrefix}-arrow`}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path className="structure-region-map-arrowhead" d="M 0 0 L 8 4 L 0 8 z" />
              </marker>
              <marker
                id={`${markerPrefix}-core-arrow`}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path className="structure-region-map-arrowhead core" d="M 0 0 L 8 4 L 0 8 z" />
              </marker>
            </defs>
            {regionOverview.directRelations.map((relation) => {
              const route = relationRoutesById.get(directRelationRouteId(relation));
              if (!route) return null;
              const direction = directRelationDirection(relation);
              const label = buildDirectRegionRelationLabel(
                relation,
                edgeLabelsById,
                regionLabelsById,
              );
              const firstLabel =
                regionsById.get(relation.regionIds[0])?.label ?? relation.regionIds[0];
              const secondLabel =
                regionsById.get(relation.regionIds[1])?.label ?? relation.regionIds[1];
              const coreClass =
                relation.backboneEdgeIds.length === relation.edgeIds.length
                  ? " core"
                  : relation.backboneEdgeIds.length > 0
                    ? " has-core"
                    : "";
              const arrowMarkerId = `${markerPrefix}-${coreClass === " core" ? "core-arrow" : "arrow"}`;
              return (
                <g
                  key={relation.regionIds.join(":")}
                  className={`structure-region-map-relation${coreClass}`}
                  data-direction={direction}
                  data-edge-ids={relation.edgeIds.join(" ")}
                  data-core-edge-count={relation.backboneEdgeIds.length}
                >
                  <title>{`${firstLabel} ${direction} ${secondLabel}: ${label.full} (${relation.edgeIds.length} exact ${relation.edgeIds.length === 1 ? "Edge" : "Edges"})`}</title>
                  <path
                    className="structure-region-map-relation-line"
                    d={orthogonalRoutePath(route.points)}
                    data-route-points={route.points.map(({ x, y }) => `${x},${y}`).join(" ")}
                    markerStart={
                      relation.directions.fromSecondRegionEdgeIds.length > 0
                        ? `url(#${arrowMarkerId})`
                        : undefined
                    }
                    markerEnd={
                      relation.directions.fromFirstRegionEdgeIds.length > 0
                        ? `url(#${arrowMarkerId})`
                        : undefined
                    }
                  />
                  {route.labelLeaderPoints.length > 1 && (
                    <path
                      className="structure-region-map-label-leader"
                      d={orthogonalRoutePath(route.labelLeaderPoints)}
                    />
                  )}
                  <g transform={`translate(${route.labelCenter.x} ${route.labelCenter.y})`}>
                    <RelationLabel label={label} />
                  </g>
                </g>
              );
            })}
            {contextSurface.boundaryRelations.map((relation) => {
              const route = relationRoutesById.get(contextRelationRouteId(relation));
              if (!route) return null;
              const direction = contextRelationDirection(relation);
              const label = buildContextRegionRelationLabel(
                relation,
                edgeLabelsById,
                regionLabelsById,
              );
              const regionLabel = regionsById.get(relation.regionId)?.label ?? relation.regionId;
              const context = contextsById.get(relation.contextId);
              const contextName = context
                ? contextLabel(context, nodeLabelsById)
                : "unassigned context";
              const coreClass =
                relation.backboneEdgeIds.length === relation.edgeIds.length
                  ? " core"
                  : relation.backboneEdgeIds.length > 0
                    ? " has-core"
                    : "";
              const arrowMarkerId = `${markerPrefix}-${coreClass === " core" ? "core-arrow" : "arrow"}`;
              return (
                <g
                  key={`${relation.regionId}:${relation.contextId}`}
                  className={`structure-region-map-relation context-boundary${coreClass}`}
                  data-direction={direction}
                  data-edge-ids={relation.edgeIds.join(" ")}
                  data-core-edge-count={relation.backboneEdgeIds.length}
                >
                  <title>{`${regionLabel} ${direction} Context ${contextName}: ${label.full} (${relation.edgeIds.length} exact ${relation.edgeIds.length === 1 ? "Edge" : "Edges"})`}</title>
                  <path
                    className="structure-region-map-relation-line"
                    d={orthogonalRoutePath(route.points)}
                    data-route-points={route.points.map(({ x, y }) => `${x},${y}`).join(" ")}
                    markerStart={
                      relation.directions.fromUnassignedNodeEdgeIds.length > 0
                        ? `url(#${arrowMarkerId})`
                        : undefined
                    }
                    markerEnd={
                      relation.directions.fromRegionEdgeIds.length > 0
                        ? `url(#${arrowMarkerId})`
                        : undefined
                    }
                  />
                  {route.labelLeaderPoints.length > 1 && (
                    <path
                      className="structure-region-map-label-leader"
                      d={orthogonalRoutePath(route.labelLeaderPoints)}
                    />
                  )}
                  <g transform={`translate(${route.labelCenter.x} ${route.labelCenter.y})`}>
                    <RelationLabel label={label} />
                  </g>
                </g>
              );
            })}
          </svg>

          {regionLayout.regions.map((layoutRegion) => {
            const region = regionsById.get(layoutRegion.regionId);
            if (!region) return null;
            const isStart = region.id === regionOverview.startRegionId;
            const isCore = region.backboneEdgeIds.length > 0;
            const isFramed = framedRegionId === region.id;
            return (
              <button
                type="button"
                key={region.id}
                className="structure-region-map-card"
                data-region-id={region.id}
                data-start-region={isStart ? "true" : undefined}
                data-framed-region={isFramed ? "true" : undefined}
                aria-label={`Open region ${region.label} in Graph, ${region.nodeCount} ${region.nodeCount === 1 ? "node" : "nodes"}. ${region.summary}`}
                title={`${region.summary}\nOpen exact members in Graph`}
                onClick={() => onOpenRegion(region.id)}
                style={{
                  left:
                    layoutRegion.center.x + MAP_PADDING - STRUCTURE_REGION_OVERVIEW_CARD_WIDTH / 2,
                  top:
                    layoutRegion.center.y + MAP_PADDING - STRUCTURE_REGION_OVERVIEW_CARD_HEIGHT / 2,
                  width: STRUCTURE_REGION_OVERVIEW_CARD_WIDTH,
                  height: STRUCTURE_REGION_OVERVIEW_CARD_HEIGHT,
                }}
              >
                <span className="structure-region-map-card-heading">
                  <strong>{region.label}</strong>
                  {isStart && <span className="structure-region-map-card-start">Start</span>}
                  {isCore && <span className="structure-region-map-card-core">Core</span>}
                </span>
                <span className="structure-region-map-card-summary">{region.summary}</span>
                <span className="structure-region-map-card-count">
                  {region.nodeCount} {region.nodeCount === 1 ? "Node" : "Nodes"} ·{" "}
                  {region.adjacentRegionIds.length} direct Region{" "}
                  {region.adjacentRegionIds.length === 1 ? "connection" : "connections"}
                  {isFramed ? " · Framed in Graph" : ""}
                </span>
              </button>
            );
          })}

          {model.contextLayouts.map((layoutContext) => {
            const context = contextsById.get(layoutContext.contextId);
            if (!context) return null;
            const isStart = context.nodeIds.includes(structure.presentation!.startNodeId);
            const isCore = context.backboneEdgeIds.length > 0;
            const label = contextLabel(context, nodeLabelsById);
            return (
              <article
                key={context.id}
                className="structure-region-context-card"
                data-context-id={context.id}
                data-start-context={isStart ? "true" : undefined}
                data-core-context={isCore ? "true" : undefined}
                aria-label={`Unassigned Context: ${label}. ${context.nodeIds.length} ${context.nodeIds.length === 1 ? "node" : "nodes"}.`}
                style={{
                  left: layoutContext.center.x + MAP_PADDING - CONTEXT_CARD_WIDTH / 2,
                  top: layoutContext.center.y + MAP_PADDING - CONTEXT_CARD_HEIGHT / 2,
                  width: CONTEXT_CARD_WIDTH,
                  height: CONTEXT_CARD_HEIGHT,
                }}
              >
                <span className="structure-region-context-card-heading">
                  <strong>Context</strong>
                  {isStart && <span className="structure-region-context-card-start">Start</span>}
                  {isCore && <span className="structure-region-context-card-core">Core</span>}
                </span>
                <span className="structure-region-context-card-label" title={label}>
                  {label}
                </span>
                <span className="structure-region-context-card-count">
                  {context.nodeIds.length} {context.nodeIds.length === 1 ? "Node" : "Nodes"} ·{" "}
                  {context.internalEdgeIds.length} internal · {context.boundaryEdgeIds.length}{" "}
                  boundary
                </span>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
