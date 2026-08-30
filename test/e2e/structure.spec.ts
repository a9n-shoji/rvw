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
  test.setTimeout(45_000);
  await page.goto(`/?pullRequestId=${pullRequestId}`);

  const structureFolder = page.getByRole("button", { name: "Structure 2", exact: true });
  await expect(structureFolder).toHaveAttribute("aria-expanded", "false");
  await structureFolder.click();
  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  await expect(reviewTree.locator(".review-tree-structure")).toHaveCount(2);
  await expect(reviewTree.getByRole("button", { name: primaryTitle })).toHaveAttribute(
    "title",
    `${primaryTitle}\nThe fixture boundary and its direct committed relationships; transport startup is excluded.\nbbbbbbbb`,
  );
  await reviewTree.getByRole("button", { name: primaryTitle }).click();

  await expect(page.getByRole("tab", { name: primaryTitle })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const viewer = page.locator(`[data-structure-id="${primaryStructureId}"]`);
  await expect(viewer.getByRole("heading", { name: primaryTitle })).toBeVisible();
  await expect(viewer.getByText("14/15 Node · 13/14 Relation", { exact: true })).toBeVisible();
  await expect(viewer.locator('.structure-node[data-node-id="hub"]')).toHaveClass(/focused/);
  await expect(viewer.locator('.structure-node[data-node-id="hub"]')).toHaveAttribute(
    "data-source-change-kind",
    "modified",
  );
  await expect(viewer.locator(".structure-edge")).toHaveCount(13);
  await expect(viewer.locator(".structure-minimap")).toBeVisible();
  await expect(viewer.locator(".structure-details")).toHaveCount(0);

  const canvas = viewer.locator(".structure-canvas");
  await expect
    .poll(async () => {
      const [canvasBox, hubBox] = await Promise.all([
        canvas.boundingBox(),
        viewer.locator('.structure-node[data-node-id="hub"]').boundingBox(),
      ]);
      if (!canvasBox || !hubBox) return Number.POSITIVE_INFINITY;
      return Math.max(
        Math.abs(hubBox.x + hubBox.width / 2 - (canvasBox.x + canvasBox.width / 2)),
        Math.abs(hubBox.y + hubBox.height / 2 - (canvasBox.y + canvasBox.height / 2)),
      );
    })
    .toBeLessThan(3);

  await openStructure(page, secondaryTitle);
  const secondaryViewer = page.locator(`[data-structure-id="${secondaryStructureId}"]`);
  await expect(secondaryViewer.locator(".structure-node")).toHaveCount(2);
  await expect(secondaryViewer.locator(".structure-edge")).toHaveCount(1);
  await openStructure(page, primaryTitle);
  await expect(viewer.locator('.structure-node[data-node-id="hub"]')).toHaveClass(/focused/);
  await expect(viewer.locator(".structure-node")).toHaveCount(14);
  await expect(viewer.locator(".structure-edge")).toHaveCount(13);

  await page.setViewportSize({ width: 900, height: 700 });
  await expect
    .poll(async () => {
      const [canvasBox, focusedBox] = await Promise.all([
        canvas.boundingBox(),
        viewer.locator(".structure-node.focused").boundingBox(),
      ]);
      if (!canvasBox || !focusedBox) return Number.POSITIVE_INFINITY;
      return Math.max(
        Math.abs(focusedBox.x + focusedBox.width / 2 - (canvasBox.x + canvasBox.width / 2)),
        Math.abs(focusedBox.y + focusedBox.height / 2 - (canvasBox.y + canvasBox.height / 2)),
      );
    })
    .toBeLessThan(3);
  await page.setViewportSize({ width: 1280, height: 720 });

  const hubTitle = viewer.locator('.structure-node[data-node-id="hub"] .structure-node-title');
  const hubIdentity = hubTitle.locator(".structure-source-identity");
  const hubTitleText = hubTitle.locator(".structure-node-title-text");
  const hubSourceAction = viewer.locator(
    '.structure-node[data-node-id="hub"] > .structure-source.compact',
  );
  await expect(hubIdentity).toHaveAttribute("data-source-path", "src/fixture.ts");
  await expect(hubIdentity.locator(".structure-source-name")).toHaveText("fixture.ts");
  const [identityBox, titleTextBox, sourceActionBox] = await Promise.all([
    hubIdentity.boundingBox(),
    hubTitleText.boundingBox(),
    hubSourceAction.boundingBox(),
  ]);
  expect(identityBox).not.toBeNull();
  expect(titleTextBox).not.toBeNull();
  expect(sourceActionBox).not.toBeNull();
  expect(identityBox!.x).toBeLessThan(titleTextBox!.x);
  expect(sourceActionBox!.x).toBeGreaterThan(titleTextBox!.x);

  const firstEdge = viewer.locator('.structure-edge[data-edge-id="edge-01"]');
  await expect(firstEdge).toHaveAttribute("d", / C /);
  await expect(firstEdge).toHaveAttribute("marker-end", /structure-left-.+-arrow/);
  const endpointsAreOutsideNodes = await firstEdge.evaluate((element) => {
    const path = element as SVGPathElement;
    const viewerElement = path.closest(".structure-viewer")!;
    const leaf = viewerElement.querySelector<HTMLElement>('[data-node-id="leaf-01"]')!;
    const hub = viewerElement.querySelector<HTMLElement>('[data-node-id="hub"]')!;
    const pointOutside = (x: number, y: number, node: HTMLElement): boolean => {
      const left = Number.parseFloat(node.style.left);
      const top = Number.parseFloat(node.style.top);
      return x < left || x > left + 228 || y < top || y > top + 112;
    };
    return (
      pointOutside(Number(path.dataset.startX), Number(path.dataset.startY), leaf) &&
      pointOutside(Number(path.dataset.endX), Number(path.dataset.endY), hub)
    );
  });
  expect(endpointsAreOutsideNodes).toBe(true);

  const firstEdgeLabel = viewer.locator('.structure-edge-label[data-edge-id="edge-01"]');
  await expect(firstEdgeLabel).toHaveAttribute("data-source-anchor-count", "2");
  await expect(firstEdgeLabel).toHaveAttribute("data-source-change-kind", "modified");
  await expect(firstEdgeLabel.locator(".structure-source-identity")).toHaveAttribute(
    "data-source-path",
    "README.md",
  );
  await expect(firstEdgeLabel.locator(".structure-source-name")).toHaveText("README.md");
  await expect(firstEdgeLabel.locator(".structure-source-count")).toHaveText("+1");
  await expect(firstEdgeLabel.locator(".structure-source.compact")).toHaveAttribute(
    "aria-label",
    "README.md:13-19を開く（ほか1件は詳細サイドバー）",
  );
  const [edgeIdentityBox, edgeTextBox] = await Promise.all([
    firstEdgeLabel.locator(".structure-source-identity").boundingBox(),
    firstEdgeLabel.locator(".structure-edge-label-text").boundingBox(),
  ]);
  expect(edgeIdentityBox).not.toBeNull();
  expect(edgeTextBox).not.toBeNull();
  expect(edgeTextBox!.x - (edgeIdentityBox!.x + edgeIdentityBox!.width)).toBeLessThanOrEqual(4);

  const graphCollisions = await viewer.evaluate((element) => {
    const boxes = (selector: string) =>
      [...element.querySelectorAll<HTMLElement>(selector)].map((item) => ({
        id: item.dataset.edgeId ?? item.dataset.nodeId,
        rect: item.getBoundingClientRect(),
      }));
    const labels = boxes(".structure-edge-label");
    const nodes = boxes(".structure-node");
    const overlaps = (left: { rect: DOMRect }, right: { rect: DOMRect }): boolean =>
      !(
        left.rect.right < right.rect.left ||
        left.rect.left > right.rect.right ||
        left.rect.bottom < right.rect.top ||
        left.rect.top > right.rect.bottom
      );
    return {
      labelNodes: labels.flatMap((label) =>
        nodes.filter((node) => overlaps(label, node)).map((node) => `${label.id}:${node.id}`),
      ),
      labelPairs: labels.flatMap((label, index) =>
        labels
          .slice(index + 1)
          .filter((other) => overlaps(label, other))
          .map((other) => `${label.id}:${other.id}`),
      ),
      allEdgesAreCurved: [...element.querySelectorAll<SVGPathElement>(".structure-edge")].every(
        (path) => path.getAttribute("d")?.includes(" C "),
      ),
    };
  });
  expect(graphCollisions).toEqual({
    labelNodes: [],
    labelPairs: [],
    allEdgesAreCurved: true,
  });

  await viewer.getByRole("button", { name: "詳細サイドバーを表示" }).click();
  await expect(viewer.locator(".structure-relation-list > li")).toHaveCount(13);

  await viewer
    .locator(".structure-relation-list > li > button")
    .filter({ hasText: "HTTP requestをuse caseへ変換する" })
    .click();
  await expect(viewer.locator('.structure-node[data-node-id="leaf-01"]')).toHaveClass(/focused/);
  await expect(viewer.getByRole("heading", { name: "HTTP route adapter" })).toBeVisible();
  await viewer
    .locator(".structure-focus-trail button")
    .filter({ hasText: "UpdateStructureUseCase.execute" })
    .click();
  await expect(viewer.locator('.structure-node[data-node-id="hub"]')).toHaveClass(/focused/);

  await viewer.getByRole("button", { name: "2-hop", exact: true }).click();
  await expect(viewer.getByText("15/15 Node · 14/14 Relation", { exact: true })).toBeVisible();
  await expect(viewer.locator('.structure-node[data-node-id="deep-node"]')).toBeVisible();
  await viewer.getByRole("button", { name: "全体", exact: true }).click();
  await expect(viewer.getByText("15/15 Node · 14/14 Relation", { exact: true })).toBeVisible();
  await viewer.getByRole("button", { name: "1-hop", exact: true }).click();

  const world = viewer.locator(".structure-world");
  const transformBeforeZoom = await world.evaluate((element) => element.style.transform);
  await viewer.getByRole("button", { name: "拡大" }).click();
  await expect
    .poll(async () => await world.evaluate((element) => element.style.transform))
    .not.toBe(transformBeforeZoom);

  const canvasForWheel = await canvas.boundingBox();
  expect(canvasForWheel).not.toBeNull();
  await page.mouse.move(
    canvasForWheel!.x + canvasForWheel!.width / 2,
    canvasForWheel!.y + canvasForWheel!.height / 2,
  );
  const transformBeforePan = await world.evaluate((element) => element.style.transform);
  const scaleBeforePan = await viewer.getAttribute("data-viewport-scale");
  await page.mouse.wheel(35, 55);
  await expect
    .poll(async () => await world.evaluate((element) => element.style.transform))
    .not.toBe(transformBeforePan);
  await expect(viewer).toHaveAttribute("data-viewport-scale", scaleBeforePan!);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect(viewer).not.toHaveAttribute("data-viewport-scale", scaleBeforePan!);

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
  let dragged = await hub.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  }));
  expect(dragged).not.toEqual(beforeDrag);
  await viewer.getByRole("button", { name: "レイアウトを戻す" }).click();
  await expect
    .poll(
      async () =>
        await hub.evaluate((element) => ({
          left: (element as HTMLElement).style.left,
          top: (element as HTMLElement).style.top,
        })),
    )
    .toEqual(beforeDrag);
  const resetHubBox = await hub.boundingBox();
  expect(resetHubBox).not.toBeNull();
  await page.mouse.move(resetHubBox!.x + 30, resetHubBox!.y + 30);
  await page.mouse.down();
  await page.mouse.move(resetHubBox!.x + 110, resetHubBox!.y + 90, { steps: 6 });
  await page.mouse.up();
  dragged = await hub.evaluate((element) => ({
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
  await expect
    .poll(async () => {
      const [viewerBox, toolbarBox, canvasBox, detailsBox, focusedBox] = await Promise.all([
        viewer.boundingBox(),
        viewer.locator(".structure-toolbar").boundingBox(),
        viewer.locator(".structure-canvas").boundingBox(),
        viewer.locator(".structure-details").boundingBox(),
        viewer.locator(".structure-node.focused").boundingBox(),
      ]);
      if (!viewerBox || !toolbarBox || !canvasBox || !detailsBox || !focusedBox) return false;
      const toolbarFits = await viewer
        .locator(".structure-toolbar")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
      return (
        toolbarFits &&
        toolbarBox.x + toolbarBox.width <= viewerBox.x + viewerBox.width + 1 &&
        detailsBox.y + detailsBox.height <= viewerBox.y + viewerBox.height + 1 &&
        focusedBox.x >= canvasBox.x - 1 &&
        focusedBox.x + focusedBox.width <= canvasBox.x + canvasBox.width + 1 &&
        focusedBox.y >= canvasBox.y - 1 &&
        focusedBox.y + focusedBox.height <= canvasBox.y + canvasBox.height + 1
      );
    })
    .toBe(true);

  await reviewTree.getByRole("button", { name: primaryTitle }).click({ modifiers: ["Meta"] });
  const leftViewer = page
    .locator('.document-pane[data-pane="left"]')
    .locator(`[data-structure-id="${primaryStructureId}"]`);
  const rightViewer = page
    .locator('.document-pane[data-pane="right"]')
    .locator(`[data-structure-id="${primaryStructureId}"]`);
  await expect(rightViewer).toBeVisible();
  await rightViewer.getByRole("button", { name: "全体", exact: true }).click();
  await expect(rightViewer.getByText("15/15 Node · 14/14 Relation", { exact: true })).toBeVisible();
  await expect(leftViewer.getByText("14/15 Node · 13/14 Relation", { exact: true })).toBeVisible();
  expect(
    await page
      .locator(".structure-edges marker")
      .evaluateAll((markers) => markers.map((marker) => marker.id)),
  ).toEqual([
    `structure-left-${primaryStructureId}-arrow`,
    `structure-right-${primaryStructureId}-arrow`,
  ]);

  const update = await page.request.post(`/api/fixture/structures/${primaryStructureId}/update`, {
    data: {},
  });
  expect(update.ok()).toBe(true);
  const updatedTitle = "Fixture code relationships updated";
  await expect(leftViewer.locator('.structure-node[data-node-id="hub"]')).toContainText(
    "UpdateStructureUseCase.execute updated",
  );
  await expect(rightViewer.locator('.structure-node[data-node-id="hub"]')).toContainText(
    "UpdateStructureUseCase.execute updated",
  );
  await expect(leftViewer.locator('.structure-node[data-node-id="leaf-13"]')).toHaveCount(0);
  await expect(rightViewer.locator('.structure-node[data-node-id="leaf-13"]')).toHaveCount(0);
  await expect(leftViewer.locator('.structure-node[data-node-id="new-neighbor"]')).toBeVisible();
  await expect(rightViewer.locator('.structure-node[data-node-id="new-neighbor"]')).toBeVisible();
  const retained = await leftViewer
    .locator('.structure-node[data-node-id="hub"]')
    .evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    }));
  expect(retained).toEqual(dragged);
  const newPosition = await leftViewer
    .locator('.structure-node[data-node-id="new-neighbor"]')
    .evaluate((element) => ({
      left: Number.parseFloat((element as HTMLElement).style.left),
      top: Number.parseFloat((element as HTMLElement).style.top),
    }));
  expect(Number.isFinite(newPosition.left)).toBe(true);
  expect(Number.isFinite(newPosition.top)).toBe(true);
  await page
    .locator('.document-pane[data-pane="right"]')
    .getByRole("button", { name: `${updatedTitle}を閉じる` })
    .click();
  await expect(rightViewer).toHaveCount(0);

  const clearFocus = await page.request.post(
    `/api/fixture/structures/${primaryStructureId}/update`,
    { data: { clearFocus: true } },
  );
  expect(clearFocus.ok()).toBe(true);
  await expect(
    page.getByRole("tab", { name: "Fixture code relationships without focus" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(viewer.locator(".structure-node.focused")).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "全体", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(viewer.getByRole("button", { name: "1-hop", exact: true })).toBeDisabled();
  await expect(viewer.getByRole("button", { name: "2-hop", exact: true })).toBeDisabled();
  await expect(viewer.getByText("14/14 Node · 1/1 Relation", { exact: true })).toBeVisible();

  await openStructure(page, secondaryTitle);
  await expect(page.getByRole("tab", { name: secondaryTitle })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(secondaryViewer.locator(".structure-node.focused")).toHaveCount(0);
  await expect(secondaryViewer.getByRole("button", { name: "全体", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(secondaryViewer.getByRole("button", { name: "1-hop", exact: true })).toBeDisabled();
  await expect(secondaryViewer.locator(".structure-edge-label")).toHaveCount(1);
  await page.setViewportSize({ width: 900, height: 700 });
  await secondaryViewer.getByRole("button", { name: "詳細サイドバーを表示" }).click();
  const [toolbarBox, canvasBox, detailsBox, viewerBox] = await Promise.all([
    secondaryViewer.locator(".structure-toolbar").boundingBox(),
    secondaryViewer.locator(".structure-canvas-shell").boundingBox(),
    secondaryViewer.locator(".structure-details").boundingBox(),
    secondaryViewer.boundingBox(),
  ]);
  expect(toolbarBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(detailsBox).not.toBeNull();
  expect(viewerBox).not.toBeNull();
  expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(
    viewerBox!.x + viewerBox!.width + 1,
  );
  expect(
    await secondaryViewer
      .locator(".structure-toolbar")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  expect(detailsBox!.y).toBeGreaterThanOrEqual(canvasBox!.y + canvasBox!.height - 1);
  expect(detailsBox!.y + detailsBox!.height).toBeLessThanOrEqual(
    viewerBox!.y + viewerBox!.height + 1,
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
