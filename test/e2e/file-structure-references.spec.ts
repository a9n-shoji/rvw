import { expect, test, type Page } from "@playwright/test";
import type { Structure } from "../../src/domain/models.js";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const primaryStructureId = "80000000-0000-4000-8000-000000000001";
const secondaryStructureId = "80000000-0000-4000-8000-000000000002";

test.afterEach(async ({ request }) => {
  const response = await request.post("/api/test/reset-sync-stage", { data: {} });
  expect(response.ok()).toBe(true);
});

async function openFileFromPalette(page: Page, path: string): Promise<void> {
  await page.keyboard.press("Control+P");
  const palette = page.getByRole("dialog", { name: "ファイルを開く" });
  await palette.getByRole("combobox", { name: "ファイル名で検索" }).fill(path);
  await palette.getByRole("option", { name: path, exact: true }).click();
}

async function createTransientPullRequestComment(page: Page): Promise<string> {
  const response = await page.request.post("/api/comments", {
    data: {
      pullRequestId,
      target: { kind: "pull-request" },
      body: "Structure backlink refresh isolation fixture.",
      authorLabel: "Codex · Structure backlink fixture",
    },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { comment: { id: string } }).comment.id;
}

async function deleteTransientComment(page: Page, commentId: string): Promise<void> {
  const response = await page.request.delete(`/api/comments/${commentId}`, { data: {} });
  expect(response.ok()).toBe(true);
}

test("navigates from a file backlink to the focused Structure Node and restores reading state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto(`/?pullRequestId=${pullRequestId}`);

  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  await page.getByRole("button", { name: "Structure 3", exact: true }).click();
  await reviewTree.getByRole("button", { name: "Order placement behavior", exact: true }).click();
  const primaryViewer = page.locator(`[data-structure-id="${primaryStructureId}"]`);
  await primaryViewer.locator('.structure-node[data-node-id="order-aggregate"]').click();
  await primaryViewer.getByRole("button", { name: "縮小", exact: true }).click();
  const scaleBeforeNavigation = await primaryViewer.getAttribute("data-viewport-scale");
  const hubPositionBeforeNavigation = await primaryViewer
    .locator('.structure-node[data-node-id="hub"]')
    .evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    }));

  await page.setViewportSize({ width: 1100, height: 520 });
  const sourcePath = "src/application/orders/create-order.ts";
  await page.getByRole("button", { name: sourcePath, exact: true }).click();
  const leftPane = page.locator('.document-pane[data-pane="left"]');
  const structureTrigger = leftPane.getByRole("button", {
    name: "このファイルを参照するStructure 1件",
    exact: true,
  });
  const commentTrigger = leftPane.getByRole("button", {
    name: "ファイル全体へコメント",
    exact: true,
  });
  await expect(structureTrigger).toBeEnabled();
  expect(
    await commentTrigger.evaluate((element) =>
      element.previousElementSibling?.classList.contains("file-structure-references"),
    ),
  ).toBe(true);

  await structureTrigger.click();
  const menu = page.getByRole("menu", { name: "このファイルを参照するStructure" });
  const result = menu.getByRole("menuitem", {
    name: /Order placement behavior Node: Create order \+1/u,
  });
  await expect(menu).toBeVisible();
  await expect(result).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(structureTrigger).toBeFocused();

  const storedScrollTop = await leftPane.evaluate((element) => {
    element.scrollTop = 120;
    element.dispatchEvent(new Event("scroll"));
    return element.scrollTop;
  });
  expect(storedScrollTop).toBeGreaterThan(0);
  await structureTrigger.click();
  await page
    .getByRole("menu", { name: "このファイルを参照するStructure" })
    .getByRole("menuitem", { name: /Order placement behavior Node: Create order \+1/u })
    .click();

  await expect(page.getByRole("tab", { name: "Order placement behavior" })).toHaveCount(1);
  await expect(primaryViewer).toBeVisible();
  await expect(primaryViewer.locator('.structure-node[data-node-id="hub"]')).toHaveClass(
    /focused/u,
  );
  await expect(primaryViewer).toHaveAttribute("data-viewport-scale", scaleBeforeNavigation!);
  expect(
    await primaryViewer.locator('.structure-node[data-node-id="hub"]').evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    })),
  ).toEqual(hubPositionBeforeNavigation);
  await expect
    .poll(async () => {
      const [canvas, focusedNode] = await Promise.all([
        primaryViewer.locator(".structure-canvas").boundingBox(),
        primaryViewer.locator(".structure-node.focused").boundingBox(),
      ]);
      if (!canvas || !focusedNode) return Number.POSITIVE_INFINITY;
      return Math.hypot(
        focusedNode.x + focusedNode.width / 2 - (canvas.x + canvas.width / 2),
        focusedNode.y + focusedNode.height / 2 - (canvas.y + canvas.height / 2),
      );
    })
    .toBeLessThan(4);

  await page.goBack();
  await expect(leftPane.getByRole("tab", { name: sourcePath })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect
    .poll(async () => await leftPane.evaluate((element) => element.scrollTop))
    .toBe(storedScrollTop);
});

test("keeps zero and Edge-only backlinks disabled and resolves a renamed file", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);

  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  const noReferenceTrigger = page.getByRole("button", {
    name: "このレビュー版では、このファイルをNodeから参照するStructureはありません",
    exact: true,
  });
  await expect(noReferenceTrigger).toBeDisabled();

  await openFileFromPalette(page, "src/edge-only-evidence.ts");
  await expect(
    page.getByRole("button", {
      name: "このレビュー版では、このファイルをNodeから参照するStructureはありません",
      exact: true,
    }),
  ).toBeDisabled();

  await openFileFromPalette(page, "docs/hybrid.md");
  const renamedTrigger = page.getByRole("button", {
    name: "このファイルを参照するStructure 1件",
    exact: true,
  });
  await renamedTrigger.click();
  const renamedResult = page
    .getByRole("menu", { name: "このファイルを参照するStructure" })
    .getByRole("menuitem", {
      name: /Payment reconciliation recovery Node: Payment reconciliation/u,
    });
  await expect(renamedResult).toBeVisible();
  await renamedResult.click();
  const secondaryViewer = page.locator(`[data-structure-id="${secondaryStructureId}"]`);
  await expect(secondaryViewer).toBeVisible();
  await expect(
    secondaryViewer.locator('.structure-node[data-node-id="payment-reconciliation"]'),
  ).toHaveClass(/focused/u);
});

test("waits for a fresh Structure detail before validating a fresh backlink", async ({ page }) => {
  const freshUpdatedAt = "2026-08-08T03:00:00.000Z";
  let initialStructure: Structure | null = null;
  let detailRequests = 0;
  let releaseFreshDetail = (): void => {};
  const freshDetailGate = new Promise<void>((resolve) => {
    releaseFreshDetail = resolve;
  });
  await page.route(
    `**/api/pull-requests/${pullRequestId}/structures/${primaryStructureId}`,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      detailRequests += 1;
      const response = await route.fetch();
      const body = (await response.json()) as { ok: true; structure: Structure };
      initialStructure ??= body.structure;
      if (detailRequests === 1) {
        await route.fulfill({ response, json: body });
        return;
      }
      await freshDetailGate;
      const freshStructure: Structure = {
        ...initialStructure,
        nodes: [
          ...initialStructure.nodes,
          {
            id: "fresh-backlink-node",
            label: "Fresh backlink Node",
            description: "The Node added by the fresh Structure revision.",
            kind: "fixture",
            notation: "plain",
            anchor: { path: "src/fixture.ts", startLine: 1, endLine: 1 },
          },
        ],
        edges: [
          ...initialStructure.edges,
          {
            id: "fresh-backlink-edge",
            from: initialStructure.originNodeId,
            to: "fresh-backlink-node",
            label: "adds",
            directed: true,
            anchors: [],
          },
        ],
        updatedAt: freshUpdatedAt,
      };
      await route.fulfill({ response, json: { ok: true, structure: freshStructure } });
    },
  );
  await page.route("**/structure-references?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "src/fixture.ts") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        references: [
          {
            structure: {
              id: primaryStructureId,
              ref: `rvw://structure/${primaryStructureId}`,
              pullRequestId,
              sourceOid: "b".repeat(40),
              title: "Order placement behavior",
              scope: "Fresh backlink fixture",
              createdAt: "2026-08-08T01:00:00.000Z",
              updatedAt: freshUpdatedAt,
            },
            targetNodeId: "fresh-backlink-node",
            targetNodeLabel: "Fresh backlink Node",
            matchingNodeCount: 1,
          },
        ],
      },
    });
  });

  let commentId: string | null = null;
  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await page.getByRole("button", { name: "Structure 3", exact: true }).click();
    await page
      .getByRole("navigation", { name: "レビュー文書" })
      .getByRole("button", { name: "Order placement behavior", exact: true })
      .click();
    const viewer = page.locator(`[data-structure-id="${primaryStructureId}"]`);
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('.structure-node[data-node-id="fresh-backlink-node"]')).toHaveCount(
      0,
    );

    commentId = await createTransientPullRequestComment(page);
    await expect.poll(() => detailRequests).toBeGreaterThan(1);
    await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
    await page
      .getByRole("button", { name: "このファイルを参照するStructure 1件", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: /Order placement behavior Node: Fresh backlink Node/u })
      .click();

    await expect(viewer).toBeVisible();
    await expect(
      viewer.getByText("移動先のNodeはStructureの更新により削除されています"),
    ).toHaveCount(0);
    releaseFreshDetail();
    await expect(viewer.locator('.structure-node[data-node-id="fresh-backlink-node"]')).toHaveClass(
      /focused/u,
    );
  } finally {
    releaseFreshDetail();
    if (commentId) await deleteTransientComment(page, commentId);
  }
});

test("keeps an open backlink menu focused across unrelated comment updates", async ({ page }) => {
  const sourcePath = "src/application/orders/create-order.ts";
  let lookupRequests = 0;
  await page.route("**/structure-references?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") === sourcePath) lookupRequests += 1;
    await route.fallback();
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
  await page.getByRole("button", { name: sourcePath, exact: true }).click();
  const trigger = page.getByRole("button", {
    name: "このファイルを参照するStructure 1件",
    exact: true,
  });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "このファイルを参照するStructure" });
  const menuItem = menu.getByRole("menuitem", {
    name: /Order placement behavior Node: Create order \+1/u,
  });
  await expect(menuItem).toBeFocused();

  const structuresRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname === `/api/pull-requests/${pullRequestId}/structures`
    );
  });
  const commentId = await createTransientPullRequestComment(page);
  try {
    await structuresRefresh;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
        }),
    );
    expect(lookupRequests).toBe(1);
    await expect(menu).toBeVisible();
    await expect(menuItem).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  } finally {
    await deleteTransientComment(page, commentId);
  }
});

test("reports a concurrently removed target Node and refreshes the backlink", async ({ page }) => {
  let lookupRequests = 0;
  await page.route("**/structure-references?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "src/fixture.ts") {
      await route.fallback();
      return;
    }
    lookupRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        references: [
          {
            structure: {
              id: primaryStructureId,
              ref: `rvw://structure/${primaryStructureId}`,
              pullRequestId,
              sourceOid: "b".repeat(40),
              title: "Order placement behavior",
              scope: "Concurrent update fixture",
              createdAt: "2026-08-08T01:00:00.000Z",
              updatedAt: "2026-08-08T01:00:00.000Z",
            },
            targetNodeId: "removed-node",
            targetNodeLabel: "Removed Node",
            matchingNodeCount: 1,
          },
        ],
      }),
    });
  });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  await page
    .getByRole("button", { name: "このファイルを参照するStructure 1件", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: /Order placement behavior Node: Removed Node/u })
    .click();

  const viewer = page.locator(`[data-structure-id="${primaryStructureId}"]`);
  await expect(viewer.getByRole("status")).toContainText(
    "移動先のNodeはStructureの更新により削除されています",
  );
  await page.goBack();
  await expect(page.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(() => lookupRequests).toBeGreaterThan(1);
});
