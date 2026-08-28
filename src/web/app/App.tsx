import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { hasPendingCommentDrafts } from "../comment-draft-store.js";
import type { ThemePreference } from "../theme.js";
import { viewerHeartbeatRequest } from "../viewer-session.js";
import { PullRequestListScreen } from "./PullRequestListScreen.js";
import { PullRequestReviewScreen } from "./PullRequestReviewScreen.js";

const pullRequestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AppRoute =
  | { kind: "list"; offset: number }
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
  if (pullRequestId === null) return { kind: "list", offset: listOffset(searchParams) };
  return pullRequestIdPattern.test(pullRequestId)
    ? { kind: "review", pullRequestId, restoreReadingHistory }
    : { kind: "invalid" };
}

function pushRoute(route: Extract<AppRoute, { kind: "list" | "review" }>): void {
  const url = new URL(window.location.href);
  url.hash = "";
  if (route.kind === "review") {
    url.searchParams.set("pullRequestId", route.pullRequestId);
  } else {
    url.searchParams.delete("pullRequestId");
    if (route.offset === 0) url.searchParams.delete("offset");
    else url.searchParams.set("offset", String(route.offset));
  }
  window.history.pushState({}, "", url);
}

export function App({ initialThemePreference }: { initialThemePreference: ThemePreference }) {
  const [route, setRoute] = useState<AppRoute>(routeFromLocation);
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
    const warnBeforeBrowserClose = (event: BeforeUnloadEvent): void => {
      if (route.kind !== "review" && !hasPendingCommentDrafts()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeBrowserClose);
    return () => window.removeEventListener("beforeunload", warnBeforeBrowserClose);
  }, [route.kind]);

  const navigateToList = useCallback((): void => {
    const nextRoute = {
      kind: "list",
      offset: listOffset(new URL(window.location.href).searchParams),
    } as const;
    pushRoute(nextRoute);
    setRoute(nextRoute);
  }, []);
  const navigateToListOffset = useCallback((offset: number): void => {
    const nextRoute = { kind: "list", offset } as const;
    pushRoute(nextRoute);
    setRoute(nextRoute);
  }, []);
  const navigateToPullRequest = useCallback((pullRequestId: string): void => {
    const nextRoute = { kind: "review", pullRequestId, restoreReadingHistory: false } as const;
    pushRoute(nextRoute);
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
  if (route.kind === "list") {
    return (
      <PullRequestListScreen
        hideClosedOrMerged={hideClosedOrMerged}
        changeSequence={heartbeat.data?.changeSequence}
        heartbeatError={heartbeat.error}
        offset={route.offset}
        onHideClosedOrMergedChange={setHideClosedOrMerged}
        onNavigateToOffset={navigateToListOffset}
        onOpenPullRequest={navigateToPullRequest}
      />
    );
  }
  return (
    <PullRequestReviewScreen
      key={route.pullRequestId}
      initialThemePreference={initialThemePreference}
      pullRequestId={route.pullRequestId}
      restoreReadingHistoryOnMount={route.restoreReadingHistory}
      onNavigateToList={navigateToList}
    />
  );
}
