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

function placementKind(request: Request): string | null {
  if (!request.url().includes("/comment-placements/resolve")) return null;
  const body = request.postDataJSON() as { destinations?: Array<{ kind?: string }> };
  return body.destinations?.[0]?.kind ?? null;
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
    comments: Array<{ resolvedAt: string | null }>;
  };
  const expectedUnresolvedCount =
    initialComments.comments.filter(({ resolvedAt }) => resolvedAt === null).length + 100;
  const commentIds = await createRepositoryComments(request, 100);
  let mutationCommentId: string | null = null;
  const counts = { document: 0, commit: 0, single: 0, commentsGet: 0 };
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
    if (kind === "document") counts.document += 1;
    if (kind === "commit") counts.commit += 1;
  });

  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    const commentsToggle = page.getByRole("button", {
      name: `コメント ${expectedUnresolvedCount}`,
      exact: true,
    });
    await expect(commentsToggle).toBeVisible();
    await expect.poll(() => counts.document).toBeGreaterThanOrEqual(1);
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

    const sidebarOpenedAt = performance.now();
    await commentsToggle.click();
    await expect.poll(() => counts.commit).toBe(1);
    await expect(page.locator(".comment-list-item")).toHaveCount(expectedUnresolvedCount);
    const sidebarReadyMs = performance.now() - sidebarOpenedAt;
    await page.waitForTimeout(250);
    expect(counts.commit).toBe(1);
    expect(counts.single).toBe(0);

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
    await page.waitForTimeout(250);
    expect(counts.document - mutationRequestsBefore.document).toBeLessThanOrEqual(1);
    expect(counts.commit - mutationRequestsBefore.commit).toBeLessThanOrEqual(1);
    expect(counts.commentsGet).toBe(mutationRequestsBefore.commentsGet);

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
