import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import type { ThemePreference } from "../theme.js";
import { viewerHeartbeatRequest } from "../viewer-session.js";
import { CommentFeedScreen } from "./CommentFeedScreen.js";
import { hasCommentReplyDrafts } from "../comment-draft-store.js";
import { PullRequestListScreen } from "./PullRequestListScreen.js";
import { PullRequestReviewScreen } from "./PullRequestReviewScreen.js";

const pullRequestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AppRoute =
  | { kind: "list"; offset: number; view: "prs" | "comments" }
  | { kind: "review"; pullRequestId: string; restoreReadingHistory: boolean }
  | { kind: "invalid" };

function listOffset(searchParams: URLSearchParams): number {
  const value = searchParams.get("offset");
  if (value === null || !/^\d+$/.test(value)) return 0;
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : 0;
}

function routeFromLocation(restoreReadingHistory = false): AppRoute {
  const searchParams = new URL(window.location.href).searchParams;
  const pullRequestId = searchParams.get("pullRequestId");
  if (pullRequestId === null)
    return {
      kind: "list",
      offset: listOffset(searchParams),
      view: searchParams.get("view") === "comments" ? "comments" : "prs",
    };
  return pullRequestIdPattern.test(pullRequestId)
    ? { kind: "review", pullRequestId, restoreReadingHistory }
    : { kind: "invalid" };
}

function navigateRoute(
  route: Extract<AppRoute, { kind: "list" | "review" }>,
  options: { replace?: boolean } = {},
): void {
  const url = new URL(window.location.href);
  url.hash = "";
  if (route.kind === "review") {
    url.searchParams.set("pullRequestId", route.pullRequestId);
  } else {
    url.searchParams.delete("pullRequestId");
    for (const key of ["commentId", "sourceOid", "path", "startLine", "endLine"])
      url.searchParams.delete(key);
    if (route.view === "comments") url.searchParams.set("view", "comments");
    else url.searchParams.delete("view");
    if (route.offset === 0) url.searchParams.delete("offset");
    else url.searchParams.set("offset", String(route.offset));
  }
  if (options.replace) window.history.replaceState({}, "", url);
  else window.history.pushState({}, "", url);
}

export function App({ initialThemePreference }: { initialThemePreference: ThemePreference }) {
  const [route, setRoute] = useState<AppRoute>(routeFromLocation);
  const [hideArchived, setHideArchived] = useState(true);
  const [feedVisited, setFeedVisited] = useState(
    () => new URL(window.location.href).searchParams.get("view") === "comments",
  );
  const [hideClosedOrMerged, setHideClosedOrMerged] = useState(true);
  const heartbeat = useQuery({
    queryKey: ["change-sequence"],
    queryFn: async () =>
      await api<{ changeSequence: number }>("/api/meta/change-sequence", viewerHeartbeatRequest()),
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
    networkMode: "always",
  });

  useEffect(() => {
    const handlePopState = (): void => setRoute(routeFromLocation(true));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent): void => {
      if (hasCommentReplyDrafts()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  const navigateUrl = useCallback((url: string): void => {
    window.history.pushState({}, "", url);
    if (new URL(window.location.href).searchParams.get("view") === "comments") setFeedVisited(true);
    setRoute(routeFromLocation());
  }, []);
  const navigateToList = useCallback((): void => {
    const nextRoute = {
      kind: "list",
      view:
        new URL(window.location.href).searchParams.get("view") === "comments" ? "comments" : "prs",
      offset: listOffset(new URL(window.location.href).searchParams),
    } as const;
    navigateRoute(nextRoute);
    setRoute(nextRoute);
  }, []);
  const navigateToListOffset = useCallback(
    (offset: number, options?: { replace?: boolean }): void => {
      const nextRoute = { kind: "list", offset, view: "prs" } as const;
      navigateRoute(nextRoute, options);
      setRoute(nextRoute);
    },
    [],
  );
  const navigateToPullRequest = useCallback((pullRequestId: string): void => {
    const nextRoute = { kind: "review", pullRequestId, restoreReadingHistory: false } as const;
    navigateRoute(nextRoute);
    setRoute(nextRoute);
  }, []);

  if (route.kind === "invalid") {
    return (
      <main className="fatal-state">
        <h1>rvw</h1>
        <p>Pull Request IDの形式が正しくありません。`rvw open`から起動し直してください。</p>
      </main>
    );
  }
  const showFeed = route.kind === "list" && route.view === "comments";
  return (
    <>
      {(feedVisited || showFeed) && (
        <div hidden={!showFeed}>
          <CommentFeedScreen
            active={showFeed}
            changeSequence={heartbeat.data?.changeSequence}
            heartbeatError={heartbeat.error}
            themePreference={initialThemePreference}
            onNavigate={navigateUrl}
          />
        </div>
      )}
      {route.kind === "list" ? (
        !showFeed && (
          <PullRequestListScreen
            hideClosedOrMerged={hideClosedOrMerged}
            hideArchived={hideArchived}
            onHideArchivedChange={setHideArchived}
            changeSequence={heartbeat.data?.changeSequence}
            heartbeatError={heartbeat.error}
            offset={route.offset}
            onHideClosedOrMergedChange={setHideClosedOrMerged}
            onNavigateToOffset={navigateToListOffset}
            onOpenPullRequest={navigateToPullRequest}
            onShowComments={() => navigateUrl("/?view=comments")}
          />
        )
      ) : (
        <PullRequestReviewScreen
          key={`${route.pullRequestId}:${new URL(window.location.href).searchParams.get("commentId") ?? ""}`}
          initialThemePreference={initialThemePreference}
          pullRequestId={route.pullRequestId}
          restoreReadingHistoryOnMount={route.restoreReadingHistory}
          onNavigateToList={navigateToList}
        />
      )}
    </>
  );
}
