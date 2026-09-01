import { expect, test, type APIRequestContext, type Request } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const sourceOid = "b".repeat(40);

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
