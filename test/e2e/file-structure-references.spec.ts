import { expect, test, type Page } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const primaryStructureId = "80000000-0000-4000-8000-000000000001";
const secondaryStructureId = "80000000-0000-4000-8000-000000000002";

async function openFileFromPalette(page: Page, path: string): Promise<void> {
  await page.keyboard.press("Control+P");
  const palette = page.getByRole("dialog", { name: "ファイルを開く" });
  await palette.getByRole("combobox", { name: "ファイル名で検索" }).fill(path);
  await palette.getByRole("option", { name: path, exact: true }).click();
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
