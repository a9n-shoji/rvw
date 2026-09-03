import { expect, test } from "@playwright/test";

const defaultPort = Number(process.env.RVW_E2E_PORT ?? 43117);
const realisticPort = Number(process.env.RVW_REALISTIC_E2E_PORT ?? defaultPort + 1);
const realisticBaseURL = `http://127.0.0.1:${realisticPort}`;
const pullRequestId = "22222222-2222-4222-8222-222222222222";

test("reviews the deterministic resilient-order PR across artifacts", async ({ page, request }) => {
  await page.goto(realisticBaseURL);
  const hideClosedOrMergedFilter = page.getByRole("checkbox", {
    name: "Closed / Merged を非表示",
  });
  const statusBadges = page.locator(".pull-request-status");
  const rows = page.locator(".pull-request-row");
  await expect(hideClosedOrMergedFilter).toBeChecked();
  await expect(rows).toHaveCount(3);
  await expect(statusBadges).toHaveText(["Open", "Draft"]);
  await expect(rows.nth(2)).toContainText("Legacy: status not synchronized yet");
  await expect(rows.nth(2).locator(".pull-request-status")).toHaveCount(0);

  await hideClosedOrMergedFilter.uncheck();
  await expect(rows).toHaveCount(5);
  await expect(statusBadges).toHaveText(["Open", "Draft", "Closed", "Merged"]);
  await rows.nth(3).click();
  await expect(
    page.getByRole("heading", {
      name: "Implement resilient order placement with idempotent retries, transactional outbox, and payment recovery",
    }),
  ).toBeVisible();
  await page.goBack();
  await expect(hideClosedOrMergedFilter).not.toBeChecked();
  await expect(rows).toHaveCount(5);

  const viewResponse = await request.get(`${realisticBaseURL}/api/pull-requests/${pullRequestId}`);
  expect(viewResponse.ok()).toBe(true);
  const view = (await viewResponse.json()) as {
    headOid: string;
    comparisonBaseOid: string;
    commits: Array<{ oid: string }>;
  };
  expect(view.commits).toHaveLength(7);

  const treeResponse = await request.get(
    `${realisticBaseURL}/api/pull-requests/${pullRequestId}/tree?oid=${view.headOid}`,
  );
  expect(treeResponse.ok()).toBe(true);
  const tree = (await treeResponse.json()) as {
    entries: Array<{ path: string; size: number | null }>;
  };
  expect(tree.entries.length).toBe(130);
  expect(tree.entries.map(({ path }) => path)).toContain("src/application/orders/create-order.ts");
  expect(tree.entries.map(({ path }) => path)).toContain("src/modules/catalog/queries.ts");

  const changesResponse = await request.get(
    `${realisticBaseURL}/api/pull-requests/${pullRequestId}/changed-files?oldOid=${view.comparisonBaseOid}&newOid=${view.headOid}`,
  );
  expect(changesResponse.ok()).toBe(true);
  const changes = (await changesResponse.json()) as {
    files: Array<{ kind: string; oldPath: string | null; newPath: string | null }>;
  };
  expect(changes.files).toHaveLength(43);
  expect(changes.files).toContainEqual(
    expect.objectContaining({
      kind: "renamed",
      oldPath: "src/application/orders/retry-policy.ts",
      newPath: "src/application/orders/idempotency-policy.ts",
    }),
  );
  expect(changes.files).toContainEqual(
    expect.objectContaining({ kind: "deleted", oldPath: "src/workers/legacy-payment-cleaner.ts" }),
  );

  await page.goto(`${realisticBaseURL}/?pullRequestId=${pullRequestId}`);
  await expect(
    page.getByRole("heading", {
      name: "Implement resilient order placement with idempotent retries, transactional outbox, and payment recovery",
    }),
  ).toBeVisible();
  await expect(page.getByText("Transaction boundary", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "ウォークスルー 3", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Structure 4", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "コメント 7", exact: true })).toBeVisible();

  const commitPicker = page
    .getByRole("region", { name: "レビュー範囲", exact: true })
    .getByRole("button", { name: /^対象commit:/ });
  await expect(commitPicker).toHaveAccessibleName(/7 commits.*PR全体/);
  await commitPicker.click();
  await expect(
    page.getByRole("dialog", { name: "対象commitを選択" }).getByRole("option"),
  ).toHaveCount(7);

  const fileSearch = page.getByPlaceholder("ファイル名を検索");
  await fileSearch.fill("create-order.ts");
  await page
    .getByRole("button", { name: "src/application/orders/create-order.ts", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "src/application/orders/create-order.ts", exact: true }),
  ).toHaveAttribute("aria-selected", "true");

  await fileSearch.fill("idempotency-policy.ts");
  await page
    .getByRole("button", { name: "src/application/orders/idempotency-policy.ts", exact: true })
    .click();
  await expect(page.locator("diffs-container")).toContainText("IdempotencyEnvelope");

  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await fileSearch.fill("src/modules/catalog/queries.ts");
  await page.getByRole("button", { name: "src/modules/catalog/queries.ts", exact: true }).click();
  await expect(page.getByText("差分なし · 全文表示", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "ウォークスルー 3", exact: true }).click();
  await page
    .getByRole("navigation", { name: "レビュー文書" })
    .getByRole("button", { name: "Review route: authenticated order placement", exact: true })
    .click();
  await page
    .locator(".walkthrough-inline-reference")
    .filter({ hasText: "CreateOrderHandler" })
    .click({ modifiers: ["Meta"] });
  await expect(page.locator('.document-pane[data-pane="right"]')).toContainText(
    "class CreateOrderHandler",
  );

  await page.getByRole("button", { name: "Structure 4", exact: true }).click();
  await page
    .getByRole("navigation", { name: "レビュー文書" })
    .getByRole("button", { name: "Order placement behavior", exact: true })
    .click();
  const placementStructure = page.locator(
    '[data-structure-id="74000000-0000-4000-8000-000000000001"]',
  );
  await expect(
    placementStructure.locator('.structure-node[data-node-id="orders-route"]'),
  ).toHaveClass(/focused/);

  await page
    .getByRole("navigation", { name: "レビュー文書" })
    .getByRole("button", { name: "Idempotent retry convergence", exact: true })
    .click();
  await expect(
    page
      .locator('[data-structure-id="74000000-0000-4000-8000-000000000002"]')
      .locator('.structure-node[data-node-id="idempotency-store"]'),
  ).toHaveClass(/focused/);

  await fileSearch.fill("create-order.ts");
  await page
    .getByRole("button", { name: "src/application/orders/create-order.ts", exact: true })
    .click();
  const backlinks = page
    .getByRole("button", {
      name: "このファイルを参照するStructure 2件",
      exact: true,
    })
    .first();
  await expect(backlinks).toBeVisible();
  await backlinks.click();
  const backlinkMenu = page.getByRole("menu", { name: "このファイルを参照するStructure" });
  await expect(backlinkMenu.getByRole("menuitem")).toHaveText([
    /Order placement behavior/u,
    /Idempotent retry convergence/u,
  ]);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "コメント 7", exact: true }).click();
  const reviewSidebar = page.getByLabel("レビューサイドバー");
  const deletedSourceThread = reviewSidebar
    .locator(".comment-thread")
    .filter({ hasText: "This best-effort loop can void a payment" });
  await expect(deletedSourceThread.getByText("Outdated", { exact: true })).toBeVisible();
  await expect(
    reviewSidebar.getByText(
      "The provider uses order ID idempotency, and the final commit adds orphan reconciliation.",
      { exact: true },
    ),
  ).toBeVisible();
  await reviewSidebar.getByRole("button", { name: "解決済み 6", exact: true }).click();
  await expect(
    reviewSidebar.getByText(
      "Manual capture is the right failure boundary. Please add recovery ownership before resolving this.",
      { exact: true },
    ),
  ).toBeVisible();

  await commitPicker.click();
  await page
    .getByRole("dialog", { name: "対象commitを選択" })
    .getByRole("button", { name: "最新だけ", exact: true })
    .click();
  await expect(commitPicker).toHaveAccessibleName(
    /Recover orphan payments and close review feedback.*最新/u,
  );
  await expect(
    page.getByRole("heading", {
      name: "Implement resilient order placement with idempotent retries, transactional outbox, and payment recovery",
    }),
  ).toBeVisible();
});

test("keeps realistic comments and Structure backlinks coherent at the latest head", async ({
  request,
}) => {
  const view = (await (
    await request.get(`${realisticBaseURL}/api/pull-requests/${pullRequestId}`)
  ).json()) as { headOid: string; commits: Array<{ oid: string; subject: string }> };
  const comments = (await (
    await request.get(
      `${realisticBaseURL}/api/pull-requests/${pullRequestId}/comments?resolved=all`,
    )
  ).json()) as {
    comments: Array<{
      id: string;
      resolvedAt: string | null;
      target: { startLine: number | null; endLine: number | null };
      posts: Array<{ body: string; relatedCommitOid: string | null }>;
    }>;
  };
  expect(comments.comments).toHaveLength(13);
  expect(comments.comments.filter(({ resolvedAt }) => resolvedAt === null)).toHaveLength(7);
  expect(comments.comments.filter(({ resolvedAt }) => resolvedAt !== null)).toHaveLength(6);
  expect(comments.comments.filter(({ posts }) => posts.length > 1)).toHaveLength(8);
  expect(comments.comments.flatMap(({ posts }) => posts.map(({ body }) => body))).toContain(
    "Renamed to idempotency-policy.ts and made the actor-scoped envelope explicit.",
  );
  expect(
    comments.comments.some(({ posts }) =>
      posts.some(({ relatedCommitOid }) => relatedCommitOid === view.commits[2]?.oid),
    ),
  ).toBe(true);

  const placements = (await (
    await request.post(
      `${realisticBaseURL}/api/pull-requests/${pullRequestId}/comment-placements/resolve`,
      {
        data: {
          commentIds: [
            "75000000-0000-4000-8000-000000000006",
            "75000000-0000-4000-8000-000000000007",
          ],
          destinations: [{ kind: "commit", oid: view.headOid }],
        },
      },
    )
  ).json()) as {
    comments: Array<{
      commentId: string;
      placements: Array<{ placement: { outdated: boolean; path: string | null } }>;
    }>;
  };
  expect(placements.comments).toEqual([
    expect.objectContaining({
      commentId: "75000000-0000-4000-8000-000000000006",
      placements: [
        expect.objectContaining({
          placement: expect.objectContaining({
            outdated: false,
            path: "src/application/orders/idempotency-policy.ts",
          }),
        }),
      ],
    }),
    expect.objectContaining({
      commentId: "75000000-0000-4000-8000-000000000007",
      placements: [
        expect.objectContaining({
          placement: expect.objectContaining({
            outdated: true,
            path: "src/workers/legacy-payment-cleaner.ts",
          }),
        }),
      ],
    }),
  ]);

  const shiftedCommentId = "75000000-0000-4000-8000-000000000008";
  const shiftedSource = comments.comments.find(({ id }) => id === shiftedCommentId)?.target;
  const shiftedPlacement = (await (
    await request.post(
      `${realisticBaseURL}/api/pull-requests/${pullRequestId}/comment-placements/resolve`,
      {
        data: {
          commentIds: [shiftedCommentId],
          destinations: [{ kind: "commit", oid: view.headOid }],
        },
      },
    )
  ).json()) as {
    comments: Array<{
      placements: Array<{
        placement: {
          outdated: boolean;
          path: string | null;
          range: { startLine: number; endLine: number } | null;
        };
      }>;
    }>;
  };
  expect(shiftedSource?.startLine).not.toBeNull();
  expect(shiftedPlacement.comments[0]?.placements[0]?.placement).toMatchObject({
    outdated: false,
    path: "src/application/orders/create-order.ts",
  });
  expect(shiftedPlacement.comments[0]?.placements[0]?.placement.range?.startLine).toBeGreaterThan(
    shiftedSource?.startLine ?? Number.MAX_SAFE_INTEGER,
  );

  const structures = (await (
    await request.get(`${realisticBaseURL}/api/pull-requests/${pullRequestId}/structures`)
  ).json()) as { structures: Array<{ id: string; title: string }> };
  expect(structures.structures.map(({ title }) => title)).toEqual([
    "Order placement behavior",
    "Idempotent retry convergence",
    "Payment reconciliation recovery",
    "Transactional outbox delivery",
  ]);
  const recovery = (await (
    await request.get(
      `${realisticBaseURL}/api/pull-requests/${pullRequestId}/structures/74000000-0000-4000-8000-000000000003`,
    )
  ).json()) as { structure: { originNodeId: string } };
  expect(recovery.structure.originNodeId).toBe("reconciliation-decision");

  const backlinks = (await (
    await request.get(
      `${realisticBaseURL}/api/pull-requests/${pullRequestId}/structure-reference-index?sourceOid=${view.headOid}`,
    )
  ).json()) as {
    index: {
      entries: Array<{
        path: string;
        references: Array<{ structure: { title: string }; targetNodeId: string }>;
      }>;
    };
  };
  const handlerEntry = backlinks.index.entries.find(
    ({ path }) => path === "src/application/orders/create-order.ts",
  );
  expect(handlerEntry?.references.map(({ structure }) => structure.title)).toEqual([
    "Order placement behavior",
    "Idempotent retry convergence",
  ]);

  const intermediateChanges = (await (
    await request.get(
      `${realisticBaseURL}/api/pull-requests/${pullRequestId}/changed-files?oldOid=${view.commits[2]?.oid}&newOid=${view.commits[3]?.oid}`,
    )
  ).json()) as { files: Array<{ kind: string; oldPath: string | null; newPath: string | null }> };
  expect(intermediateChanges.files).toContainEqual(
    expect.objectContaining({
      kind: "renamed",
      oldPath: "src/application/orders/retry-policy.ts",
      newPath: "src/application/orders/idempotency-policy.ts",
    }),
  );
});
