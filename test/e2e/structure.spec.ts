import { expect, test, type Page } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const primaryStructureId = "80000000-0000-4000-8000-000000000001";
const secondaryStructureId = "80000000-0000-4000-8000-000000000002";
const primaryTitle = "Fixture code relationships";
const secondaryTitle = "Source document relationship";

async function openStructure(page: Page, title: string): Promise<void> {
  const folder = page.getByRole("button", { name: /^Structure \d+$/ });
  if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
  await page
    .getByRole("navigation", { name: "レビュー文書" })
    .getByRole("button", { name: title, exact: true })
    .click();
}

test("explores source-exact Structures and preserves spatial context across navigation and update", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);

  const structureFolder = page.getByRole("button", { name: "Structure 2", exact: true });
  await expect(structureFolder).toHaveAttribute("aria-expanded", "false");
  await structureFolder.click();
  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  await expect(reviewTree.locator(".review-tree-structure")).toHaveCount(2);
  await expect(reviewTree.getByRole("button", { name: primaryTitle })).toHaveAttribute(
    "title",
    `${primaryTitle}\nThe fixture boundary and its direct committed relationships; transport startup is excluded.\n15 Nodes · 14 Edges · bbbbbbbb`,
  );
  await reviewTree.getByRole("button", { name: primaryTitle }).click();

  await expect(page.getByRole("tab", { name: primaryTitle })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const viewer = page.locator(`[data-structure-id="${primaryStructureId}"]`);
  await expect(viewer.getByRole("heading", { name: primaryTitle })).toBeVisible();
  await expect(viewer.getByText("14 / 15 Nodes", { exact: true })).toBeVisible();
  await expect(viewer.locator('.structure-node[data-node-id="hub"]')).toHaveClass(/focused/);
  await expect(viewer.locator('.structure-node[data-node-id="hub"]')).toHaveClass(
    /change-modified/,
  );
  await expect(viewer.locator(".structure-edge")).toHaveCount(4);
  await expect(viewer.getByRole("button", { name: "9件のrelationを表示" })).toBeVisible();
  await expect(viewer.locator(".structure-relation-list > li.collapsed")).toHaveCount(9);

  await viewer.locator('.structure-node[data-node-id="leaf-01"] .structure-node-focus').click();
  await expect(viewer.locator('.structure-node[data-node-id="leaf-01"]')).toHaveClass(/focused/);
  await expect(viewer.getByRole("heading", { name: "Direct relation 01" })).toBeVisible();
  await viewer.locator('.structure-node[data-node-id="hub"] .structure-node-focus').click();
  await expect(viewer.locator('.structure-node[data-node-id="hub"]')).toHaveClass(/focused/);

  await viewer.getByRole("button", { name: "9件のrelationを表示" }).click();
  await expect(viewer.locator(".structure-edge")).toHaveCount(13);
  await expect(viewer.getByRole("button", { name: "stable Edge ID順に折りたたむ" })).toBeVisible();
  await viewer.getByRole("button", { name: "stable Edge ID順に折りたたむ" }).click();
  await expect(viewer.locator(".structure-edge")).toHaveCount(4);

  await viewer.getByRole("button", { name: "2-hop", exact: true }).click();
  await expect(viewer.getByText("15 / 15 Nodes", { exact: true })).toBeVisible();
  await expect(viewer.locator('.structure-node[data-node-id="deep-node"]')).toBeVisible();
  await viewer.getByRole("button", { name: "All", exact: true }).click();
  await expect(viewer.getByText("15 / 15 Nodes", { exact: true })).toBeVisible();
  await viewer.getByRole("button", { name: "1-hop", exact: true }).click();

  const world = viewer.locator(".structure-world");
  const transformBeforeZoom = await world.evaluate((element) => element.style.transform);
  await viewer.getByRole("button", { name: "拡大" }).click();
  await expect
    .poll(async () => await world.evaluate((element) => element.style.transform))
    .not.toBe(transformBeforeZoom);

  const hub = viewer.locator('.structure-node[data-node-id="hub"]');
  const beforeDrag = await hub.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  }));
  const hubBox = await hub.boundingBox();
  expect(hubBox).not.toBeNull();
  await page.mouse.move(hubBox!.x + 30, hubBox!.y + 30);
  await page.mouse.down();
  await page.mouse.move(hubBox!.x + 110, hubBox!.y + 90, { steps: 6 });
  await page.mouse.up();
  const dragged = await hub.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  }));
  expect(dragged).not.toEqual(beforeDrag);

  const commitSelection = await page
    .getByRole("button", { name: /^対象commit:/ })
    .getAttribute("aria-label");
  const focusedNodeSource = viewer.locator(".structure-details > .structure-source");
  await expect(focusedNodeSource).toHaveAttribute("aria-label", "src/fixture.ts:1-3を開く");
  await focusedNodeSource.click();
  await expect(page.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator('.document-pane[data-pane="left"] diffs-container')).toHaveAttribute(
    "data-search-target-line",
    "1",
  );
  await expect(page.getByRole("button", { name: /^対象commit:/ })).toHaveAttribute(
    "aria-label",
    commitSelection!,
  );

  await page.getByRole("tab", { name: primaryTitle }).click();
  expect(
    await hub.evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    })),
  ).toEqual(dragged);
  await focusedNodeSource.click({ modifiers: ["Meta"] });
  await expect(page.locator('.document-pane[data-pane="right"]')).toBeVisible();
  await expect(
    page.locator('.document-pane[data-pane="right"]').getByRole("tab", { name: "src/fixture.ts" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator('.document-pane[data-pane="left"]').getByRole("tab", { name: primaryTitle }),
  ).toHaveAttribute("aria-selected", "true");

  const update = await page.request.post(`/api/fixture/structures/${primaryStructureId}/update`, {
    data: {},
  });
  expect(update.ok()).toBe(true);
  const updatedTitle = "Fixture code relationships updated";
  await expect(page.getByRole("tab", { name: updatedTitle })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(viewer.locator('.structure-node[data-node-id="hub"] strong')).toHaveText(
    "Fixture boundary updated",
  );
  await expect(viewer.locator('.structure-node[data-node-id="leaf-13"]')).toHaveCount(0);
  await expect(viewer.locator('.structure-node[data-node-id="new-neighbor"]')).toBeVisible();
  const retained = await viewer
    .locator('.structure-node[data-node-id="hub"]')
    .evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    }));
  expect(retained).toEqual(dragged);
  const newPosition = await viewer
    .locator('.structure-node[data-node-id="new-neighbor"]')
    .evaluate((element) => ({
      left: Number.parseFloat((element as HTMLElement).style.left),
      top: Number.parseFloat((element as HTMLElement).style.top),
    }));
  expect(Number.isFinite(newPosition.left)).toBe(true);
  expect(Number.isFinite(newPosition.top)).toBe(true);

  await openStructure(page, secondaryTitle);
  await expect(page.getByRole("tab", { name: secondaryTitle })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const secondaryViewer = page.locator(`[data-structure-id="${secondaryStructureId}"]`);
  await expect(secondaryViewer.locator(".structure-node.focused")).toHaveCount(0);
  await expect(secondaryViewer.getByRole("button", { name: "All", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.setViewportSize({ width: 900, height: 700 });
  const [toolbarBox, canvasBox] = await Promise.all([
    secondaryViewer.locator(".structure-toolbar").boundingBox(),
    secondaryViewer.locator(".structure-canvas-shell").boundingBox(),
  ]);
  expect(toolbarBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(
    canvasBox!.x + canvasBox!.width + 1,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator(`[data-structure-id="${secondaryStructureId}"]`)
    .getByRole("button", {
      name: "削除",
    })
    .click();
  await expect(page.getByRole("tab", { name: secondaryTitle })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Structure 1", exact: true })).toBeVisible();
});
