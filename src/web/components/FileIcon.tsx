import type { CSSProperties } from "react";
import type { TreeEntryKind } from "../../domain/models.js";
import { resolveFileIcon, resolveFolderIcon, type ResolvedFileIcon } from "../file-icons.js";

const svgModules = import.meta.glob<string>("/node_modules/@pierre/vscode-icons/svgs/*.svg", {
  eager: true,
  import: "default",
  query: "?raw",
});
const svgSourceByName = new Map(
  Object.entries(svgModules).map(([path, source]) => {
    const fileName = path.split("/").at(-1);
    if (!fileName) throw new Error(`vscode-icons SVG path is invalid: ${path}`);
    return [fileName.replace(/\.svg$/u, ""), source] as const;
  }),
);

interface FileIconStyle extends CSSProperties {
  "--file-icon-dark-bg": string;
  "--file-icon-dark-fg": string;
  "--file-icon-light-bg": string;
  "--file-icon-light-fg": string;
}

function iconStyle(icon: ResolvedFileIcon): FileIconStyle {
  return {
    "--file-icon-dark-bg": icon.background.dark,
    "--file-icon-dark-fg": icon.foreground.dark,
    "--file-icon-light-bg": icon.background.light,
    "--file-icon-light-fg": icon.foreground.light,
  };
}

function TrustedSvgIcon({ icon }: { icon: ResolvedFileIcon }) {
  const source = svgSourceByName.get(icon.svgName);
  if (!source) throw new Error(`vscode-icons SVG is missing: ${icon.svgName}`);
  if (
    !source.trimStart().startsWith("<svg") ||
    /<(?:foreignObject|script)\b|\son[a-z]+\s*=/iu.test(source)
  ) {
    throw new Error(`vscode-icons SVG is unsafe: ${icon.svgName}`);
  }
  return (
    <span
      className={`tree-entry-icon file-type-icon file-type-icon--${icon.name}`}
      data-file-icon={icon.name}
      style={iconStyle(icon)}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: source }}
    />
  );
}

export function FileEntryIcon({ path = "", kind }: { path?: string; kind: TreeEntryKind }) {
  return <TrustedSvgIcon icon={resolveFileIcon(path, kind)} />;
}

export function FolderIcon({ expanded }: { expanded: boolean }) {
  return <TrustedSvgIcon icon={resolveFolderIcon(expanded)} />;
}
