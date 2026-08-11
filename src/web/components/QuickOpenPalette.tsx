import fuzzysort from "fuzzysort";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { ChangeKind, TreeEntryKind } from "../../domain/models.js";
import { documentTabKey, type ActiveDocument, type DocumentPaneId } from "../document-workspace.js";
import { FileEntryIcon } from "./FileIcon.js";
import { ChangeIcon } from "./FileTree.js";

export interface QuickOpenFile {
  path: string;
  entryKind: TreeEntryKind;
  changeKind?: ChangeKind;
}

export interface QuickOpenCandidate extends QuickOpenFile {
  key: string;
  document: ActiveDocument;
  name: string;
  directory: string;
  isActive: boolean;
  isOpen: boolean;
}

export interface QuickOpenMatch {
  candidate: QuickOpenCandidate;
  nameMatch: Fuzzysort.Result | null;
  pathMatch: Fuzzysort.Result | null;
}

function pathParts(path: string): { name: string; directory: string } {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex < 0
    ? { name: path, directory: "" }
    : { name: path.slice(slashIndex + 1), directory: path.slice(0, slashIndex) };
}

export function rankQuickOpenCandidates(
  candidates: QuickOpenCandidate[],
  rawQuery: string,
  limit = 100,
): QuickOpenMatch[] {
  const query = rawQuery.trim();
  if (!query) {
    return [...candidates]
      .sort((left, right) => {
        if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
        if (left.isOpen !== right.isOpen) return left.isOpen ? -1 : 1;
        return left.path.localeCompare(right.path);
      })
      .slice(0, limit)
      .map((candidate) => ({ candidate, nameMatch: null, pathMatch: null }));
  }

  const queryLower = query.toLocaleLowerCase();
  return fuzzysort
    .go(query, candidates, {
      keys: ["name", "path"],
      limit,
      threshold: 0.08,
      scoreFn: (result) => {
        const candidate = result.obj;
        const nameScore = result[0]?.score ?? 0;
        const pathScore = result[1]?.score ?? 0;
        const nameLower = candidate.name.toLocaleLowerCase();
        const exactBonus = nameLower === queryLower ? 0.3 : 0;
        const prefixBonus = nameLower.startsWith(queryLower) ? 0.16 : 0;
        return Math.max(nameScore + 0.1 + exactBonus + prefixBonus, pathScore);
      },
    })
    .map((result) => ({
      candidate: result.obj,
      nameMatch: result[0] ?? null,
      pathMatch: result[1] ?? null,
    }));
}

function HighlightedText({
  value,
  indexes,
  offset = 0,
}: {
  value: string;
  indexes: ReadonlyArray<number> | undefined;
  offset?: number;
}) {
  const selectedIndexes = new Set(
    (indexes ?? [])
      .filter((index) => index >= offset && index < offset + value.length)
      .map((index) => index - offset),
  );
  if (selectedIndexes.size === 0) return value;

  const fragments: ReactNode[] = [];
  let segment = "";
  let segmentMatched = selectedIndexes.has(0);
  const pushSegment = (key: number): void => {
    if (!segment) return;
    fragments.push(
      segmentMatched ? <mark key={key}>{segment}</mark> : <Fragment key={key}>{segment}</Fragment>,
    );
    segment = "";
  };
  for (let index = 0; index < value.length; index += 1) {
    const matched = selectedIndexes.has(index);
    if (matched !== segmentMatched) {
      pushSegment(index);
      segmentMatched = matched;
    }
    segment += value[index];
  }
  pushSegment(value.length);
  return fragments;
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.5 10.5 3.25 3.25" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function candidateForDocument(
  document: ActiveDocument,
  file: QuickOpenFile,
  activeKey: string | null,
  openKeys: ReadonlySet<string>,
): QuickOpenCandidate {
  const key = documentTabKey(document);
  const parts = pathParts(file.path);
  return {
    ...file,
    ...parts,
    key,
    document,
    isActive: key === activeKey,
    isOpen: openKeys.has(key),
  };
}

export function QuickOpenPalette({
  open,
  returnFocusElement,
  files,
  openDocuments,
  activeDocument,
  activePane,
  loading,
  error,
  onClose,
  onOpen,
}: {
  open: boolean;
  returnFocusElement?: HTMLElement | null;
  files: QuickOpenFile[];
  openDocuments: ActiveDocument[];
  activeDocument: ActiveDocument | null;
  activePane: DocumentPaneId;
  loading: boolean;
  error: Error | null;
  onClose: () => void;
  onOpen: (document: ActiveDocument) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedResultRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const activeKey = activeDocument ? documentTabKey(activeDocument) : null;
  const openKeys = useMemo(
    () => new Set(openDocuments.map((document) => documentTabKey(document))),
    [openDocuments],
  );
  const candidates = useMemo(() => {
    const pullRequestDocument: ActiveDocument = { kind: "pull-request-markdown" };
    return [
      candidateForDocument(
        pullRequestDocument,
        { path: "Pull Request.md", entryKind: "file" },
        activeKey,
        openKeys,
      ),
      ...files.map((file) =>
        candidateForDocument(
          { kind: "repository-file", path: file.path },
          file,
          activeKey,
          openKeys,
        ),
      ),
    ];
  }, [activeKey, files, openKeys]);
  const results = useMemo(() => rankQuickOpenCandidates(candidates, query), [candidates, query]);
  const selectedResult = results[activeIndex] ?? null;
  const paneLabel = activePane === "left" ? "左ペイン" : "右ペイン";

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      returnFocusElement ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setQuery("");
    setActiveIndex(0);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
  }, [open, returnFocusElement]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (activeIndex >= results.length) setActiveIndex(Math.max(0, results.length - 1));
  }, [activeIndex, results.length]);

  useEffect(() => {
    selectedResultRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  const chooseResult = (result: QuickOpenMatch | null): void => {
    if (!result) return;
    onOpen(result.candidate.document);
    onClose();
  };
  const moveSelection = (offset: number): void => {
    if (results.length === 0) return;
    setActiveIndex((current) => (current + offset + results.length) % results.length);
  };
  const handleKeyboardNavigation = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "PageDown") {
      event.preventDefault();
      moveSelection(10);
    } else if (event.key === "PageUp") {
      event.preventDefault();
      moveSelection(-10);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, results.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      chooseResult(selectedResult);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  };

  return (
    <div className="quick-open-backdrop" onMouseDown={onClose}>
      <section
        className="quick-open-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="ファイルを開く"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="quick-open-input-shell">
          <SearchIcon />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="ファイル名で検索"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="quick-open-results"
            aria-activedescendant={selectedResult ? `quick-open-result-${activeIndex}` : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyboardNavigation}
            placeholder="ファイル名を入力して移動"
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button
              className="quick-open-clear"
              aria-label="入力を消去"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              ×
            </button>
          )}
        </div>
        <div className="quick-open-summary">
          <span>{query ? `${results.length}件の一致` : "開いている文書と全ファイル"}</span>
          <span>{paneLabel}に開く</span>
        </div>
        <div className="quick-open-results" id="quick-open-results" role="listbox">
          {error ? (
            <div className="quick-open-state" role="status">
              <strong>ファイル一覧を読み込めませんでした。</strong>
              <span>{error.message}</span>
            </div>
          ) : results.length > 0 ? (
            results.map((result, index) => {
              const { candidate, nameMatch, pathMatch } = result;
              const isSelected = index === activeIndex;
              const directoryOffset = 0;
              return (
                <button
                  key={candidate.key}
                  ref={isSelected ? selectedResultRef : undefined}
                  id={`quick-open-result-${index}`}
                  className={`quick-open-result${isSelected ? " selected" : ""}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-label={`${candidate.path}${candidate.isOpen ? "、開いています" : ""}`}
                  tabIndex={-1}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseResult(result)}
                >
                  <span className="quick-open-icon-group" aria-hidden="true">
                    <FileEntryIcon path={candidate.path} kind={candidate.entryKind} />
                    {candidate.changeKind && <ChangeIcon kind={candidate.changeKind} />}
                  </span>
                  <span className="quick-open-copy">
                    <strong>
                      <HighlightedText
                        value={candidate.name}
                        indexes={nameMatch?.indexes ?? pathMatch?.indexes}
                        offset={nameMatch ? 0 : candidate.path.length - candidate.name.length}
                      />
                    </strong>
                    {candidate.directory && (
                      <span>
                        <HighlightedText
                          value={candidate.directory}
                          indexes={pathMatch?.indexes}
                          offset={directoryOffset}
                        />
                      </span>
                    )}
                  </span>
                  {candidate.isActive ? (
                    <span className="quick-open-badge">選択中</span>
                  ) : candidate.isOpen ? (
                    <span className="quick-open-open-dot" title="開いています" aria-hidden="true" />
                  ) : null}
                </button>
              );
            })
          ) : loading && !query ? (
            <div className="quick-open-state" role="status">
              ファイル一覧を読み込んでいます…
            </div>
          ) : (
            <div className="quick-open-state" role="status">
              <strong>一致するファイルはありません。</strong>
              <span>文字を減らすか、パスの一部を入力してください。</span>
            </div>
          )}
        </div>
        <footer className="quick-open-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 選択
          </span>
          <span>
            <kbd>Enter</kbd> 開く
          </span>
          <span>
            <kbd>Esc</kbd> 閉じる
          </span>
        </footer>
      </section>
    </div>
  );
}
