import { memo, useEffect, useMemo, useRef, useState } from "react";
import { changedFilePath } from "../../domain/changed-file.js";
import type { ChangedFile, ChangeKind, TreeEntryKind } from "../../domain/models.js";
import { FileEntryIcon, FolderIcon } from "./FileIcon.js";

export interface FileTreeFile {
  path: string;
  entryKind: TreeEntryKind;
  changeKind?: ChangeKind;
}

export function decorateAllFilesWithChanges(
  files: FileTreeFile[],
  changes: ChangedFile[],
): FileTreeFile[] {
  const changesByPath = new Map<string, ChangeKind>();
  for (const change of changes) {
    const path = changedFilePath(change);
    if (path) changesByPath.set(path, change.kind);
  }

  const decorated = files.map((file) => {
    const changeKind = changesByPath.get(file.path);
    return changeKind ? { ...file, changeKind } : file;
  });
  const existingPaths = new Set(files.map((file) => file.path));

  for (const change of changes) {
    const path = changedFilePath(change);
    if (change.kind === "deleted" && path && !existingPaths.has(path)) {
      decorated.push({ path, entryKind: "file", changeKind: "deleted" });
    }
  }

  return decorated;
}

export type FileTreeNode =
  | {
      kind: "directory";
      name: string;
      path: string;
      children: FileTreeNode[];
    }
  | {
      kind: "file";
      name: string;
      path: string;
      entryKind: TreeEntryKind;
      changeKind?: ChangeKind;
    };

interface MutableDirectory {
  kind: "mutable-directory";
  name: string;
  path: string;
  children: Map<string, MutableDirectory | FileTreeNode>;
}

const changeLabels: Record<ChangeKind, string> = {
  added: "追加",
  deleted: "削除",
  modified: "変更",
  renamed: "名前変更",
  "type-changed": "種類変更",
};

function compareNodes(left: FileTreeNode, right: FileTreeNode): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function freezeDirectory(directory: MutableDirectory): FileTreeNode {
  return {
    kind: "directory",
    name: directory.name,
    path: directory.path,
    children: [...directory.children.values()]
      .map((child) => (child.kind === "mutable-directory" ? freezeDirectory(child) : child))
      .sort(compareNodes),
  };
}

export function buildFileTree(files: FileTreeFile[]): FileTreeNode[] {
  const root: MutableDirectory = {
    kind: "mutable-directory",
    name: "",
    path: "",
    children: new Map(),
  };

  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    if (segments.length === 0) continue;

    let parent = root;
    for (const [index, segment] of segments.entries()) {
      const path = segments.slice(0, index + 1).join("/");
      const isFile = index === segments.length - 1;
      if (isFile) {
        parent.children.set(segment, {
          kind: "file",
          name: segment,
          path: file.path,
          entryKind: file.entryKind,
          ...(file.changeKind ? { changeKind: file.changeKind } : {}),
        });
        continue;
      }

      const existing = parent.children.get(segment);
      if (existing?.kind === "mutable-directory") {
        parent = existing;
        continue;
      }

      const directory: MutableDirectory = {
        kind: "mutable-directory",
        name: segment,
        path,
        children: new Map(),
      };
      parent.children.set(segment, directory);
      parent = directory;
    }
  }

  return [...root.children.values()]
    .map((child) => (child.kind === "mutable-directory" ? freezeDirectory(child) : child))
    .sort(compareNodes);
}

function directoryPaths(nodes: FileTreeNode[]): Set<string> {
  const paths = new Set<string>();
  const visit = (node: FileTreeNode): void => {
    if (node.kind === "file") return;
    paths.add(node.path);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return paths;
}

export interface FileTreeRow {
  node: FileTreeNode;
  depth: number;
}

export function flattenFileTree(
  nodes: FileTreeNode[],
  expandedDirectories: ReadonlySet<string>,
  filtering: boolean,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const visit = (node: FileTreeNode, depth: number): void => {
    rows.push({ node, depth });
    if (node.kind === "directory" && (filtering || expandedDirectories.has(node.path))) {
      node.children.forEach((child) => visit(child, depth + 1));
    }
  };
  nodes.forEach((node) => visit(node, 0));
  return rows;
}

export interface FileTreeRenderWindow {
  start: number;
  end: number;
}

export function calculateFileTreeRenderWindow(
  rowCount: number,
  viewportOffset: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
): FileTreeRenderWindow {
  if (rowCount <= 0) return { start: 0, end: 0 };
  const firstVisible = Math.min(rowCount - 1, Math.max(0, Math.floor(viewportOffset / rowHeight)));
  const lastVisible = Math.min(
    rowCount,
    Math.max(firstVisible + 1, Math.ceil((viewportOffset + viewportHeight) / rowHeight)),
  );
  return {
    start: Math.max(0, firstVisible - overscan),
    end: Math.min(rowCount, lastVisible + overscan),
  };
}

function directoryPathsForFile(path: string | null, directories: ReadonlySet<string>): Set<string> {
  if (!path) return new Set();
  const segments = path.split("/").filter(Boolean);
  const paths = new Set<string>();
  for (let index = 1; index < segments.length; index += 1) {
    const directoryPath = segments.slice(0, index).join("/");
    if (directories.has(directoryPath)) paths.add(directoryPath);
  }
  return paths;
}

export function ExpandCollapseAllIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      {expanded ? (
        <>
          <path
            fill="currentColor"
            d="M3.72 3.97a.75.75 0 0 1 1.06 0L8 7.19l3.22-3.22a.75.75 0 1 1 1.06 1.06L8.53 8.78a.75.75 0 0 1-1.06 0L3.72 5.03a.75.75 0 0 1 0-1.06Z"
          />
          <path
            fill="currentColor"
            d="M3.72 8.97a.75.75 0 0 1 1.06 0L8 12.19l3.22-3.22a.75.75 0 1 1 1.06 1.06l-3.75 3.75a.75.75 0 0 1-1.06 0l-3.75-3.75a.75.75 0 0 1 0-1.06Z"
          />
        </>
      ) : (
        <>
          <path
            fill="currentColor"
            d="M3.72 7.03a.75.75 0 0 0 1.06 0L8 3.81l3.22 3.22a.75.75 0 1 0 1.06-1.06L8.53 2.22a.75.75 0 0 0-1.06 0L3.72 5.97a.75.75 0 0 0 0 1.06Z"
          />
          <path
            fill="currentColor"
            d="M3.72 12.03a.75.75 0 0 0 1.06 0L8 8.81l3.22 3.22a.75.75 0 1 0 1.06-1.06L8.53 7.22a.75.75 0 0 0-1.06 0l-3.75 3.75a.75.75 0 0 0 0 1.06Z"
          />
        </>
      )}
    </svg>
  );
}

export function ChangeIcon({ kind }: { kind: ChangeKind }) {
  const title = changeLabels[kind];
  return (
    <span
      className={`file-change-icon file-change-icon--${kind}`}
      title={title}
      role="img"
      aria-label={title}
      data-change-kind={kind}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {kind === "added" && (
          <>
            <circle cx="8" cy="8" r="6" />
            <path d="M8 5v6M5 8h6" />
          </>
        )}
        {kind === "deleted" && (
          <>
            <circle cx="8" cy="8" r="6" />
            <path d="M5 8h6" />
          </>
        )}
        {kind === "modified" && (
          <>
            <path d="m3 10.5-.5 3 3-.5L12 6.5 9.5 4z" />
            <path d="m8.5 5 2.5 2.5" />
          </>
        )}
        {kind === "renamed" && (
          <>
            <path d="M2 5h9M9 2.75 11.25 5 9 7.25" />
            <path d="M14 11H5m2 2.25L4.75 11 7 8.75" />
          </>
        )}
        {kind === "type-changed" && (
          <>
            <path d="m8 2 5 3-5 3-5-3zM3 8l5 3 5-3M3 11l5 3 5-3" />
          </>
        )}
      </svg>
    </span>
  );
}

interface FileTreeProps {
  files: FileTreeFile[];
  activePath: string | null;
  filtering: boolean;
  initiallyExpanded: "all" | "active-file";
  onOpenFile: (path: string, openInRightPane: boolean) => void;
}

const FILE_TREE_ROW_HEIGHT = 31;
const FILE_TREE_OVERSCAN = 10;
const FILE_TREE_VIRTUALIZATION_THRESHOLD = 400;

function FileTreeComponent({
  files,
  activePath,
  filtering,
  initiallyExpanded,
  onOpenFile,
}: FileTreeProps) {
  const nodes = useMemo(() => buildFileTree(files), [files]);
  const allDirectories = useMemo(() => directoryPaths(nodes), [nodes]);
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() =>
    initiallyExpanded === "all"
      ? new Set(allDirectories)
      : directoryPathsForFile(activePath, allDirectories),
  );
  const rows = useMemo(
    () => flattenFileTree(nodes, expandedDirectories, filtering),
    [expandedDirectories, filtering, nodes],
  );
  const virtualized = rows.length > FILE_TREE_VIRTUALIZATION_THRESHOLD;
  const treeRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ offset: 0, height: 600 });

  useEffect(() => {
    const tree = treeRef.current;
    const scroller = tree?.closest<HTMLElement>(".sidebar-stack-body");
    if (!tree || !scroller || !virtualized) return;

    let animationFrame: number | null = null;
    const measure = (): void => {
      animationFrame = null;
      const treeBounds = tree.getBoundingClientRect();
      const scrollerBounds = scroller.getBoundingClientRect();
      const visibleTop = Math.max(treeBounds.top, scrollerBounds.top);
      const visibleBottom = Math.min(treeBounds.bottom, scrollerBounds.bottom);
      const next = {
        offset: Math.max(0, scrollerBounds.top - treeBounds.top),
        height: Math.max(0, visibleBottom - visibleTop),
      };
      setViewport((current) =>
        Math.abs(current.offset - next.offset) < 0.5 && Math.abs(current.height - next.height) < 0.5
          ? current
          : next,
      );
    };
    const scheduleMeasure = (): void => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(measure);
    };

    measure();
    scroller.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(scroller);
    observer.observe(tree);
    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
      scroller.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [rows.length, virtualized]);

  const renderWindow = virtualized
    ? calculateFileTreeRenderWindow(
        rows.length,
        viewport.offset,
        viewport.height,
        FILE_TREE_ROW_HEIGHT,
        FILE_TREE_OVERSCAN,
      )
    : { start: 0, end: rows.length };
  const activeFileDirectories = useMemo(
    () => directoryPathsForFile(activePath, allDirectories),
    [activePath, allDirectories],
  );
  useEffect(() => {
    if (activeFileDirectories.size === 0) return;
    setExpandedDirectories((current) => {
      if ([...activeFileDirectories].every((path) => current.has(path))) return current;
      return new Set([...current, ...activeFileDirectories]);
    });
  }, [activeFileDirectories]);
  const allExpanded =
    allDirectories.size > 0 && [...allDirectories].every((path) => expandedDirectories.has(path));

  const toggleDirectory = (path: string): void => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderRow = ({ node, depth }: FileTreeRow, index: number) => {
    const rowStyle = {
      top: `${index * FILE_TREE_ROW_HEIGHT}px`,
      paddingLeft: `${8 + depth * 14}px`,
    };
    if (node.kind === "file") {
      return (
        <button
          type="button"
          className={`file-tree-row file-tree-file${activePath === node.path ? " active" : ""}`}
          key={node.path}
          onMouseDown={(event) => {
            if (!event.metaKey && !event.ctrlKey) return;
            event.preventDefault();
            onOpenFile(node.path, true);
          }}
          onClick={(event) => {
            if (!event.metaKey && !event.ctrlKey) onOpenFile(node.path, false);
          }}
          onContextMenu={(event) => {
            if (event.ctrlKey || event.metaKey) event.preventDefault();
          }}
          title={node.path}
          aria-label={node.path}
          style={rowStyle}
        >
          <span className="directory-chevron" aria-hidden="true" />
          <span className="file-tree-icon-group">
            <FileEntryIcon path={node.path} kind={node.entryKind} />
            {node.changeKind && <ChangeIcon kind={node.changeKind} />}
          </span>
          <span className="file-tree-label">{node.name}</span>
        </button>
      );
    }

    const expanded = filtering || expandedDirectories.has(node.path);
    return (
      <button
        type="button"
        className="file-tree-row file-tree-directory"
        key={node.path}
        onClick={() => toggleDirectory(node.path)}
        title={node.path}
        aria-label={`${node.path} フォルダ`}
        aria-expanded={expanded}
        style={rowStyle}
      >
        <span className="directory-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="file-tree-icon-group" aria-hidden="true">
          <FolderIcon expanded={expanded} />
        </span>
        <span className="file-tree-label">{node.name}</span>
      </button>
    );
  };

  return (
    <>
      <div className="file-tree-summary">
        <span>{files.length}ファイル</span>
        <button
          type="button"
          disabled={allDirectories.size === 0 || filtering}
          aria-label={
            allExpanded ? "ファイルツリーをすべて折りたたむ" : "ファイルツリーをすべて展開"
          }
          title={
            filtering
              ? "ファイル名の絞り込み中はすべて展開します"
              : allExpanded
                ? "すべて折りたたむ"
                : "すべて展開"
          }
          onClick={() => setExpandedDirectories(allExpanded ? new Set() : new Set(allDirectories))}
        >
          <ExpandCollapseAllIcon expanded={allExpanded} />
        </button>
      </div>
      <div
        ref={treeRef}
        className="file-tree-virtualized"
        data-file-tree-row-count={rows.length}
        data-virtualized={virtualized ? "true" : "false"}
        style={{ height: `${rows.length * FILE_TREE_ROW_HEIGHT}px` }}
      >
        {rows
          .slice(renderWindow.start, renderWindow.end)
          .map((row, offset) => renderRow(row, renderWindow.start + offset))}
      </div>
    </>
  );
}

export const FileTree = memo(FileTreeComponent);
FileTree.displayName = "FileTree";
