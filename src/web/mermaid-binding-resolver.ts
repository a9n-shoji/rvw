type MermaidBindingDiagramType =
  | "flowchart"
  | "classDiagram"
  | "sequenceDiagram"
  | "stateDiagram-v2"
  | "erDiagram"
  | "architecture-beta";

interface MermaidBindingTarget {
  bindingKey: string;
  element: SVGGElement;
}

interface MermaidBindingAdapter {
  targets: (
    container: HTMLDivElement,
    bindingKeys: readonly string[],
  ) => Array<{ bindingKey: string; element: SVGGElement }>;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function generatedIdBindingKey(
  elementId: string,
  marker: string,
  numberedSuffix: boolean,
  bindingKeys: readonly string[],
): string | null {
  return (
    [...bindingKeys]
      .sort((left, right) => right.length - left.length)
      .find((bindingKey) => {
        const generatedSuffix = `${marker}${bindingKey}`;
        return numberedSuffix
          ? new RegExp(`${escapeRegularExpression(generatedSuffix)}-\\d+$`).test(elementId)
          : elementId.endsWith(generatedSuffix);
      }) ?? null
  );
}

function generatedIdTargets(
  container: HTMLDivElement,
  selector: string,
  marker: string,
  bindingKeys: readonly string[],
  numberedSuffix = true,
): Array<{ bindingKey: string; element: SVGGElement }> {
  return Array.from(container.querySelectorAll<SVGGElement>(selector)).flatMap((element) => {
    const bindingKey = generatedIdBindingKey(element.id, marker, numberedSuffix, bindingKeys);
    return bindingKey ? [{ bindingKey, element }] : [];
  });
}

const bindingAdapters: Record<MermaidBindingDiagramType, MermaidBindingAdapter> = {
  flowchart: {
    targets: (container, bindingKeys) =>
      generatedIdTargets(container, "g.node[id]", "-flowchart-", bindingKeys),
  },
  classDiagram: {
    targets: (container, bindingKeys) =>
      generatedIdTargets(container, "g.node[id]", "-classId-", bindingKeys),
  },
  sequenceDiagram: {
    targets: (container, bindingKeys) => {
      const bindingKeySet = new Set(bindingKeys);
      return Array.from(
        container.querySelectorAll<SVGGElement>('g[data-et="participant"][data-id]'),
      ).flatMap((element) => {
        const bindingKey = element.dataset.id;
        return bindingKey && bindingKeySet.has(bindingKey) ? [{ bindingKey, element }] : [];
      });
    },
  },
  "stateDiagram-v2": {
    targets: (container, bindingKeys) =>
      generatedIdTargets(container, "g.statediagram-state[id]", "-state-", bindingKeys),
  },
  erDiagram: {
    targets: (container, bindingKeys) =>
      generatedIdTargets(container, "g.node[id]", "-entity-", bindingKeys),
  },
  "architecture-beta": {
    targets: (container, bindingKeys) =>
      generatedIdTargets(container, "g.architecture-service[id]", "-service-", bindingKeys, false),
  },
};

function diagramTypeFromSource(source: string): MermaidBindingDiagramType | null {
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("%%")) continue;
    const diagramType = line.match(
      /^(flowchart|graph|classDiagram|sequenceDiagram|stateDiagram-v2|erDiagram|architecture-beta)\b/,
    )?.[1];
    return diagramType === "graph"
      ? "flowchart"
      : ((diagramType as MermaidBindingDiagramType | undefined) ?? null);
  }
  return null;
}

export function mermaidBindingTargets(
  source: string,
  container: HTMLDivElement,
  bindingKeys: readonly string[],
): MermaidBindingTarget[] {
  const diagramType = diagramTypeFromSource(source);
  if (!diagramType) return [];
  return bindingAdapters[diagramType].targets(container, bindingKeys);
}
