import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import type { PullRequestSummary } from "../../domain/models.js";
import {
  api,
  jsonRequest,
  type PullRequestListResponse,
  type PullRequestStatusRefreshResponse,
} from "../api.js";
import { ErrorNotice } from "../components/ErrorNotice.js";

const PAGE_LIMIT = 50;

const exactDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const compactDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function datePresentation(
  value: string | null,
  now: number,
): { label: string; exact: string | undefined } {
  if (value === null) return { label: "不明", exact: undefined };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { label: "不明", exact: undefined };
  const differenceSeconds = Math.round((date.getTime() - now) / 1000);
  const absoluteSeconds = Math.abs(differenceSeconds);
  let label: string;
  if (absoluteSeconds < 60) label = relativeTimeFormatter.format(differenceSeconds, "second");
  else if (absoluteSeconds < 60 * 60)
    label = relativeTimeFormatter.format(Math.round(differenceSeconds / 60), "minute");
  else if (absoluteSeconds < 60 * 60 * 24)
    label = relativeTimeFormatter.format(Math.round(differenceSeconds / (60 * 60)), "hour");
  else if (absoluteSeconds < 60 * 60 * 24 * 30)
    label = relativeTimeFormatter.format(Math.round(differenceSeconds / (60 * 60 * 24)), "day");
  else label = compactDateFormatter.format(date);
  return { label, exact: exactDateFormatter.format(date) };
}

function statusPresentation(item: PullRequestSummary): {
  label: "Open" | "Draft" | "Closed" | "Merged";
  modifier: "open" | "draft" | "closed" | "merged";
} | null {
  if (item.githubState === null) return null;
  if (item.githubState === "MERGED") return { label: "Merged", modifier: "merged" };
  if (item.githubState === "CLOSED") return { label: "Closed", modifier: "closed" };
  if (item.githubIsDraft) return { label: "Draft", modifier: "draft" };
  return { label: "Open", modifier: "open" };
}

function PullRequestRow({
  item,
  now,
  onOpen,
}: {
  item: PullRequestSummary;
  now: number;
  onOpen: (pullRequestId: string) => void;
}) {
  const created = datePresentation(item.githubCreatedAt, now);
  const updated = datePresentation(item.githubUpdatedAt, now);
  const status = statusPresentation(item);
  const url = new URL(window.location.href);
  url.hash = "";
  url.searchParams.set("pullRequestId", item.pullRequestId);
  const href = `${url.pathname}${url.search}`;
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    onOpen(item.pullRequestId);
  };
  return (
    <a className="pull-request-row" href={href} onClick={handleClick}>
      <span className="pull-request-row__identity">
        <span className="pull-request-row__repository">
          {item.owner}/{item.repository}
        </span>
        <span className="pull-request-row__number">#{item.number}</span>
        {status && (
          <span
            className={`pull-request-status pull-request-status--${status.modifier}`}
            aria-label={`Pull Request status: ${status.label}`}
          >
            {status.label}
          </span>
        )}
      </span>
      <strong className="pull-request-row__title">{item.title}</strong>
      <span className="pull-request-row__counts" aria-label="レビュー項目数">
        <span className="pull-request-count pull-request-count--unresolved">
          {item.unresolvedCommentCount} unresolved
        </span>
        <span className="pull-request-count pull-request-count--resolved">
          {item.resolvedCommentCount} resolved
        </span>
        <span className="pull-request-count pull-request-count--walkthrough">
          {item.walkthroughCount} walkthroughs
        </span>
      </span>
      <span className="pull-request-row__date">
        <span>作成</span>
        <time dateTime={item.githubCreatedAt ?? undefined} title={created.exact}>
          {created.label}
        </time>
      </span>
      <span className="pull-request-row__date pull-request-row__date--updated">
        <span>更新</span>
        <time dateTime={item.githubUpdatedAt} title={updated.exact}>
          {updated.label}
        </time>
      </span>
    </a>
  );
}

export function PullRequestListScreen({
  hideClosedOrMerged,
  changeSequence,
  heartbeatError,
  offset,
  onHideClosedOrMergedChange,
  onNavigateToOffset,
  onOpenPullRequest,
}: {
  hideClosedOrMerged: boolean;
  changeSequence: number | undefined;
  heartbeatError: unknown;
  offset: number;
  onHideClosedOrMergedChange: (hideClosedOrMerged: boolean) => void;
  onNavigateToOffset: (offset: number) => void;
  onOpenPullRequest: (pullRequestId: string) => void;
}) {
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  const listQuery = useQuery({
    queryKey: ["pull-request-list", offset, hideClosedOrMerged, changeSequence],
    queryFn: async () =>
      await api<PullRequestListResponse>(
        `/api/pull-requests?offset=${offset}&limit=${PAGE_LIMIT}&hideClosedOrMerged=${hideClosedOrMerged}`,
      ),
    placeholderData: (previousData) => previousData,
  });
  const statusRefresh = useMutation({
    mutationFn: async () =>
      await api<PullRequestStatusRefreshResponse>(
        "/api/pull-requests/refresh-statuses",
        jsonRequest({}),
      ),
    onSuccess: async () => {
      const result = await listQuery.refetch();
      const refreshedPagination = result.data?.pagination;
      if (
        refreshedPagination &&
        refreshedPagination.total > 0 &&
        refreshedPagination.offset >= refreshedPagination.total
      ) {
        onNavigateToOffset(
          Math.floor((refreshedPagination.total - 1) / refreshedPagination.limit) *
            refreshedPagination.limit,
        );
      }
    },
  });
  const pagination = listQuery.data?.pagination;
  const rangeLabel = useMemo(() => {
    if (!pagination || pagination.total === 0) return null;
    const start = pagination.offset + 1;
    const end = pagination.offset + pagination.returned;
    return `${start}–${end} / ${pagination.total}`;
  }, [pagination]);

  useEffect(() => {
    document.title = "rvw";
  }, []);
  useEffect(() => {
    const interval = window.setInterval(() => setRelativeTimeNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <main className="pull-request-list-screen">
      <header className="pull-request-list-header">
        <div className="brand">
          <span className="brand-mark">r</span>
          <strong>rvw</strong>
        </div>
        <div>
          <h1>Pull Requests</h1>
          <p>GitHubでの更新が新しい順</p>
        </div>
      </header>
      <div className="pull-request-list-content">
        <div className="pull-request-list-filters">
          <button
            type="button"
            className="button--quiet pull-request-status-refresh"
            disabled={statusRefresh.isPending}
            onClick={() => statusRefresh.mutate()}
          >
            {statusRefresh.isPending ? "更新中…" : "PRステータスを一括更新"}
          </button>
          <label className="pull-request-list-filter">
            <input
              type="checkbox"
              checked={hideClosedOrMerged}
              onChange={(event) => {
                onHideClosedOrMergedChange(event.target.checked);
                if (offset !== 0) onNavigateToOffset(0);
              }}
            />
            Closed / Merged を非表示
          </label>
        </div>
        <ErrorNotice error={heartbeatError ?? listQuery.error ?? statusRefresh.error} />
        {!statusRefresh.isPending && statusRefresh.data && (
          <div
            className={`pull-request-status-refresh-result${
              statusRefresh.data.failures.length > 0
                ? " pull-request-status-refresh-result--error"
                : ""
            }`}
            role={statusRefresh.data.failures.length > 0 ? "alert" : "status"}
          >
            {statusRefresh.data.attempted === 0
              ? "更新対象のPull Requestはありません。"
              : `${statusRefresh.data.updated}件のPRステータスを更新しました。`}
            {statusRefresh.data.failures.length > 0 && (
              <details open>
                <summary>{statusRefresh.data.failures.length}件を更新できませんでした</summary>
                <ul>
                  {statusRefresh.data.failures.map((failure) => (
                    <li key={failure.pullRequestId}>
                      {failure.owner}/{failure.repository}#{failure.number}: {failure.error.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {listQuery.isPending && !listQuery.data ? (
          <div className="pull-request-list-status" role="status">
            登録済みPull Requestを読み込んでいます…
          </div>
        ) : listQuery.data?.items.length === 0 ? (
          <section className="pull-request-list-empty">
            <div className="brand-mark" aria-hidden="true">
              r
            </div>
            <h2>
              {hideClosedOrMerged
                ? "Closed / Merged以外のPull Requestはありません"
                : "まだレビュー対象が登録されていません"}
            </h2>
            {hideClosedOrMerged ? (
              <p>Closed / Mergedを表示するにはfilterを解除してください。</p>
            ) : (
              <p>
                <code>rvw open &lt;PR URL&gt;</code> でPull Requestを開くと、ここに表示されます。
              </p>
            )}
          </section>
        ) : (
          <section className="pull-request-list" aria-label="登録済みPull Request">
            <div className="pull-request-list-columns" aria-hidden="true">
              <span>Pull Request</span>
              <span>Title</span>
              <span>Review</span>
              <span>Created</span>
              <span>Updated</span>
            </div>
            {listQuery.data?.items.map((item) => (
              <PullRequestRow
                key={`${item.pullRequestId}:${item.number}`}
                item={item}
                now={relativeTimeNow}
                onOpen={onOpenPullRequest}
              />
            ))}
          </section>
        )}
        {pagination && pagination.total > 0 && (
          <nav className="pull-request-pagination" aria-label="Pull Request一覧のページ">
            <button
              type="button"
              className="button--quiet"
              disabled={pagination.offset === 0 || listQuery.isFetching}
              onClick={() => onNavigateToOffset(Math.max(0, pagination.offset - pagination.limit))}
            >
              前へ
            </button>
            <span>{rangeLabel}</span>
            <button
              type="button"
              className="button--quiet"
              disabled={!pagination.hasMore || listQuery.isFetching}
              onClick={() => {
                if (pagination.nextOffset !== null) onNavigateToOffset(pagination.nextOffset);
              }}
            >
              次へ
            </button>
          </nav>
        )}
      </div>
    </main>
  );
}
