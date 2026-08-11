import { useEffect, useMemo, useState, type RefObject } from "react";
import type { ChangeKind, SearchResponse, SearchResult } from "../../domain/models.js";
import { ErrorNotice } from "./ErrorNotice.js";
import { FileEntryIcon } from "./FileIcon.js";
import { ChangeIcon, ExpandCollapseAllIcon } from "./FileTree.js";

export interface SearchResultGroup {
  key: string;
  path: string;
  results: SearchResult[];
  matchCount: number;
}

export function splitSearchResultPath(path: string): { fileName: string; directory: string } {
  const separatorIndex = path.lastIndexOf("/");
  if (separatorIndex < 0) return { fileName: path, directory: "" };
  return {
    fileName: path.slice(separatorIndex + 1),
    directory: path.slice(0, separatorIndex),
  };
}

export function groupSearchResults(results: SearchResult[]): SearchResultGroup[] {
  const groups = new Map<string, SearchResultGroup>();
  for (const result of results) {
    const key = `${result.document.kind}:${result.path}`;
    const existing = groups.get(key);
    if (existing) {
      existing.results.push(result);
      existing.matchCount += result.matches.length;
      continue;
    }
    groups.set(key, {
      key,
      path: result.path,
      results: [result],
      matchCount: result.matches.length,
    });
  }
  return [...groups.values()];
}

function SearchIcon() {
  return (
    <svg className="sidebar-stack-icon" aria-hidden="true" viewBox="0 0 16 16">
      <path
        fill="currentColor"
        d="M6.75 1a5.75 5.75 0 1 0 3.58 10.25l3.71 3.71a.75.75 0 1 0 1.06-1.06l-3.71-3.71A5.75 5.75 0 0 0 6.75 1Zm-4.25 5.75a4.25 4.25 0 1 1 8.5 0 4.25 4.25 0 0 1-8.5 0Z"
      />
    </svg>
  );
}

function ResultChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        fill="currentColor"
        d={
          expanded
            ? "M3.72 5.97a.75.75 0 0 1 1.06 0L8 9.19l3.22-3.22a.75.75 0 1 1 1.06 1.06l-3.75 3.75a.75.75 0 0 1-1.06 0L3.72 7.03a.75.75 0 0 1 0-1.06Z"
            : "M5.97 3.72a.75.75 0 0 1 1.06 0l3.75 3.75a.75.75 0 0 1 0 1.06l-3.75 3.75a.75.75 0 1 1-1.06-1.06L9.19 8 5.97 4.78a.75.75 0 0 1 0-1.06Z"
        }
      />
    </svg>
  );
}

function HighlightedSearchText({ result }: { result: SearchResult }) {
  const content: React.ReactNode[] = [];
  let offset = 0;
  for (const [index, match] of result.matches.entries()) {
    if (match.start < offset || match.end <= match.start || match.end > result.text.length)
      continue;
    if (match.start > offset) content.push(result.text.slice(offset, match.start));
    content.push(
      <mark key={`${match.start}:${match.end}:${index}`}>
        {result.text.slice(match.start, match.end)}
      </mark>,
    );
    offset = match.end;
  }
  if (offset < result.text.length) content.push(result.text.slice(offset));
  return <>{content}</>;
}

export function SearchStackIcon() {
  return <SearchIcon />;
}

export function SearchPanel({
  inputRef,
  query,
  matchCase,
  wholeWord,
  changeKindsByPath,
  response,
  isFetching,
  error,
  onQueryChange,
  onMatchCaseChange,
  onWholeWordChange,
  onOpenResult,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  changeKindsByPath: ReadonlyMap<string, ChangeKind>;
  response: SearchResponse | undefined;
  isFetching: boolean;
  error: unknown;
  onQueryChange: (query: string) => void;
  onMatchCaseChange: (enabled: boolean) => void;
  onWholeWordChange: (enabled: boolean) => void;
  onOpenResult: (result: SearchResult, openInRightPane: boolean) => void;
}) {
  const groups = useMemo(() => groupSearchResults(response?.results ?? []), [response?.results]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setCollapsedGroups(new Set());
  }, [matchCase, query, wholeWord]);
  const allExpanded = groups.every((group) => !collapsedGroups.has(group.key));
  const normalizedQuery = query.trim();

  return (
    <div className="search-panel">
      <div className="search-input-shell">
        <input
          ref={inputRef}
          aria-label="全文検索"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="全文検索"
          spellCheck={false}
        />
        <div className="search-options" aria-label="検索オプション">
          <button
            className={matchCase ? "active" : ""}
            type="button"
            aria-label="大文字小文字を区別"
            aria-pressed={matchCase}
            title="大文字小文字を区別"
            onClick={() => onMatchCaseChange(!matchCase)}
          >
            Aa
          </button>
          <button
            className={wholeWord ? "active" : ""}
            type="button"
            aria-label="単語単位で検索"
            aria-pressed={wholeWord}
            title="単語単位で検索"
            onClick={() => onWholeWordChange(!wholeWord)}
          >
            <span aria-hidden="true">ab</span>
          </button>
        </div>
      </div>
      {normalizedQuery && (
        <div className="search-summary" aria-live="polite">
          <span>
            {isFetching && !response
              ? "検索しています…"
              : `${response?.matchCount ?? 0}件・${groups.length}ファイル`}
          </span>
          {isFetching && response && <span className="search-refreshing">更新中…</span>}
          <button
            type="button"
            disabled={groups.length === 0}
            aria-label={allExpanded ? "検索結果をすべて折りたたむ" : "検索結果をすべて展開"}
            title={allExpanded ? "すべて折りたたむ" : "すべて展開"}
            onClick={() =>
              setCollapsedGroups(
                allExpanded ? new Set(groups.map((group) => group.key)) : new Set(),
              )
            }
          >
            <ExpandCollapseAllIcon expanded={allExpanded} />
          </button>
        </div>
      )}
      <ErrorNotice error={error} />
      {response?.truncated && <p className="truncated">上限で打ち切りました。</p>}
      {normalizedQuery && !isFetching && !error && response?.results.length === 0 && (
        <p className="search-empty">一致する結果はありません。</p>
      )}
      {groups.length > 0 && (
        <div className="search-results" aria-label="全文検索結果">
          {groups.map((group) => {
            const expanded = !collapsedGroups.has(group.key);
            const { fileName, directory } = splitSearchResultPath(group.path);
            const changeKind =
              group.results[0]?.document.kind === "repository-file"
                ? changeKindsByPath.get(group.path)
                : undefined;
            return (
              <section className="search-result-group" key={group.key}>
                <button
                  type="button"
                  className="search-result-file"
                  aria-expanded={expanded}
                  aria-label={`${group.path}、${group.matchCount}件`}
                  onClick={() =>
                    setCollapsedGroups((current) => {
                      const next = new Set(current);
                      if (next.has(group.key)) next.delete(group.key);
                      else next.add(group.key);
                      return next;
                    })
                  }
                >
                  <span className="search-result-chevron">
                    <ResultChevron expanded={expanded} />
                  </span>
                  <span className="search-result-file-icon-group" aria-hidden="true">
                    <FileEntryIcon path={group.path} kind="file" />
                    {changeKind && <ChangeIcon kind={changeKind} />}
                  </span>
                  <span className="search-result-file-label">
                    <strong>{fileName}</strong>
                    {directory && (
                      <span className="search-result-directory" title={directory}>
                        {directory}
                      </span>
                    )}
                  </span>
                  <span className="search-result-count">{group.matchCount}</span>
                </button>
                {expanded && (
                  <div className="search-result-lines">
                    {group.results.map((result) => (
                      <button
                        type="button"
                        className="search-result-line"
                        aria-label={`${result.path} ${result.line}行`}
                        key={`${result.path}:${result.line}`}
                        onMouseDown={(event) => {
                          if (!event.metaKey && !event.ctrlKey) return;
                          event.preventDefault();
                          onOpenResult(result, true);
                        }}
                        onClick={(event) => {
                          if (!event.metaKey && !event.ctrlKey) onOpenResult(result, false);
                        }}
                        onContextMenu={(event) => {
                          if (event.ctrlKey || event.metaKey) event.preventDefault();
                        }}
                      >
                        <span className="search-result-line-number">{result.line}</span>
                        <code>
                          <HighlightedSearchText result={result} />
                        </code>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
