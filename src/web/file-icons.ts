import completeDefinitions from "@pierre/vscode-icons/scripts/themes/complete.mjs";
import defaultDefinitions from "@pierre/vscode-icons/scripts/themes/default.mjs";
import minimalDefinitions from "@pierre/vscode-icons/scripts/themes/minimal.mjs";
import type { TreeEntryKind } from "../domain/models.js";

interface IconColorPair {
  dark: string;
  light: string;
}

type IconColor = IconColorPair | { fg: IconColorPair; bg: IconColorPair };

interface IconDefinition {
  name: string;
  svgName?: string;
  color?: IconColor;
  fileExtensions?: string[];
  fileNames?: string[];
}

export interface ResolvedFileIcon {
  name: string;
  svgName: string;
  foreground: IconColorPair;
  background: IconColorPair;
}

const fallbackColor: IconColorPair = { dark: "#adadb1", light: "#6c6c71" };
const definitions: IconDefinition[] = [
  ...minimalDefinitions,
  ...defaultDefinitions,
  ...completeDefinitions,
];
const definitionsByName = new Map<string, IconDefinition>();
const iconsByFileName = new Map<string, IconDefinition>();
const iconsByExtension = new Map<string, IconDefinition>();

for (const definition of definitions) {
  definitionsByName.set(definition.name, definition);
  for (const fileName of definition.fileNames ?? []) {
    iconsByFileName.set(fileName, definition);
    iconsByFileName.set(fileName.toLocaleLowerCase(), definition);
  }
  for (const extension of definition.fileExtensions ?? []) {
    iconsByExtension.set(extension.toLocaleLowerCase(), definition);
  }
}

function resolveColors(color: IconColor | undefined): {
  foreground: IconColorPair;
  background: IconColorPair;
} {
  if (!color) return { foreground: fallbackColor, background: fallbackColor };
  if ("fg" in color) return { foreground: color.fg, background: color.bg };
  return { foreground: color, background: color };
}

function resolved(definition: IconDefinition): ResolvedFileIcon {
  return {
    name: definition.name,
    svgName: definition.svgName ?? definition.name,
    ...resolveColors(definition.color),
  };
}

function baseName(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.split("/").at(-1) ?? normalized;
}

function extensionCandidates(fileName: string): string[] {
  const lowerName = fileName.toLocaleLowerCase();
  const candidates: string[] = [];
  for (let index = lowerName.indexOf("."); index >= 0; index = lowerName.indexOf(".", index + 1)) {
    const suffix = lowerName.slice(index + 1);
    if (suffix) candidates.push(suffix);
  }
  if (candidates.length === 0) candidates.push(lowerName);
  return candidates;
}

function namedIcon(name: string): ResolvedFileIcon {
  const definition = definitionsByName.get(name);
  if (!definition) throw new Error(`vscode-icons definition is missing: ${name}`);
  return resolved(definition);
}

export function resolveFileIcon(path: string, kind: TreeEntryKind = "file"): ResolvedFileIcon {
  if (kind === "symlink") return namedIcon("file-symlink-duo");
  if (kind === "submodule") {
    return {
      name: "submodule",
      svgName: "IconLayers3Middle",
      foreground: fallbackColor,
      background: fallbackColor,
    };
  }

  const fileName = baseName(path);
  const byFileName =
    iconsByFileName.get(fileName) ?? iconsByFileName.get(fileName.toLocaleLowerCase());
  if (byFileName) return resolved(byFileName);

  for (const candidate of extensionCandidates(fileName)) {
    const byExtension = iconsByExtension.get(candidate);
    if (byExtension) return resolved(byExtension);
  }
  return namedIcon("file-duo");
}

export function resolveFolderIcon(expanded: boolean): ResolvedFileIcon {
  return namedIcon(expanded ? "folder-open-duo" : "folder-duo");
}
