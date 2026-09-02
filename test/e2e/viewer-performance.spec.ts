import { expect, test, type APIRequestContext, type Page, type Request } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const sourceOid = "b".repeat(40);
const emptyCommitMessage = "PR commitがありません。";

test.setTimeout(120_000);

async function createRepositoryComments(
  request: APIRequestContext,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await request.post("/api/comments", {
      data: {
        pullRequestId,
        target: {
          kind: "document",
          documentKind: "repository-file",
          sourceOid,
          path: "src/removed.ts",
          startLine: 1,
          endLine: 1,
        },
        body: `Performance fixture ${index + 1}`,
        authorLabel: "Performance fixture",
      },
    });
    expect(response.ok()).toBe(true);
    ids.push(((await response.json()) as { comment: { id: string } }).comment.id);
  }
  return ids;
}

async function createRepositoryComment(request: APIRequestContext, body: string): Promise<string> {
  const response = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid,
        path: "src/fixture.ts",
        startLine: 1,
        endLine: 1,
      },
      body,
      authorLabel: "Performance fixture",
    },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { comment: { id: string } }).comment.id;
}

async function deleteComments(request: APIRequestContext, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const response = await request.delete(`/api/comments/${id}`, { data: {} });
    expect(response.ok()).toBe(true);
  }
}

async function createWalkthroughComment(request: APIRequestContext): Promise<string> {
  const response = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "walkthrough",
        walkthroughId: "70000000-0000-4000-8000-000000000001",
        startLine: null,
        endLine: null,
      },
      body: "Non-repository placement fixture",
      authorLabel: "Performance fixture",
    },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { comment: { id: string } }).comment.id;
}

function placementKind(request: Request): string | null {
  if (!request.url().includes("/comment-placements/resolve")) return null;
  const body = request.postDataJSON() as { destinations?: Array<{ kind?: string }> };
  return body.destinations?.[0]?.kind ?? null;
}

function placementCommentIds(request: Request): string[] {
  if (!request.url().includes("/comment-placements/resolve")) return [];
  const body = request.postDataJSON() as { commentIds?: string[] };
  return body.commentIds ?? [];
}

type CommitEmptyStateProbeWindow = Window & {
  __rvwSawCommitEmptyState?: boolean;
};

async function installCommitEmptyStateProbe(page: Page): Promise<void> {
  await page.addInitScript((message) => {
    const probeWindow = window as CommitEmptyStateProbeWindow;
    probeWindow.__rvwSawCommitEmptyState = false;
    const recordEmptyState = (): void => {
      if (document.body?.textContent?.includes(message)) {
        probeWindow.__rvwSawCommitEmptyState = true;
      }
    };
    new MutationObserver(recordEmptyState).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    recordEmptyState();
  }, emptyCommitMessage);
}

async function sawCommitEmptyState(page: Page): Promise<boolean> {
  return await page.evaluate(() =>
    Boolean((window as CommitEmptyStateProbeWindow).__rvwSawCommitEmptyState),
  );
}

test("keeps 100-comment viewer placement requests within constant budgets", async ({
  page,
  request,
}) => {
  const initialCommentsResponse = await request.get(
    `/api/pull-requests/${pullRequestId}/comments?resolved=all`,
  );
  expect(initialCommentsResponse.ok()).toBe(true);
  const initialComments = (await initialCommentsResponse.json()) as {
    comments: Array<{
      id: string;
      resolvedAt: string | null;
      target: { kind: string; documentKind?: string };
    }>;
  };
  const expectedUnresolvedCount =
    initialComments.comments.filter(({ resolvedAt }) => resolvedAt === null).length + 101;
  const repositoryCreatedCommentIds = await createRepositoryComments(request, 100);
  const walkthroughCommentId = await createWalkthroughComment(request);
  const commentIds = [...repositoryCreatedCommentIds, walkthroughCommentId];
  const repositoryCommentIds = new Set([
    ...repositoryCreatedCommentIds,
    ...initialComments.comments
      .filter(
        ({ target }) => target.kind === "document" && target.documentKind === "repository-file",
      )
      .map(({ id }) => id),
  ]);
  const nonRepositoryCommentIds = new Set([
    walkthroughCommentId,
    ...initialComments.comments
      .filter(
        ({ target }) => target.kind !== "document" || target.documentKind !== "repository-file",
      )
      .map(({ id }) => id),
  ]);
  let mutationCommentId: string | null = null;
  const counts = { document: 0, commit: 0, single: 0, commentsGet: 0 };
  const documentPlacementCommentIds: string[][] = [];
  page.on("request", (browserRequest) => {
    const url = browserRequest.url();
    if (/\/api\/comments\/[^/]+\/placement\?/u.test(url)) counts.single += 1;
    if (
      browserRequest.method() === "GET" &&
      url.includes(`/api/pull-requests/${pullRequestId}/comments`)
    ) {
      counts.commentsGet += 1;
    }
    const kind = placementKind(browserRequest);
    if (kind === "document") {
      counts.document += 1;
      documentPlacementCommentIds.push(placementCommentIds(browserRequest));
    }
    if (kind === "commit") counts.commit += 1;
  });

  try {
    const initialRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.pathname === `/api/pull-requests/${pullRequestId}/refresh`
      );
    });
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await initialRefresh;
    const commentsToggle = page.getByRole("button", {
      name: `コメント ${expectedUnresolvedCount}`,
      exact: true,
    });
    await expect(commentsToggle).toBeVisible();
    await page.waitForTimeout(250);
    counts.document = 0;
    counts.commit = 0;
    counts.commentsGet = 0;

    const documentOpenedAt = performance.now();
    await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
    await expect.poll(() => counts.document).toBe(1);
    await expect(page.locator('.document-pane[data-pane="left"]')).toContainText("fixture");
    const documentReadyMs = performance.now() - documentOpenedAt;
    await page.waitForTimeout(250);
    expect(counts.document).toBe(1);
    expect(counts.commit).toBe(0);
    const openedDocumentCommentIds = documentPlacementCommentIds.at(-1) ?? [];
    expect(openedDocumentCommentIds.length).toBeGreaterThanOrEqual(100);
    expect(openedDocumentCommentIds.every((id) => repositoryCommentIds.has(id))).toBe(true);
    expect(openedDocumentCommentIds.some((id) => nonRepositoryCommentIds.has(id))).toBe(false);

    const sidebarOpenedAt = performance.now();
    await commentsToggle.click();
    await expect.poll(() => counts.commit).toBe(1);
    await expect(page.locator(".comment-list-item")).toHaveCount(expectedUnresolvedCount);
    const sidebarReadyMs = performance.now() - sidebarOpenedAt;
    await page.waitForTimeout(250);
    expect(counts.commit).toBe(1);
    expect(counts.single).toBe(0);

    const performanceThread = page
      .locator(".comment-list-item")
      .filter({ has: page.getByText("Performance fixture 1", { exact: true }) });
    const replyRequestsBefore = { ...counts };
    await performanceThread.getByPlaceholder("返信を入力").fill("Performance reply fixture");
    await performanceThread.getByPlaceholder("返信を入力").press("Control+Enter");
    await expect(
      performanceThread.getByText("Performance reply fixture", { exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(1_250);
    expect(counts.document).toBe(replyRequestsBefore.document);
    expect(counts.commit).toBe(replyRequestsBefore.commit);
    expect(counts.commentsGet).toBeGreaterThan(replyRequestsBefore.commentsGet);

    const resolveRequestsBefore = { ...counts };
    await performanceThread.getByRole("button", { name: "解決", exact: true }).click();
    await expect(performanceThread).toHaveCount(0);
    await page.waitForTimeout(1_250);
    expect(counts.document).toBe(resolveRequestsBefore.document);
    expect(counts.commit).toBe(resolveRequestsBefore.commit);
    expect(counts.commentsGet).toBeGreaterThan(resolveRequestsBefore.commentsGet);

    await page.getByRole("button", { name: /^解決済み/u }).click();
    const resolvedPerformanceThread = page
      .locator(".comment-list-item")
      .filter({ has: page.getByText("Performance fixture 1", { exact: true }) });
    await expect(resolvedPerformanceThread).toBeVisible();
    const reopenRequestsBefore = { ...counts };
    await resolvedPerformanceThread.getByRole("button", { name: "再度開く", exact: true }).click();
    await expect(resolvedPerformanceThread).toHaveCount(0);
    await page.waitForTimeout(1_250);
    expect(counts.document).toBe(reopenRequestsBefore.document);
    expect(counts.commit).toBe(reopenRequestsBefore.commit);
    expect(counts.commentsGet).toBeGreaterThan(reopenRequestsBefore.commentsGet);
    await page.getByRole("button", { name: /^未解決/u }).click();

    const mutationRequestsBefore = {
      document: counts.document,
      commit: counts.commit,
      commentsGet: counts.commentsGet,
    };
    await page.getByRole("button", { name: "＋ PR全体", exact: true }).click();
    await page.getByPlaceholder("Pull Request全体へのコメント").fill("Mutation budget fixture");
    const mutationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/comments",
    );
    await page.getByRole("button", { name: "コメント", exact: true }).click();
    const createdMutationResponse = await mutationResponse;
    mutationCommentId = ((await createdMutationResponse.json()) as { comment: { id: string } })
      .comment.id;
    await expect(page.getByText("Mutation budget fixture", { exact: true })).toBeVisible();
    await page.waitForTimeout(1_250);
    expect(counts.document - mutationRequestsBefore.document).toBe(0);
    expect(counts.commit - mutationRequestsBefore.commit).toBe(0);
    expect(counts.commentsGet).toBeGreaterThan(mutationRequestsBefore.commentsGet);

    console.info(
      JSON.stringify({
        scenario: "100 mixed comments",
        documentPlacementRequests: 1,
        sidebarPlacementRequests: 1,
        singlePlacementRequests: counts.single,
        documentReadyMs: Math.round(documentReadyMs),
        sidebarReadyMs: Math.round(sidebarReadyMs),
      }),
    );
  } finally {
    if (mutationCommentId) commentIds.push(mutationCommentId);
    await deleteComments(request, commentIds);
  }
});

test("restores existing comments after a mutation cancels the initial comments GET", async ({
  page,
  request,
}) => {
  const existingBody = "Existing comments race baseline";
  const baselineResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: { kind: "pull-request" },
      body: existingBody,
      authorLabel: "Performance fixture",
    },
  });
  expect(baselineResponse.ok()).toBe(true);
  const baselineCommentId = ((await baselineResponse.json()) as { comment: { id: string } }).comment
    .id;

  let commentsRequests = 0;
  let releaseInitialGet = (): void => {};
  const initialGetGate = new Promise<void>((resolve) => {
    releaseInitialGet = resolve;
  });
  let initialGetStarted = (): void => {};
  const initialGetStartedPromise = new Promise<void>((resolve) => {
    initialGetStarted = resolve;
  });
  await page.route(`**/api/pull-requests/${pullRequestId}/comments?resolved=all`, async (route) => {
    commentsRequests += 1;
    if (commentsRequests === 1) {
      const response = await route.fetch();
      initialGetStarted();
      await initialGetGate;
      try {
        await route.fulfill({ response });
      } catch {
        // The browser request is expected to be aborted by the mutation.
      }
      return;
    }
    await route.fallback();
  });

  let createdCommentId: string | null = null;
  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await initialGetStartedPromise;
    await page.getByRole("button", { name: /^コメント/u }).click();
    await page.getByRole("button", { name: "＋ PR全体", exact: true }).click();
    await page
      .getByPlaceholder("Pull Request全体へのコメント")
      .fill("Initial comments race fixture");
    const mutationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/comments",
    );
    await page.getByRole("button", { name: "コメント", exact: true }).click();
    const response = await mutationResponse;
    createdCommentId = ((await response.json()) as { comment: { id: string } }).comment.id;

    await expect(page.getByText("Initial comments race fixture", { exact: true })).toBeVisible();
    await expect.poll(() => commentsRequests).toBeGreaterThanOrEqual(2);
    await expect(page.getByText(existingBody, { exact: true }).first()).toBeVisible();
  } finally {
    releaseInitialGet();
    await deleteComments(
      request,
      createdCommentId ? [createdCommentId, baselineCommentId] : [baselineCommentId],
    );
  }
});

test("does not refetch the stable Pull Request view on window focus", async ({ page }) => {
  let pullRequestGets = 0;
  page.on("request", (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (
      browserRequest.method() === "GET" &&
      url.pathname === `/api/pull-requests/${pullRequestId}`
    ) {
      pullRequestGets += 1;
    }
  });
  const initialRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === `/api/pull-requests/${pullRequestId}/refresh`
    );
  });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await initialRefresh;
  await expect(page.getByText(/Fixture review/u).first()).toBeVisible();
  const initialGets = pullRequestGets;

  for (let index = 0; index < 3; index += 1) {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(250);
  }

  expect(pullRequestGets).toBe(initialGets);
});

test("does not let an older Pull Request GET overwrite a completed refresh", async ({
  page,
  request,
}) => {
  const resetSync = await request.post("/api/test/reset-sync-stage", { data: {} });
  expect(resetSync.ok()).toBe(true);
  let holdNextPullRequestGet = false;
  let releaseGet = (): void => undefined;
  const getGate = new Promise<void>((resolve) => {
    releaseGet = resolve;
  });
  let capturedGet = (): void => undefined;
  const capturedGetPromise = new Promise<void>((resolve) => {
    capturedGet = resolve;
  });
  await page.route(`**/api/pull-requests/${pullRequestId}`, async (route) => {
    if (!holdNextPullRequestGet || route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    holdNextPullRequestGet = false;
    const response = await route.fetch();
    capturedGet();
    await getGate;
    try {
      await route.fulfill({ response });
    } catch {
      // Refresh adoption cancels the obsolete GET generation.
    }
  });

  try {
    const initialRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.pathname === `/api/pull-requests/${pullRequestId}/refresh`
      );
    });
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await initialRefresh;
    await expect(
      page.getByText("This is always the latest PR body.", { exact: true }),
    ).toBeVisible();

    holdNextPullRequestGet = true;
    const revisionResponse = await request.post("/api/test/bump-revision", {
      data: { domains: ["pullRequests"] },
    });
    expect(revisionResponse.ok()).toBe(true);
    await capturedGetPromise;

    const completedRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.pathname === `/api/pull-requests/${pullRequestId}/refresh`
      );
    });
    await page.getByRole("button", { name: "その他の操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "GitHubと同期" }).click();
    await completedRefresh;
    await expect(page.getByText("The PR body was rewritten.", { exact: true })).toBeVisible();

    releaseGet();
    await page.waitForTimeout(300);
    await expect(page.getByText("The PR body was rewritten.", { exact: true })).toBeVisible();
    await expect(page.getByText("This is always the latest PR body.", { exact: true })).toHaveCount(
      0,
    );
  } finally {
    releaseGet();
  }
});

test("rejects placement read after PR Markdown changes while an older document response is pending", async ({
  page,
  request,
}) => {
  const resetSync = await request.post("/api/test/reset-sync-stage", { data: {} });
  expect(resetSync.ok()).toBe(true);
  const commentResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "document",
        documentKind: "pull-request-markdown",
        sourceDocumentHash: "stale-after-external-refresh",
        quotedText: "Review the fixture application.",
        startLine: 3,
        endLine: 3,
      },
      body: "Content fingerprint epoch fixture",
      authorLabel: "Performance fixture",
    },
  });
  expect(commentResponse.ok()).toBe(true);
  const commentId = ((await commentResponse.json()) as { comment: { id: string } }).comment.id;
  let releaseAutomaticRefresh = (): void => undefined;
  const automaticRefreshGate = new Promise<void>((resolve) => {
    releaseAutomaticRefresh = resolve;
  });
  let automaticRefreshStarted = (): void => undefined;
  const automaticRefreshStartedPromise = new Promise<void>((resolve) => {
    automaticRefreshStarted = resolve;
  });
  let releaseDocument = (): void => undefined;
  const documentGate = new Promise<void>((resolve) => {
    releaseDocument = resolve;
  });
  let documentRead = (): void => undefined;
  const documentReadPromise = new Promise<void>((resolve) => {
    documentRead = resolve;
  });
  let releasePlacement = (): void => undefined;
  const placementGate = new Promise<void>((resolve) => {
    releasePlacement = resolve;
  });
  let placementStarted = (): void => undefined;
  const placementStartedPromise = new Promise<void>((resolve) => {
    placementStarted = resolve;
  });
  let placementStatus: number | null = null;
  let capturePlacement = true;
  let placementFinished = (): void => undefined;
  const placementFinishedPromise = new Promise<void>((resolve) => {
    placementFinished = resolve;
  });

  await page.route(`**/api/pull-requests/${pullRequestId}/refresh`, async (route) => {
    automaticRefreshStarted();
    await automaticRefreshGate;
    await route.abort("aborted");
  });
  await page.route(`**/api/pull-requests/${pullRequestId}/document?*`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("kind") !== "pull-request-markdown") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    documentRead();
    await documentGate;
    try {
      await route.fulfill({ response });
    } catch {
      // A later content fingerprint may cancel this old document generation.
    }
  });
  await page.route(
    `**/api/pull-requests/${pullRequestId}/comment-placements/resolve`,
    async (route) => {
      const input = route.request().postDataJSON() as {
        commentIds?: string[];
        destinations?: Array<{ kind?: string; ref?: { kind?: string } }>;
      };
      if (
        !capturePlacement ||
        !input.commentIds?.includes(commentId) ||
        !input.destinations?.some(
          (destination) =>
            destination.kind === "document" && destination.ref?.kind === "pull-request-markdown",
        )
      ) {
        await route.fallback();
        return;
      }
      capturePlacement = false;
      placementStarted();
      await placementGate;
      const response = await route.fetch();
      placementStatus = response.status();
      try {
        await route.fulfill({ response });
      } finally {
        placementFinished();
      }
    },
  );

  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await Promise.all([
      automaticRefreshStartedPromise,
      documentReadPromise,
      placementStartedPromise,
    ]);

    const externalRefresh = await request.post(`/api/pull-requests/${pullRequestId}/refresh`, {
      data: {},
    });
    expect(externalRefresh.ok()).toBe(true);
    releasePlacement();
    await placementFinishedPromise;
    expect(placementStatus).toBe(409);
    releaseDocument();
    releaseAutomaticRefresh();

    await expect(page.getByText("This is always the latest PR body.", { exact: true })).toBeVisible(
      { timeout: 10_000 },
    );
    await expect(
      page.locator(`.comment-thread--inline[data-comment-id="${commentId}"]`),
    ).toHaveCount(0);
  } finally {
    releasePlacement();
    releaseDocument();
    releaseAutomaticRefresh();
    await deleteComments(request, [commentId]);
  }
});

test("loads an external comment written before the initial revision snapshot", async ({
  page,
  request,
}) => {
  let releaseHeartbeat = (): void => {};
  const heartbeatGate = new Promise<void>((resolve) => {
    releaseHeartbeat = resolve;
  });
  let heartbeatStarted = (): void => {};
  const heartbeatStartedPromise = new Promise<void>((resolve) => {
    heartbeatStarted = resolve;
  });
  let heartbeatRequests = 0;
  await page.route("**/api/meta/change-sequence", async (route) => {
    heartbeatRequests += 1;
    if (heartbeatRequests === 1) {
      heartbeatStarted();
      await heartbeatGate;
    }
    await route.fallback();
  });

  let releaseRefresh = (): void => {};
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route(`**/api/pull-requests/${pullRequestId}/refresh`, async (route) => {
    await refreshGate;
    await route.fallback();
  });

  let commentListRequests = 0;
  await page.route(`**/api/pull-requests/${pullRequestId}/comments?resolved=all`, async (route) => {
    commentListRequests += 1;
    await route.fallback();
  });

  let externalCommentId: string | null = null;
  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await heartbeatStartedPromise;
    await expect(page.getByText("レビュー状態を読み込んでいます…", { exact: true })).toBeVisible();
    await expect(page.getByText(emptyCommitMessage, { exact: true })).toHaveCount(0);
    expect(commentListRequests).toBe(0);

    const externalBody = "External comment before revision bootstrap";
    const externalResponse = await request.post("/api/comments", {
      data: {
        pullRequestId,
        target: { kind: "pull-request" },
        body: externalBody,
        authorLabel: "External Agent",
      },
    });
    expect(externalResponse.ok()).toBe(true);
    externalCommentId = ((await externalResponse.json()) as { comment: { id: string } }).comment.id;

    releaseHeartbeat();
    await expect.poll(() => commentListRequests).toBe(1);
    await expect(page.getByRole("button", { name: /^対象commit:/u })).toHaveAccessibleName(
      /PR全体/u,
    );
    await page.getByRole("button", { name: /^コメント \d+$/u }).click();
    await expect(page.getByText(externalBody, { exact: true })).toBeVisible();
    expect(commentListRequests).toBe(1);
  } finally {
    releaseHeartbeat();
    releaseRefresh();
    if (externalCommentId) await deleteComments(request, [externalCommentId]);
  }
});

test("shows the revision bootstrap error without starting the Pull Request query", async ({
  page,
}) => {
  const bootstrapErrorMessage = "Revision snapshot fixture failed.";
  let pullRequestGets = 0;
  await page.route(`**/api/pull-requests/${pullRequestId}`, async (route) => {
    if (route.request().method() === "GET") pullRequestGets += 1;
    await route.fallback();
  });
  await page.route("**/api/meta/change-sequence", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { code: "REVISION_SNAPSHOT_FAILED", message: bootstrapErrorMessage },
      }),
    });
  });

  await page.goto(`/?pullRequestId=${pullRequestId}`);

  await expect(page.getByText(bootstrapErrorMessage, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(emptyCommitMessage, { exact: true })).toHaveCount(0);
  expect(pullRequestGets).toBe(0);
});

test("selects the latest commit without rendering a transient empty-commit state", async ({
  page,
}) => {
  await installCommitEmptyStateProbe(page);

  await page.goto(`/?pullRequestId=${pullRequestId}`);

  const commitPicker = page.getByRole("button", { name: /^対象commit:/u });
  await expect(commitPicker).toHaveAccessibleName(/Trim fixture input.*2 commits.*PR全体/u);
  await commitPicker.click();
  await expect(
    page.getByRole("dialog").getByRole("option", { name: /Trim fixture input.*最新/u }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByText(emptyCommitMessage, { exact: true })).toHaveCount(0);
  expect(await sawCommitEmptyState(page)).toBe(false);
});

test("shows the empty-commit state only after a successful empty commit enumeration", async ({
  page,
}) => {
  let releaseRefresh = (): void => {};
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route(`**/api/pull-requests/${pullRequestId}/refresh`, async (route) => {
    await refreshGate;
    await route.fallback();
  });
  await page.route(`**/api/pull-requests/${pullRequestId}`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, commits: [] } });
  });

  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await expect(page.getByText(emptyCommitMessage, { exact: true })).toBeVisible();
    await expect(page.getByText("レビュー状態を読み込んでいます…", { exact: true })).toHaveCount(0);
  } finally {
    releaseRefresh();
  }
});

test("restarts the initial comments GET when a later revision arrives", async ({
  page,
  request,
}) => {
  let releaseInitialGet = (): void => {};
  const initialGetGate = new Promise<void>((resolve) => {
    releaseInitialGet = resolve;
  });
  let initialGetCaptured = (): void => {};
  const initialGetCapturedPromise = new Promise<void>((resolve) => {
    initialGetCaptured = resolve;
  });
  let commentListRequests = 0;
  await page.route(`**/api/pull-requests/${pullRequestId}/comments?resolved=all`, async (route) => {
    commentListRequests += 1;
    if (commentListRequests !== 1) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    initialGetCaptured();
    await initialGetGate;
    try {
      await route.fulfill({ response });
    } catch {
      // The revision boundary cancels this stale browser request.
    }
  });

  let externalCommentId: string | null = null;
  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await initialGetCapturedPromise;

    const externalBody = "External comment during initial comments GET";
    const externalResponse = await request.post("/api/comments", {
      data: {
        pullRequestId,
        target: { kind: "pull-request" },
        body: externalBody,
        authorLabel: "External Agent",
      },
    });
    expect(externalResponse.ok()).toBe(true);
    externalCommentId = ((await externalResponse.json()) as { comment: { id: string } }).comment.id;

    await expect.poll(() => commentListRequests).toBeGreaterThanOrEqual(2);
    await page.getByRole("button", { name: /^コメント \d+$/u }).click();
    await expect(page.getByText(externalBody, { exact: true })).toBeVisible();
  } finally {
    releaseInitialGet();
    if (externalCommentId) await deleteComments(request, [externalCommentId]);
  }
});

test("does not re-run repository sidebar placement for a Walkthrough-only revision", async ({
  page,
  request,
}) => {
  const createdCommentIds = await createRepositoryComments(request, 1);
  const commentId = createdCommentIds[0]!;
  let sidebarPlacementRequests = 0;
  page.on("request", (browserRequest) => {
    if (placementKind(browserRequest) === "commit") sidebarPlacementRequests += 1;
  });

  try {
    const initialRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.pathname === `/api/pull-requests/${pullRequestId}/refresh`
      );
    });
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await initialRefresh;
    await page.getByRole("button", { name: /^コメント \d+$/u }).click();
    await expect.poll(() => sidebarPlacementRequests).toBeGreaterThanOrEqual(1);
    const requestsBeforeWalkthroughUpdate = sidebarPlacementRequests;

    const revisionResponse = await request.post("/api/test/bump-revision", {
      data: { domains: ["walkthroughs"] },
    });
    expect(revisionResponse.ok()).toBe(true);
    await page.waitForTimeout(1_250);
    expect(sidebarPlacementRequests).toBe(requestsBeforeWalkthroughUpdate);
  } finally {
    await deleteComments(request, [commentId]);
  }
});

test("keeps healthy sidebar placements when one hidden comment cannot be resolved", async ({
  page,
  request,
}) => {
  const validBody = "Placement isolation valid comment";
  const brokenBody = "Placement isolation broken comment";
  const validId = await createRepositoryComment(request, validBody);
  const brokenId = await createRepositoryComment(request, brokenBody);
  const resolved = await request.post(`/api/comments/${brokenId}/resolve`, { data: {} });
  expect(resolved.ok()).toBe(true);
  let failBrokenPlacement = true;

  await page.route(
    `**/api/pull-requests/${pullRequestId}/comment-placements/resolve`,
    async (route) => {
      const input = route.request().postDataJSON() as {
        commentIds?: string[];
        destinations?: Array<{ kind: string }>;
      };
      if (
        !failBrokenPlacement ||
        input.destinations?.[0]?.kind !== "commit" ||
        !input.commentIds?.includes(brokenId)
      ) {
        await route.fallback();
        return;
      }
      failBrokenPlacement = false;
      const response = await route.fetch();
      const payload = (await response.json()) as {
        comments: Array<{
          commentId: string;
          placements: unknown[];
          failures: unknown[];
        }>;
      };
      await route.fulfill({
        response,
        json: {
          ...payload,
          comments: payload.comments.map((comment) =>
            comment.commentId === brokenId
              ? {
                  ...comment,
                  placements: [],
                  failures: [
                    {
                      destination: input.destinations![0],
                      error: {
                        code: "COMMIT_NOT_FOUND",
                        message: "コメント作成時のcommitを取得できません。",
                        suggestions: ["保持済みGit refを確認してください。"],
                      },
                    },
                  ],
                }
              : comment,
          ),
        },
      });
    },
  );

  try {
    const initialRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.pathname === `/api/pull-requests/${pullRequestId}/refresh`
      );
    });
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await initialRefresh;
    await page.getByRole("button", { name: /^コメント \d+$/u }).click();

    const validCard = page.locator(".comment-list-item").filter({
      has: page.getByText(validBody, { exact: true }),
    });
    await expect(validCard).toBeVisible();
    await expect(validCard.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".comment-list > .error-notice")).toHaveCount(0);

    await page.getByRole("button", { name: /^解決済み/u }).click();
    const brokenCard = page.locator(".comment-list-item").filter({
      has: page.getByText(brokenBody, { exact: true }),
    });
    await expect(brokenCard).toBeVisible();
    await expect(brokenCard.getByRole("alert")).toContainText(
      "コメント作成時のcommitを取得できません。",
    );
    await expect(brokenCard.getByRole("alert")).toContainText("COMMIT_NOT_FOUND");
    await brokenCard.getByRole("button", { name: "配置を再試行" }).click();
    await expect(brokenCard.getByRole("alert")).toHaveCount(0);
    await expect(brokenCard.getByRole("button", { name: "配置を再試行" })).toHaveCount(0);
  } finally {
    await deleteComments(request, [validId, brokenId]);
  }
});

test("invalidates Git-backed queries only when the repository location changes", async ({
  page,
  request,
}) => {
  let documentRequests = 0;
  await page.route(`**/api/pull-requests/${pullRequestId}/document?*`, async (route) => {
    const url = new URL(route.request().url());
    if (
      url.searchParams.get("kind") !== "repository-file" ||
      url.searchParams.get("path") !== "src/fixture.ts"
    ) {
      await route.fallback();
      return;
    }
    documentRequests += 1;
    if (documentRequests !== 1) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const payload = (await response.json()) as {
      document: {
        ref: unknown;
        availability: string;
        text: string | null;
        byteLength: number;
        oid: string | null;
      };
    };
    await route.fulfill({
      response,
      json: {
        ...payload,
        document: {
          ...payload.document,
          availability: "missing",
          text: null,
          byteLength: 0,
          oid: null,
        },
      },
    });
  });

  try {
    const initialRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.pathname === `/api/pull-requests/${pullRequestId}/refresh`
      );
    });
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await initialRefresh;
    await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
    await page.getByRole("button", { name: "全文", exact: true }).click();
    await expect(page.getByText("文書が見つかりません。", { exact: true })).toBeVisible();
    expect(documentRequests).toBe(1);

    const statusOnlyRevision = await request.post("/api/test/bump-revision", {
      data: { domains: ["pullRequests"] },
    });
    expect(statusOnlyRevision.ok()).toBe(true);
    await page.waitForTimeout(1_250);
    expect(documentRequests).toBe(1);
    await expect(page.getByText("文書が見つかりません。", { exact: true })).toBeVisible();

    const locationUpdate = await request.post("/api/test/repository-location", {
      data: { version: 1 },
    });
    expect(locationUpdate.ok()).toBe(true);
    await expect.poll(() => documentRequests).toBe(2);
    await expect(page.locator('.document-pane[data-pane="left"]')).toContainText(
      "export function fixture",
    );
  } finally {
    const resetLocation = await request.post("/api/test/repository-location", {
      data: { version: 0 },
    });
    expect(resetLocation.ok()).toBe(true);
  }
});

test("restarts an initial Git-backed document GET after the repository location changes", async ({
  page,
  request,
}) => {
  const resetBeforeOpen = await request.post("/api/test/repository-location", {
    data: { version: 0 },
  });
  expect(resetBeforeOpen.ok()).toBe(true);
  let releaseInitialDocument = (): void => {};
  const initialDocumentGate = new Promise<void>((resolve) => {
    releaseInitialDocument = resolve;
  });
  let initialDocumentCaptured = (): void => {};
  const initialDocumentCapturedPromise = new Promise<void>((resolve) => {
    initialDocumentCaptured = resolve;
  });
  let documentRequests = 0;
  await page.route(`**/api/pull-requests/${pullRequestId}/document?*`, async (route) => {
    const url = new URL(route.request().url());
    if (
      url.searchParams.get("kind") !== "repository-file" ||
      url.searchParams.get("path") !== "src/fixture.ts"
    ) {
      await route.fallback();
      return;
    }
    documentRequests += 1;
    if (documentRequests !== 1) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const payload = (await response.json()) as {
      document: {
        ref: unknown;
        availability: string;
        text: string | null;
        byteLength: number;
        oid: string | null;
      };
    };
    initialDocumentCaptured();
    await initialDocumentGate;
    try {
      await route.fulfill({
        response,
        json: {
          ...payload,
          document: {
            ...payload.document,
            availability: "missing",
            text: null,
            byteLength: 0,
            oid: null,
          },
        },
      });
    } catch {
      // The location boundary cancels this stale browser request.
    }
  });

  try {
    const initialRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.pathname === `/api/pull-requests/${pullRequestId}/refresh`
      );
    });
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await initialRefresh;
    await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
    await page.getByRole("button", { name: "全文", exact: true }).click();
    await initialDocumentCapturedPromise;

    const locationUpdate = await request.post("/api/test/repository-location", {
      data: { version: 2 },
    });
    expect(locationUpdate.ok()).toBe(true);
    await expect.poll(() => documentRequests).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.document-pane[data-pane="left"]')).toContainText(
      "export function fixture",
    );
  } finally {
    releaseInitialDocument();
    const resetLocation = await request.post("/api/test/repository-location", {
      data: { version: 0 },
    });
    expect(resetLocation.ok()).toBe(true);
  }
});

test("keeps current annotations visible while a changed placement set is loading", async ({
  page,
  request,
}) => {
  const survivingBody = "Placement continuity survivor";
  const deletedBody = "Placement continuity deleted";
  const createdBody = "Placement continuity added";
  const survivingId = await createRepositoryComment(request, survivingBody);
  const deletedId = await createRepositoryComment(request, deletedBody);
  let createdId: string | null = null;
  let delayNextPlacement = false;
  let releasePlacement = (): void => {};
  const placementGate = new Promise<void>((resolve) => {
    releasePlacement = resolve;
  });
  let delayedPlacementStarted = (): void => {};
  const delayedPlacementStartedPromise = new Promise<void>((resolve) => {
    delayedPlacementStarted = resolve;
  });
  await page.route(
    `**/api/pull-requests/${pullRequestId}/comment-placements/resolve`,
    async (route) => {
      const body = route.request().postDataJSON() as {
        commentIds?: string[];
        destinations?: Array<{ kind?: string; ref?: { path?: string } }>;
      };
      const targetsFixture = body.destinations?.some(
        (destination) =>
          destination.kind === "document" && destination.ref?.path === "src/fixture.ts",
      );
      if (
        !delayNextPlacement ||
        !targetsFixture ||
        !createdId ||
        !body.commentIds?.includes(createdId)
      ) {
        await route.fallback();
        return;
      }
      delayNextPlacement = false;
      const response = await route.fetch();
      delayedPlacementStarted();
      await placementGate;
      await route.fulfill({ response });
    },
  );

  try {
    const initialRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.pathname === `/api/pull-requests/${pullRequestId}/refresh`
      );
    });
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await initialRefresh;
    await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
    const survivingThread = page.locator(
      `.comment-thread--inline[data-comment-id="${survivingId}"]`,
    );
    const deletedThread = page.locator(`.comment-thread--inline[data-comment-id="${deletedId}"]`);
    await expect(survivingThread).toContainText(survivingBody);
    await expect(deletedThread).toContainText(deletedBody);

    delayNextPlacement = true;
    const deletion = await request.delete(`/api/comments/${deletedId}`, { data: {} });
    expect(deletion.ok()).toBe(true);
    createdId = await createRepositoryComment(request, createdBody);
    await delayedPlacementStartedPromise;

    await expect(survivingThread).toContainText(survivingBody);
    await expect(deletedThread).toHaveCount(0);
    const createdThread = page.locator(`.comment-thread--inline[data-comment-id="${createdId}"]`);
    await expect(createdThread).toHaveCount(0);

    releasePlacement();
    await expect(createdThread).toContainText(createdBody);
  } finally {
    releasePlacement();
    await deleteComments(request, createdId ? [survivingId, createdId] : [survivingId, deletedId]);
  }
});

for (const firstResponse of ["document", "placement"] as const) {
  test(`keeps PR Markdown content and placements on one revision when ${firstResponse} resolves first`, async ({
    page,
    request,
  }) => {
    const resetSync = await request.post("/api/test/reset-sync-stage", { data: {} });
    expect(resetSync.ok()).toBe(true);
    let commentId: string | null = null;
    let holdNextDocument = false;
    let holdNextPlacement = false;
    let releaseDocument = (): void => {};
    const documentGate = new Promise<void>((resolve) => {
      releaseDocument = resolve;
    });
    let documentStarted = (): void => {};
    const documentStartedPromise = new Promise<void>((resolve) => {
      documentStarted = resolve;
    });
    let documentFinished = (): void => {};
    const documentFinishedPromise = new Promise<void>((resolve) => {
      documentFinished = resolve;
    });
    let releasePlacement = (): void => {};
    const placementGate = new Promise<void>((resolve) => {
      releasePlacement = resolve;
    });
    let placementStarted = (): void => {};
    const placementStartedPromise = new Promise<void>((resolve) => {
      placementStarted = resolve;
    });
    let placementFinished = (): void => {};
    const placementFinishedPromise = new Promise<void>((resolve) => {
      placementFinished = resolve;
    });

    await page.route(`**/api/pull-requests/${pullRequestId}/document?*`, async (route) => {
      const url = new URL(route.request().url());
      if (!holdNextDocument || url.searchParams.get("kind") !== "pull-request-markdown") {
        await route.fallback();
        return;
      }
      holdNextDocument = false;
      const response = await route.fetch();
      documentStarted();
      await documentGate;
      await route.fulfill({ response });
      documentFinished();
    });
    await page.route(
      `**/api/pull-requests/${pullRequestId}/comment-placements/resolve`,
      async (route) => {
        const input = route.request().postDataJSON() as {
          commentIds?: string[];
          destinations?: Array<{ kind?: string; ref?: { kind?: string } }>;
        };
        const targetsPullRequestMarkdown = input.destinations?.some(
          (destination) =>
            destination.kind === "document" && destination.ref?.kind === "pull-request-markdown",
        );
        if (
          !holdNextPlacement ||
          !targetsPullRequestMarkdown ||
          !commentId ||
          !input.commentIds?.includes(commentId)
        ) {
          await route.fallback();
          return;
        }
        holdNextPlacement = false;
        const response = await route.fetch();
        placementStarted();
        await placementGate;
        await route.fulfill({ response });
        placementFinished();
      },
    );

    try {
      const initialRefresh = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          url.pathname === `/api/pull-requests/${pullRequestId}/refresh`
        );
      });
      await page.goto(`/?pullRequestId=${pullRequestId}`);
      await initialRefresh;
      await expect(
        page.getByText("This is always the latest PR body.", { exact: true }),
      ).toBeVisible();

      const commentResponse = await request.post("/api/comments", {
        data: {
          pullRequestId,
          target: {
            kind: "document",
            documentKind: "pull-request-markdown",
            sourceDocumentHash: "ignored-by-fixture",
            quotedText: "ignored-by-fixture",
            startLine: 3,
            endLine: 3,
          },
          body: `PR content revision fixture ${firstResponse}`,
          authorLabel: "Performance fixture",
        },
      });
      expect(commentResponse.ok()).toBe(true);
      commentId = ((await commentResponse.json()) as { comment: { id: string } }).comment.id;
      const inlineThread = page.locator(`.comment-thread--inline[data-comment-id="${commentId}"]`);
      await expect(inlineThread).toBeVisible();

      holdNextDocument = true;
      holdNextPlacement = true;
      const externalRefresh = await request.post(`/api/pull-requests/${pullRequestId}/refresh`, {
        data: {},
      });
      expect(externalRefresh.ok()).toBe(true);
      await Promise.all([documentStartedPromise, placementStartedPromise]);

      await expect(inlineThread).toHaveCount(0);
      await expect(
        page.getByText("This is always the latest PR body.", { exact: true }),
      ).toHaveCount(0);

      if (firstResponse === "document") {
        releaseDocument();
        await documentFinishedPromise;
        await expect(page.getByText("The PR body was rewritten.", { exact: true })).toBeVisible();
        await expect(inlineThread).toHaveCount(0);
        releasePlacement();
        await placementFinishedPromise;
      } else {
        releasePlacement();
        await placementFinishedPromise;
        await expect(inlineThread).toHaveCount(0);
        await expect(
          page.getByText("This is always the latest PR body.", { exact: true }),
        ).toHaveCount(0);
        releaseDocument();
        await documentFinishedPromise;
        await expect(page.getByText("The PR body was rewritten.", { exact: true })).toBeVisible();
      }
      await expect(inlineThread).toHaveCount(0);
    } finally {
      releaseDocument();
      releasePlacement();
      if (commentId) await deleteComments(request, [commentId]);
    }
  });
}
