import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import type {
  CommentFeedFilter,
  CommentFeedGroup,
  CommentFeedIndex,
  ReviewComment,
  WalkthroughSummary,
} from "../../domain/models.js";
import { ApiError, api, type CommentsResponse } from "../api.js";
import { CommentThread } from "../components/CommentThread.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { readCommentReplyDraft, subscribeCommentReplyDrafts } from "../comment-draft-store.js";
import type { ThemePreference } from "../theme.js";

function isConnectionError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "LOCAL_SERVER_UNAVAILABLE";
}

export function commentReviewUrl(comment: ReviewComment, extra?: Record<string, string>): string {
  const url = new URL(window.location.href);
  url.hash = "";
  url.searchParams.set("view", "comments");
  url.searchParams.set("pullRequestId", comment.pullRequestId);
  url.searchParams.set("commentId", comment.id);
  for (const [key, value] of Object.entries(extra ?? {})) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

function targetLabel(comment: ReviewComment): string {
  const target = comment.target;
  if (target.kind === "pull-request") return "PR全体";
  const label =
    target.kind === "walkthrough"
      ? target.walkthroughTitle
      : target.documentKind === "repository-file"
        ? target.path
        : "Pull Request.md";
  return `${label}${target.startLine === null ? "" : `:${target.startLine}${target.endLine !== target.startLine ? `–${target.endLine}` : ""}`}`;
}

function followLink(event: MouseEvent<HTMLAnchorElement>, navigate: (url: string) => void): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute("href")!);
}

function FeedGroup({
  connectionUnavailable,
  group,
  active,
  themePreference,
  isExpanded,
  toggle,
  navigate,
}: {
  group: CommentFeedGroup;
  connectionUnavailable: boolean;
  active: boolean;
  themePreference: ThemePreference;
  isExpanded: (id: string) => boolean;
  toggle: (id: string) => void;
  navigate: (url: string) => void;
}) {
  const pr = group.pullRequest;
  const query = useQuery({
    queryKey: ["comments", pr.id],
    queryFn: ({ signal }) =>
      api<CommentsResponse>(`/api/pull-requests/${pr.id}/comments?resolved=all`, { signal }),
    enabled: active,
  });
  const walkthroughQuery = useQuery({
    queryKey: ["walkthroughs", pr.id],
    queryFn: ({ signal }) =>
      api<{ walkthroughs: WalkthroughSummary[] }>(`/api/pull-requests/${pr.id}/walkthroughs`, {
        signal,
      }),
    enabled:
      active &&
      Boolean(query.data?.comments.some((comment) => comment.target.kind === "walkthrough")),
  });
  const byId = new Map(query.data?.comments.map((comment) => [comment.id, comment]));
  const comments = group.commentIds.flatMap((id) => byId.get(id) ?? []);
  const draftIds = useSyncExternalStore(subscribeCommentReplyDrafts, () =>
    group.commentIds
      .filter((id) => readCommentReplyDraft(pr.id, `sidebar:${id}`).body.trim())
      .join(","),
  );
  const drafts = new Set(draftIds ? draftIds.split(",") : []);
  const visibleError = connectionUnavailable && isConnectionError(query.error) ? null : query.error;
  const groupKey = `pr:${pr.id}`;
  const expanded = isExpanded(groupKey);
  const state =
    pr.githubState === "OPEN"
      ? pr.githubIsDraft
        ? "Draft"
        : "Open"
      : pr.githubState === "MERGED"
        ? "Merged"
        : pr.githubState === "CLOSED"
          ? "Closed"
          : null;
  const open = (url: string, newTab: boolean): void => {
    if (newTab) window.open(url, "_blank", "noopener");
    else navigate(url);
  };
  return (
    <section
      className="comment-feed-group"
      aria-label={`${pr.owner}/${pr.repository} #${pr.number}`}
    >
      <header className="comment-feed-group-header">
        <button
          className="comment-feed-group-toggle button--quiet"
          aria-expanded={expanded}
          onClick={() => toggle(groupKey)}
        >
          <span aria-hidden="true">{expanded ? "⌄" : "›"}</span>
          <span>
            <span className="comment-feed-pr-reference">
              {pr.owner}/{pr.repository} <strong>#{pr.number}</strong>
            </span>
            <strong className="comment-feed-pr-title">{pr.title}</strong>
          </span>
        </button>
        <div className="comment-feed-group-meta">
          {state && (
            <span className={`pull-request-status pull-request-status--${state.toLowerCase()}`}>
              {state}
            </span>
          )}
          <span>{query.data ? comments.length : group.commentIds.length} スレッド</span>
          {drafts.size > 0 && <span className="comment-feed-draft">下書き {drafts.size}件</span>}
        </div>
      </header>
      <div hidden={!expanded} className="comment-feed-group-body">
        <ErrorNotice error={visibleError} />
        {query.isPending && <p role="status">コメントを読み込んでいます…</p>}
        {visibleError && (
          <button className="button--quiet" onClick={() => void query.refetch()}>
            再試行
          </button>
        )}
        {query.isSuccess && comments.length === 0 && (
          <p>このPRの表示対象のコメントは削除されました。一覧を更新してください。</p>
        )}
        {comments.map((comment) => {
          const label = targetLabel(comment);
          const threadExpanded = isExpanded(comment.id);
          return (
            <section
              className="comment-feed-thread"
              key={comment.id}
              data-feed-comment-id={comment.id}
            >
              <div className="comment-feed-thread-toolbar">
                <button
                  className="button--quiet comment-feed-thread-toggle"
                  aria-expanded={threadExpanded}
                  aria-label={`${label}のスレッドを${threadExpanded ? "折りたたむ" : "展開"}`}
                  onClick={() => toggle(comment.id)}
                >
                  <span aria-hidden="true">{threadExpanded ? "⌄" : "›"}</span>
                  <span>{label}</span>
                </button>
                {drafts.has(comment.id) && <span className="comment-feed-draft">下書き</span>}
                <a
                  className="comment-feed-open"
                  href={commentReviewUrl(comment)}
                  onClick={(event) => followLink(event, navigate)}
                >
                  PRで開く ↗
                </a>
              </div>
              {!threadExpanded && (
                <div className="comment-feed-collapsed">
                  <span className="comment-feed-excerpt">
                    {comment.posts.find((post) => post.isRoot)?.body}
                  </span>
                  <span>
                    {Math.max(0, comment.posts.length - 1)}返信 ·{" "}
                    {comment.resolvedAt ? "解決済み" : "未解決"}
                  </span>
                </div>
              )}
              <div hidden={!threadExpanded}>
                <CommentThread
                  comment={comment}
                  replyRows={2}
                  replyContextLabel="コメント一覧"
                  themePreference={themePreference}
                  markdownSourceOid={
                    comment.target.kind === "walkthrough"
                      ? walkthroughQuery.data?.walkthroughs.find(
                          (walkthrough) =>
                            comment.target.kind === "walkthrough" &&
                            walkthrough.id === comment.target.walkthroughId,
                        )?.sourceOid
                      : undefined
                  }
                  onOpenCodeReference={(sourceOid, reference, newTab) => {
                    open(
                      commentReviewUrl(comment, {
                        sourceOid,
                        path: reference.path,
                        startLine: String(reference.startLine ?? ""),
                        endLine: String(reference.endLine ?? ""),
                      }),
                      newTab,
                    );
                    return Promise.resolve(null);
                  }}
                  onOpenRepositoryLink={(path, sourceOid, newTab) =>
                    open(commentReviewUrl(comment, { path, sourceOid }), newTab)
                  }
                />
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function FeedResults({
  filters,
  active,
  sequence,
  themePreference,
  isExpanded,
  toggle,
  navigate,
  onOptions,
  connectionUnavailable,
  onClearFilters,
}: {
  filters: CommentFeedFilter;
  active: boolean;
  sequence: number | undefined;
  themePreference: ThemePreference;
  isExpanded: (id: string) => boolean;
  toggle: (id: string) => void;
  navigate: (url: string) => void;
  onOptions: (options: CommentFeedIndex["pullRequests"]) => void;
  connectionUnavailable: boolean;
  onClearFilters: () => void;
}) {
  const client = useQueryClient();
  const [limit, setLimit] = useState(20);
  const [refreshing, setRefreshing] = useState(false);
  const appendRequested = useRef(false);
  const [snapshot, setSnapshot] = useState<CommentFeedIndex | null>(null);
  const params = new URLSearchParams(
    Object.entries({ ...filters, limit }).map(([key, value]) => [key, String(value)]),
  );
  const query = useQuery({
    queryKey: ["comment-feed", params.toString()],
    queryFn: ({ signal }) => api<CommentFeedIndex>(`/api/comment-feed?${params}`, { signal }),
    enabled: active,
  });
  const refetch = useRef(query.refetch);
  refetch.current = query.refetch;
  useEffect(() => {
    if (!active) return;
    void refetch.current();
    void client.invalidateQueries({ queryKey: ["comments"] });
    void client.invalidateQueries({ queryKey: ["walkthroughs"] });
  }, [active, sequence, client, connectionUnavailable]);
  useEffect(() => {
    if (!query.data) return;
    onOptions(query.data.pullRequests);
    const append = appendRequested.current && !query.isFetching;
    if (append) appendRequested.current = false;
    setSnapshot((previous) => {
      if (!previous) return query.data;
      // Loading more appends whole PR groups without reordering existing reading context.
      const existing = new Set(previous.groups.map((group) => group.pullRequest.id));
      if (append) {
        const additions = query.data.groups.filter((group) => !existing.has(group.pullRequest.id));
        if (additions.length) return { ...query.data, groups: [...previous.groups, ...additions] };
      }
      return previous;
    });
  }, [query.data, query.isFetching, onOptions]);
  const visibleError = connectionUnavailable && isConnectionError(query.error) ? null : query.error;
  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      const [result] = await Promise.all([
        query.refetch(),
        client.refetchQueries({ queryKey: ["comments"], type: "active" }),
        client.refetchQueries({ queryKey: ["walkthroughs"], type: "active" }),
      ]);
      if (result.data && !result.error) setSnapshot(result.data);
    } finally {
      setRefreshing(false);
    }
  };
  const changed =
    snapshot &&
    query.data &&
    JSON.stringify(snapshot.groups.map((g) => [g.pullRequest.id, g.commentIds])) !==
      JSON.stringify(query.data.groups.map((g) => [g.pullRequest.id, g.commentIds]));
  return (
    <>
      <ErrorNotice error={visibleError} />
      {visibleError && (
        <button className="button--quiet" onClick={() => void query.refetch()}>
          一覧を再試行
        </button>
      )}
      {query.isPending && !snapshot && <p role="status">コメント一覧を読み込んでいます…</p>}
      {snapshot && (
        <div className="comment-feed-results-meta">
          <span>
            {snapshot.totalGroups} PR · {snapshot.totalComments} スレッド
            <small className="comment-feed-sort-note">最後の投稿が新しい順</small>
          </span>
          <button
            className="button--quiet"
            disabled={query.isFetching || refreshing}
            title="最新のコメントを取得し、並び順と絞り込みを更新します"
            onClick={() => void refresh()}
          >
            {refreshing ? "更新中…" : changed ? "新しい更新を反映" : "一覧を更新"}
          </button>
        </div>
      )}
      {snapshot?.groups.length === 0 && (
        <div className="pull-request-list-empty">
          <h2>
            {snapshot.pullRequests.length === 0
              ? "まだレビュー対象が登録されていません"
              : "条件に一致するコメントはありません"}
          </h2>
          <p>
            {snapshot.pullRequests.length === 0
              ? "rvw open <PR URL> でPull Requestを登録してください。"
              : "状態や検索条件を変更して確認できます。"}
          </p>
          {snapshot.pullRequests.length > 0 && (
            <button className="button--quiet" onClick={onClearFilters}>
              すべてのコメントを表示
            </button>
          )}
        </div>
      )}
      {snapshot?.groups.map((group) => (
        <FeedGroup
          key={group.pullRequest.id}
          group={{
            ...group,
            pullRequest:
              query.data?.pullRequests.find((pr) => pr.id === group.pullRequest.id) ??
              group.pullRequest,
          }}
          active={active}
          connectionUnavailable={connectionUnavailable}
          themePreference={themePreference}
          isExpanded={isExpanded}
          toggle={toggle}
          navigate={navigate}
        />
      ))}
      {snapshot && snapshot.groups.length < snapshot.totalGroups && (
        <div className="comment-feed-load-more">
          <span>
            {snapshot.groups.length} / {snapshot.totalGroups} PRを表示
          </span>
          <button
            disabled={query.isFetching || limit >= 1000}
            onClick={() => {
              appendRequested.current = true;
              setLimit((value) => Math.min(1000, value + 20));
            }}
          >
            さらに20 PRを表示
          </button>
          {limit >= 1000 && <p>リポジトリやPRで絞り込んで続きを確認してください。</p>}
        </div>
      )}
    </>
  );
}

export function CommentFeedScreen({
  active,
  changeSequence,
  heartbeatError,
  themePreference,
  onNavigate,
}: {
  active: boolean;
  changeSequence: number | undefined;
  heartbeatError: unknown;
  themePreference: ThemePreference;
  onNavigate: (url: string) => void;
}) {
  const [filters, setFilters] = useState<CommentFeedFilter>({
    status: "unresolved",
    hideClosedOrMerged: true,
    repository: "",
    pullRequestId: "",
    search: "",
    limit: 20,
  });
  const client = useQueryClient();
  const connectionUnavailable = isConnectionError(heartbeatError);
  const [retrying, setRetrying] = useState(false);
  const retryConnection = async (): Promise<void> => {
    setRetrying(true);
    try {
      await Promise.all(
        ["change-sequence", "comment-feed", "comments", "walkthroughs"].map((key) =>
          client.refetchQueries({ queryKey: [key], type: "active" }),
        ),
      );
    } finally {
      setRetrying(false);
    }
  };
  const clearFilters = (): void => {
    setSearch("");
    setFilters({
      status: "all",
      hideClosedOrMerged: false,
      repository: "",
      pullRequestId: "",
      search: "",
      limit: 20,
    });
  };
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<CommentFeedIndex["pullRequests"]>([]);
  const [defaultExpanded, setDefaultExpanded] = useState(true);
  const [expansions, setExpansions] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const timer = window.setTimeout(() => setFilters((current) => ({ ...current, search })), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (active) document.title = "Comments · rvw";
  }, [active]);
  const isExpanded = (id: string): boolean => expansions[id] ?? defaultExpanded;
  const toggle = (id: string): void =>
    setExpansions((current) => ({ ...current, [id]: !(current[id] ?? defaultExpanded) }));
  const all = (expanded: boolean): void => {
    setDefaultExpanded(expanded);
    setExpansions({});
  };
  return (
    <main className="pull-request-list-screen comment-feed-screen">
      <header className="pull-request-list-header">
        <div className="brand">
          <span className="brand-mark">r</span>
          <strong>rvw</strong>
        </div>
        <div>
          <h1>Comments</h1>
          <p>PRを横断して会話を読み、その場で返信</p>
        </div>
        <nav className="workspace-view-switch" aria-label="一覧の表示">
          <a href="/" onClick={(event) => followLink(event, onNavigate)}>
            Pull Requests
          </a>
          <a
            href="/?view=comments"
            aria-current="page"
            onClick={(event) => followLink(event, onNavigate)}
          >
            Comments
          </a>
        </nav>
      </header>
      <div className="comment-feed-content">
        <div className="comment-feed-filters">
          <label>
            状態
            <select
              aria-label="コメント状態"
              value={filters.status}
              onChange={(event) =>
                setFilters({
                  ...filters,
                  status: event.target.value as CommentFeedFilter["status"],
                })
              }
            >
              <option value="unresolved">未解決</option>
              <option value="resolved">解決済み</option>
              <option value="all">すべて</option>
            </select>
          </label>
          <label>
            リポジトリ
            <select
              aria-label="リポジトリ"
              value={filters.repository}
              onChange={(event) =>
                setFilters({ ...filters, repository: event.target.value, pullRequestId: "" })
              }
            >
              <option value="">すべてのリポジトリ</option>
              {[...new Set(options.map((pr) => `${pr.owner}/${pr.repository}`))].map((repo) => (
                <option key={repo}>{repo}</option>
              ))}
            </select>
          </label>
          <label>
            PR
            <select
              aria-label="Pull Request"
              value={filters.pullRequestId}
              onChange={(event) => setFilters({ ...filters, pullRequestId: event.target.value })}
            >
              <option value="">すべてのPR</option>
              {options
                .filter(
                  (pr) =>
                    !filters.repository || `${pr.owner}/${pr.repository}` === filters.repository,
                )
                .map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.owner}/{pr.repository} #{pr.number} {pr.title}
                  </option>
                ))}
            </select>
          </label>
          <label className="comment-feed-search">
            検索
            <input
              type="search"
              aria-label="コメント本文を検索"
              placeholder="本文・返信を検索…"
              maxLength={500}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>
        <div className="comment-feed-actions">
          <label>
            <input
              type="checkbox"
              checked={filters.hideClosedOrMerged}
              onChange={(event) =>
                setFilters({ ...filters, hideClosedOrMerged: event.target.checked })
              }
            />{" "}
            Closed / Merged を非表示
          </label>
          <div>
            <button className="button--quiet" onClick={() => all(true)}>
              すべて展開
            </button>
            <button className="button--quiet" onClick={() => all(false)}>
              すべて折りたたむ
            </button>
          </div>
        </div>
        <ErrorNotice error={heartbeatError} />
        {connectionUnavailable && (
          <button
            className="button--quiet"
            disabled={retrying}
            onClick={() => void retryConnection()}
          >
            {retrying ? "再接続中…" : "接続を再試行"}
          </button>
        )}
        {search !== filters.search && (
          <span role="status" className="comment-feed-search-status">
            検索中…
          </span>
        )}
        <FeedResults
          key={JSON.stringify(filters)}
          filters={filters}
          active={active}
          sequence={changeSequence}
          themePreference={themePreference}
          isExpanded={isExpanded}
          toggle={toggle}
          navigate={onNavigate}
          onOptions={setOptions}
          connectionUnavailable={connectionUnavailable}
          onClearFilters={clearFilters}
        />
      </div>
    </main>
  );
}
