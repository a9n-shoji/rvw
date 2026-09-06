import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { contractSemanticAnchors } from "../fixtures/contract/contract-structures.mjs";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const primaryStructureId = "80000000-0000-4000-8000-000000000001";
const secondaryStructureId = "80000000-0000-4000-8000-000000000002";
const fullStackStructureId = "80000000-0000-4000-8000-000000000003";
const reciprocalStructureId = "80000000-0000-4000-8000-000000000004";
const topologyOnlyStructureId = "80000000-0000-4000-8000-000000000005";
const primaryTitle = "Order placement behavior";
const secondaryTitle = "Payment reconciliation recovery";
const fullStackTitle = "Order detail response rendering";
const topologyOnlyTitle = "Outbox persistence topology (unguided)";

test("serves every semantic Structure anchor from the validated contract source provider", async ({
  request,
}) => {
  for (const sourceAnchor of contractSemanticAnchors) {
    const response = await request.get(
      `/api/pull-requests/${pullRequestId}/document?kind=repository-file&sourceOid=${"c".repeat(40)}&path=${encodeURIComponent(sourceAnchor.path)}`,
    );
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as {
      document: { availability: string; text: string | null };
    };
    expect(body.document.availability).toBe("available");
    const selected = body.document.text
      ?.split("\n")
      .slice(sourceAnchor.startLine - 1, sourceAnchor.endLine)
      .join("\n");
    expect(selected).toContain(sourceAnchor.needle);
  }
});

async function openStructure(page: Page, title: string): Promise<void> {
  const folder = page.getByRole("button", { name: /^Structure \d+$/ });
  if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
  await page
    .getByRole("navigation", { name: "レビュー文書" })
    .getByRole("button", { name: title, exact: true })
    .click();
}

interface StructureReadingState {
  focusedNodeId: string | null;
  depth: string | null;
  hubPosition: { left: string; top: string };
  viewportScale: string | null;
}

async function structureReadingState(viewer: Locator): Promise<StructureReadingState> {
  return {
    focusedNodeId: await viewer.locator(".structure-node.focused").getAttribute("data-node-id"),
    depth: await viewer
      .getByRole("group", { name: "近傍の深さ" })
      .locator('button[aria-pressed="true"]')
      .textContent(),
    hubPosition: await viewer
      .locator('.structure-node[data-node-id="hub"]')
      .evaluate((element) => ({
        left: (element as HTMLElement).style.left,
        top: (element as HTMLElement).style.top,
      })),
    viewportScale: await viewer.getAttribute("data-viewport-scale"),
  };
}

async function structureGraphLensState(viewer: Locator) {
  return {
    focusedNodeId: await viewer.locator(".structure-node.focused").getAttribute("data-node-id"),
    depth: await viewer
      .getByRole("group", { name: "近傍の深さ" })
      .locator('button[aria-pressed="true"]')
      .textContent(),
    worldTransform: await viewer.locator(".structure-world").getAttribute("style"),
    viewportScale: await viewer.getAttribute("data-viewport-scale"),
  };
}

async function structureRegionsCameraState(viewer: Locator) {
  return {
    transform: await viewer.locator(".structure-region-map").getAttribute("style"),
    scale: await viewer.getAttribute("data-regions-viewport-scale"),
    mode: await viewer.getAttribute("data-regions-camera-mode"),
  };
}

async function expectRegionsMapFullyVisible(viewer: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const [surfaceBox, mapBox] = await Promise.all([
        viewer.locator(".structure-regions-canvas-scroll").boundingBox(),
        viewer.locator(".structure-region-map").boundingBox(),
      ]);
      if (!surfaceBox || !mapBox) return false;
      return (
        mapBox.x >= surfaceBox.x - 1 &&
        mapBox.x + mapBox.width <= surfaceBox.x + surfaceBox.width + 1 &&
        mapBox.y >= surfaceBox.y - 1 &&
        mapBox.y + mapBox.height <= surfaceBox.y + surfaceBox.height + 1
      );
    })
    .toBe(true);
}

async function expectFocusedNodeVisible(viewer: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const [canvasBox, focusedBox] = await Promise.all([
        viewer.locator(".structure-canvas").boundingBox(),
        viewer.locator(".structure-node.focused").boundingBox(),
      ]);
      if (!canvasBox || !focusedBox) return false;
      return (
        focusedBox.x + focusedBox.width > canvasBox.x &&
        focusedBox.x < canvasBox.x + canvasBox.width &&
        focusedBox.y + focusedBox.height > canvasBox.y &&
        focusedBox.y < canvasBox.y + canvasBox.height
      );
    })
    .toBe(true);
}

async function expectStructureNodesFullyVisible(
  viewer: Locator,
  nodeIds: readonly string[],
): Promise<void> {
  await expect
    .poll(async () =>
      viewer.evaluate((element, expectedNodeIds) => {
        const canvas = element.querySelector<HTMLElement>(".structure-canvas");
        if (!canvas) return ["missing canvas"];
        const canvasBox = canvas.getBoundingClientRect();
        return expectedNodeIds.flatMap((nodeId) => {
          const node = element.querySelector<HTMLElement>(
            `.structure-node[data-node-id="${nodeId}"]`,
          );
          if (!node) return [`${nodeId}: missing`];
          const box = node.getBoundingClientRect();
          return [
            box.left >= canvasBox.left - 1 &&
            box.right <= canvasBox.right + 1 &&
            box.top >= canvasBox.top - 1 &&
            box.bottom <= canvasBox.bottom + 1
              ? []
              : [
                  `${nodeId}: node=${box.left.toFixed(1)},${box.top.toFixed(1)},${box.right.toFixed(1)},${box.bottom.toFixed(1)} canvas=${canvasBox.left.toFixed(1)},${canvasBox.top.toFixed(1)},${canvasBox.right.toFixed(1)},${canvasBox.bottom.toFixed(1)}`,
                ],
          ].flat();
        });
      }, nodeIds),
    )
    .toEqual([]);
}

async function dragVisibleStructureNode(page: Page, viewer: Locator, node: Locator): Promise<void> {
  // Framing actions animate the world transform. Starting a pointer gesture while that
  // transition is still moving the target can make the initial coordinates land on the
  // canvas instead of the Node, turning the intended drag into a pan.
  await expect(viewer.locator(".structure-world")).not.toHaveClass(/camera-transition/u);
  const [canvasBox, nodeBox] = await Promise.all([
    viewer.locator(".structure-canvas").boundingBox(),
    node.boundingBox(),
  ]);
  expect(canvasBox).not.toBeNull();
  expect(nodeBox).not.toBeNull();
  const visible = {
    left: Math.max(canvasBox!.x, nodeBox!.x),
    top: Math.max(canvasBox!.y, nodeBox!.y),
    right: Math.min(canvasBox!.x + canvasBox!.width, nodeBox!.x + nodeBox!.width),
    bottom: Math.min(canvasBox!.y + canvasBox!.height, nodeBox!.y + nodeBox!.height),
  };
  expect(visible.right - visible.left).toBeGreaterThan(12);
  expect(visible.bottom - visible.top).toBeGreaterThan(12);
  const startX = (visible.left + visible.right) / 2;
  const startY = (visible.top + visible.bottom) / 2;
  const endX = startX + 75 < canvasBox!.x + canvasBox!.width - 12 ? startX + 75 : startX - 75;
  const endY = startY + 52 < canvasBox!.y + canvasBox!.height - 12 ? startY + 52 : startY - 52;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 6 });
  await page.mouse.up();
}

async function customizeStructureReading(
  page: Page,
  viewer: Locator,
): Promise<StructureReadingState> {
  const hub = viewer.locator('.structure-node[data-node-id="hub"]');
  await viewer.getByRole("button", { name: "表示中を収める" }).click();
  await hub.click();
  await viewer.getByRole("button", { name: "focusを中央へ", exact: true }).click();
  const beforeDrag = await hub.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  }));
  await dragVisibleStructureNode(page, viewer, hub);
  await expect
    .poll(
      async () =>
        await hub.evaluate((element) => ({
          left: (element as HTMLElement).style.left,
          top: (element as HTMLElement).style.top,
        })),
    )
    .not.toEqual(beforeDrag);

  await viewer.locator('.structure-node[data-node-id="order-aggregate"]').click();
  await expect(viewer.locator('.structure-node[data-node-id="order-aggregate"]')).toHaveClass(
    /focused/,
  );
  await viewer.getByRole("button", { name: "2-hop", exact: true }).click();
  await viewer.getByRole("button", { name: "focusを中央へ", exact: true }).click();
  await viewer.getByRole("button", { name: "拡大" }).click();
  const canvas = viewer.locator(".structure-canvas");
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  const transformBeforePan = await viewer
    .locator(".structure-world")
    .evaluate((element) => (element as HTMLElement).style.transform);
  await page.mouse.move(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + canvasBox!.height / 2);
  await page.mouse.wheel(42, 58);
  await expect
    .poll(
      async () =>
        await viewer
          .locator(".structure-world")
          .evaluate((element) => (element as HTMLElement).style.transform),
    )
    .not.toBe(transformBeforePan);
  return await structureReadingState(viewer);
}

test("preserves Structure reading state when its tab is dragged to the other pane", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, primaryTitle);
  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  await reviewTree
    .getByRole("button", { name: "Pull Request.md", exact: true })
    .click({ modifiers: ["Meta"] });

  const leftPane = page.locator('.document-pane[data-pane="left"]');
  const rightPane = page.locator('.document-pane[data-pane="right"]');
  const leftViewer = leftPane.locator(`[data-structure-id="${primaryStructureId}"]`);
  const expectedState = await customizeStructureReading(page, leftViewer);

  await leftPane
    .getByRole("tab", { name: primaryTitle })
    .dragTo(page.locator('.document-tabs-shell[data-pane="right"]'));

  const rightViewer = rightPane.locator(`[data-structure-id="${primaryStructureId}"]`);
  await expect(rightViewer).toBeVisible();
  await expect(leftViewer).toHaveCount(0);
  await expect.poll(async () => await structureReadingState(rightViewer)).toEqual(expectedState);
  await expectFocusedNodeVisible(rightViewer);
});

test("preserves Structure reading state when closing the last left tab normalizes panes", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const structureFolder = page.getByRole("button", { name: "Structure 5", exact: true });
  await structureFolder.click();
  await page
    .getByRole("navigation", { name: "レビュー文書" })
    .getByRole("button", { name: primaryTitle, exact: true })
    .click({ modifiers: ["Meta"] });

  const rightPane = page.locator('.document-pane[data-pane="right"]');
  const rightViewer = rightPane.locator(`[data-structure-id="${primaryStructureId}"]`);
  const expectedState = await customizeStructureReading(page, rightViewer);

  await page
    .locator('.document-pane[data-pane="left"]')
    .getByRole("button", { name: "Pull Request.mdを閉じる", exact: true })
    .click();

  const leftViewer = page
    .locator('.document-pane[data-pane="left"]')
    .locator(`[data-structure-id="${primaryStructureId}"]`);
  await expect(page.locator('.document-pane[data-pane="right"]')).toHaveCount(0);
  await expect(leftViewer).toBeVisible();
  await expect.poll(async () => await structureReadingState(leftViewer)).toEqual(expectedState);
  await expectFocusedNodeVisible(leftViewer);
});

test("keeps the surviving pane session when closing a duplicate Structure tab", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, primaryTitle);
  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  await reviewTree
    .getByRole("button", { name: primaryTitle, exact: true })
    .click({ modifiers: ["Meta"] });

  const leftPane = page.locator('.document-pane[data-pane="left"]');
  const rightPane = page.locator('.document-pane[data-pane="right"]');
  const leftViewer = leftPane.locator(`[data-structure-id="${primaryStructureId}"]`);
  const rightViewer = rightPane.locator(`[data-structure-id="${primaryStructureId}"]`);
  const initialRightScale = Number(await rightViewer.getAttribute("data-viewport-scale"));
  await rightViewer.getByRole("button", { name: "縮小", exact: true }).click();
  const expectedRightState = await structureReadingState(rightViewer);
  expect(expectedRightState.focusedNodeId).toBe("hub");
  expect(expectedRightState.depth).toBe("全体");
  expect(Number(expectedRightState.viewportScale)).toBeLessThan(initialRightScale);
  expect(Number(expectedRightState.viewportScale)).toBeGreaterThanOrEqual(0.03);

  await customizeStructureReading(page, leftViewer);
  await leftPane.getByRole("button", { name: `${primaryTitle}を閉じる`, exact: true }).click();
  await expect(leftViewer).toHaveCount(0);
  await expect(rightViewer).toBeVisible();

  await reviewTree
    .getByRole("button", { name: secondaryTitle, exact: true })
    .click({ modifiers: ["Meta"] });
  await expect(rightPane.getByRole("tab", { name: secondaryTitle })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await rightPane.getByRole("tab", { name: primaryTitle }).click();

  const remountedRightViewer = rightPane.locator(`[data-structure-id="${primaryStructureId}"]`);
  await expect(remountedRightViewer).toBeVisible();
  await expect
    .poll(async () => await structureReadingState(remountedRightViewer))
    .toEqual(expectedRightState);
  await expectFocusedNodeVisible(remountedRightViewer);
});

test("maps a backend response contract into frontend React rendering", async ({ page }) => {
  const listResponse = await page.request.get(`/api/pull-requests/${pullRequestId}/structures`);
  expect(listResponse.ok()).toBe(true);
  await expect(listResponse.json()).resolves.toMatchObject({
    structures: [
      { ref: `rvw://structure/${primaryStructureId}` },
      { ref: `rvw://structure/${secondaryStructureId}` },
      { ref: `rvw://structure/${fullStackStructureId}` },
      { ref: `rvw://structure/${reciprocalStructureId}` },
      { ref: `rvw://structure/${topologyOnlyStructureId}` },
    ],
  });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, fullStackTitle);
  const viewer = page.locator(`[data-structure-id="${fullStackStructureId}"]`);
  await expect(viewer.getByRole("heading", { name: fullStackTitle })).toBeVisible();
  await expect(viewer).toHaveAttribute("data-has-presentation", "true");
  await expect(
    viewer.getByText(
      "注文詳細はbackendのread modelから共有response契約を越え、frontendのquery stateとして画面へ届く。",
      { exact: true },
    ),
  ).toBeVisible();
  const thesisStrip = viewer.getByRole("note", { name: "Structure thesis" });
  await expect(thesisStrip).toBeVisible();
  await expect(viewer.locator(".structure-canvas-status .structure-canvas-thesis")).toHaveCount(0);
  const defaultThesisLayout = await viewer.evaluate((element) => {
    const overview = element.querySelector<HTMLElement>(".structure-presentation-overview")!;
    const thesis = element.querySelector<HTMLElement>(
      ".structure-presentation-overview-thesis > span",
    )!;
    const canvas = element.querySelector<HTMLElement>(".structure-canvas")!;
    const status = element.querySelector<HTMLElement>(".structure-canvas-status")!;
    const overviewBox = overview.getBoundingClientRect();
    const canvasBox = canvas.getBoundingClientRect();
    return {
      outsideCanvas: overviewBox.bottom <= canvasBox.top + 1,
      statusHeight: status.getBoundingClientRect().height,
      whiteSpace: getComputedStyle(thesis).whiteSpace,
      textOverflow: getComputedStyle(thesis).textOverflow,
    };
  });
  expect(defaultThesisLayout).toMatchObject({
    outsideCanvas: true,
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  });
  expect(defaultThesisLayout.statusHeight).toBeLessThan(60);
  await expect(viewer.getByText("17/17 Node · 19/19 Relation", { exact: true })).toBeVisible();
  await expect(viewer.locator('.structure-node[data-node-id="order-detail-route"]')).toHaveClass(
    /focused/,
  );
  const thesisToggle = viewer.getByRole("button", { name: /Thesis/u });
  const graphMode = viewer.getByRole("button", { name: "Graph", exact: true });
  const regionsMode = viewer.getByRole("button", { name: "Regions", exact: true });
  await expect(thesisToggle).toHaveAttribute("aria-expanded", "true");
  await expect(viewer.getByRole("button", { name: /Core relations/u })).toHaveCount(0);
  await expect(viewer.getByText("Explanation backbone", { exact: true })).toHaveCount(0);
  await expect(
    viewer.locator(".structure-presentation-overview .structure-region-map"),
  ).toHaveCount(0);
  await expect(viewer.locator(".structure-presentation-overview-regions")).toHaveCount(0);
  await expect(graphMode).toHaveAttribute("aria-pressed", "true");
  await expect(regionsMode).toHaveAttribute("aria-pressed", "false");
  await regionsMode.click();
  await expect(viewer).toHaveAttribute("data-view-mode", "regions");
  await expect(viewer.locator(".structure-regions-canvas")).toBeVisible();
  await expect(viewer.locator(".structure-canvas")).toBeHidden();
  await expect(viewer.locator(".structure-minimap")).toBeHidden();
  await expect(viewer.getByRole("group", { name: "近傍の深さ" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "表示中を収める" })).toHaveCount(0);
  await expect(viewer.locator(".structure-region-map-card")).toHaveCount(4);
  await expect(
    viewer.locator('.structure-region-map-card[data-region-id="frontend-rendering"]'),
  ).toContainText("typed query stateをcacheし");
  await expect(viewer.locator(".structure-region-map-relation:not(.context-boundary)")).toHaveCount(
    3,
  );
  await expect(
    viewer.locator('.structure-region-map-relation[data-edge-ids~="detail-route-executes-query"]'),
  ).toHaveAttribute("data-direction", "second-to-first");
  await expect(viewer.getByText("4 Regions · 17/17 Nodes assigned", { exact: true })).toBeVisible();
  const [regionsCanvasBox, canvasShellBox] = await Promise.all([
    viewer.locator(".structure-regions-canvas").boundingBox(),
    viewer.locator(".structure-canvas-shell").boundingBox(),
  ]);
  expect(regionsCanvasBox).not.toBeNull();
  expect(canvasShellBox).not.toBeNull();
  expect(regionsCanvasBox!.height).toBeCloseTo(canvasShellBox!.height, 0);
  expect(Math.abs(regionsCanvasBox!.width - canvasShellBox!.width)).toBeLessThanOrEqual(1);

  await graphMode.click();
  await expect(viewer).toHaveAttribute("data-view-mode", "graph");
  await expect(viewer.locator(".structure-region")).toHaveCount(0);
  await expect(
    viewer.locator(
      '.structure-node[data-region-id="http-boundary"][data-node-id="order-detail-route"]',
    ),
  ).toHaveAttribute("data-region-label", "HTTP boundary");
  await expect(viewer.locator(".structure-region-member")).toHaveCount(0);
  await expect(viewer.locator(".structure-minimap-primary-backbone")).toHaveCount(14);
  await expect(viewer.locator(".structure-minimap-presentation-start")).toHaveCount(1);
  await expect(viewer.locator(".structure-minimap circle.primary-backbone")).toHaveCount(12);
  await expect(viewer.locator('.structure-edge-label[data-primary-backbone="true"]')).toHaveCount(
    14,
  );
  await expect(
    viewer.locator('.structure-presentation-overview-node[data-node-id="order-detail-route"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await viewer.locator('.structure-node[data-node-id="order-detail-page"]').click();
  await expect(viewer.locator('.structure-node[data-node-id="order-detail-page"]')).toHaveClass(
    /focused/,
  );
  await viewer
    .locator('.structure-presentation-overview-node[data-node-id="order-detail-route"]')
    .click();
  await expect(viewer.locator('.structure-node[data-node-id="order-detail-route"]')).toHaveClass(
    /focused/,
  );
  await expect(viewer.locator('.structure-node[data-primary-backbone="true"]')).toHaveCount(12);
  await expect(viewer.locator('.structure-edge[data-primary-backbone="true"]')).toHaveCount(14);
  await expect(
    viewer.locator('.structure-node[data-node-id="order-detail-route"] .structure-node-focus'),
  ).toHaveAccessibleName(
    "GET /orders/:orderId · factual origin · authorial start · explanation backbone member · region: HTTP boundary",
  );
  await expect(
    viewer.locator(
      '.structure-edge-label[data-edge-id="detail-route-executes-query"] .structure-edge-select',
    ),
  ).toHaveAccessibleName(/explanation backbone relation$/u);
  await thesisToggle.click();
  await expect(viewer.locator(".structure-presentation-guide-section")).toHaveCount(0);
  expect(
    (await viewer.locator(".structure-presentation-overview").boundingBox())!.height,
  ).toBeLessThan(44);
  await thesisToggle.click();
  await expect(viewer.locator(".structure-claim-note")).toHaveCount(0);
  await expect(viewer.locator(".structure-details")).toHaveCount(0);

  await page.setViewportSize({ width: 760, height: 700 });
  expect(
    await thesisStrip.locator("span").evaluate((element) => ({
      whiteSpace: getComputedStyle(element).whiteSpace,
      lineClamp: getComputedStyle(element).webkitLineClamp,
    })),
  ).toEqual({ whiteSpace: "normal", lineClamp: "2" });
  expect(
    await viewer.evaluate((element) => {
      const overview = element.querySelector<HTMLElement>(".structure-presentation-overview")!;
      const canvas = element.querySelector<HTMLElement>(".structure-canvas")!;
      return overview.getBoundingClientRect().bottom <= canvas.getBoundingClientRect().top + 1;
    }),
  ).toBe(true);
  const canvasHeightBeforeScope = (await viewer.locator(".structure-canvas").boundingBox())!.height;
  const scopeToggle = viewer.locator(".structure-scope-details > summary");
  await scopeToggle.click();
  const scopePanel = viewer.locator(".structure-scope-details > p");
  await expect(scopePanel).toBeVisible();
  const [scopePanelBox, viewerBox] = await Promise.all([
    scopePanel.boundingBox(),
    viewer.boundingBox(),
  ]);
  expect(scopePanelBox).not.toBeNull();
  expect(viewerBox).not.toBeNull();
  expect(scopePanelBox!.x).toBeGreaterThanOrEqual(viewerBox!.x);
  expect(scopePanelBox!.x + scopePanelBox!.width).toBeLessThanOrEqual(
    viewerBox!.x + viewerBox!.width,
  );
  expect((await viewer.locator(".structure-canvas").boundingBox())!.height).toBeCloseTo(
    canvasHeightBeforeScope,
    0,
  );
  await scopeToggle.click();
  await page.setViewportSize({ width: 1280, height: 720 });

  const conceptNode = viewer.locator('.structure-node[data-node-id="order-not-found"]');
  const conceptSourceInsets = await conceptNode.evaluate((node) => {
    const source = node.querySelector<HTMLElement>(".structure-source.compact")!;
    const nodeBox = node.getBoundingClientRect();
    const sourceBox = source.getBoundingClientRect();
    const scale = Number(node.closest<HTMLElement>(".structure-viewer")!.dataset.viewportScale);
    return {
      right: (nodeBox.right - sourceBox.right) / scale,
      top: (sourceBox.top - nodeBox.top) / scale,
    };
  });
  expect(conceptSourceInsets.right).toBeGreaterThanOrEqual(21.5);
  expect(conceptSourceInsets.top).toBeGreaterThanOrEqual(11);

  const notationLayoutMetrics = await viewer.evaluate((element) => {
    const samples = {
      class: "get-order-query",
      interface: "detail-params",
      database: "orders-read-model",
      component: "detail-actor-auth",
      external: "order-detail-route",
      concept: "order-not-found",
    } as const;
    return Object.entries(samples).map(([notation, nodeId]) => {
      const node = element.querySelector<HTMLElement>(`.structure-node[data-node-id="${nodeId}"]`)!;
      const focus = node.querySelector<HTMLElement>(".structure-node-focus")!;
      const identity = node.querySelector<HTMLElement>(".structure-source-identity")!;
      const sourceName = identity.querySelector<HTMLElement>(".structure-source-name")!;
      const title = node.querySelector<HTMLElement>(".structure-node-title")!;
      const description = node.querySelector<HTMLElement>(".structure-node-description")!;
      const source = node.querySelector<HTMLElement>(":scope > .structure-source.compact")!;
      const identityBox = identity.getBoundingClientRect();
      const sourceNameBox = sourceName.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const descriptionBox = description.getBoundingClientRect();
      const sourceBox = source.getBoundingClientRect();
      const nodeBox = node.getBoundingClientRect();
      const world = node.closest<HTMLElement>(".structure-world")!;
      const scale = new DOMMatrixReadOnly(getComputedStyle(world).transform).a;
      return {
        notation,
        fileTitleGap: (titleBox.top - sourceNameBox.bottom) / scale,
        titleSourceClearance: (titleBox.top - sourceBox.bottom) / scale,
        identitySourceClearance: (sourceBox.left - identityBox.right) / scale,
        descriptionWidthRatio: descriptionBox.width / nodeBox.width,
        focusHorizontalOverflow: focus.scrollWidth - focus.clientWidth,
        titleHorizontalOverflow: title.scrollWidth - title.clientWidth,
        descriptionHorizontalOverflow: description.scrollWidth - description.clientWidth,
      };
    });
  });
  for (const metrics of notationLayoutMetrics) {
    expect(metrics.fileTitleGap, metrics.notation).toBeGreaterThanOrEqual(1.9);
    expect(metrics.fileTitleGap, metrics.notation).toBeLessThanOrEqual(2.5);
    expect(metrics.titleSourceClearance, metrics.notation).toBeGreaterThanOrEqual(0);
    expect(metrics.identitySourceClearance, metrics.notation).toBeGreaterThanOrEqual(0);
    expect(metrics.descriptionWidthRatio, metrics.notation).toBeGreaterThan(0.75);
    expect(metrics.focusHorizontalOverflow, metrics.notation).toBeLessThanOrEqual(0);
    expect(metrics.titleHorizontalOverflow, metrics.notation).toBeLessThanOrEqual(0);
    expect(metrics.descriptionHorizontalOverflow, metrics.notation).toBeLessThanOrEqual(0);
  }

  await viewer.getByRole("button", { name: "表示中を収める" }).click();
  const compactMap = await viewer.evaluate((element) => {
    const positions = [...element.querySelectorAll<HTMLElement>(".structure-node")].map((node) => ({
      id: node.dataset.nodeId!,
      x: Number.parseFloat(node.style.left),
      y: Number.parseFloat(node.style.top),
    }));
    const byId = new Map(positions.map((point) => [point.id, point]));
    const coreLandmarks = [
      "order-detail-route",
      "get-order-query",
      "order-detail-contract",
      "order-api-client",
      "order-detail-page",
    ].map((nodeId) => byId.get(nodeId)!);
    const width =
      Math.max(...positions.map(({ x }) => x + 228)) - Math.min(...positions.map(({ x }) => x));
    const height =
      Math.max(...positions.map(({ y }) => y + 112)) - Math.min(...positions.map(({ y }) => y));
    return {
      aspectRatio: width / height,
      distinctCoreLandmarks: new Set(coreLandmarks.map(({ x, y }) => `${x}:${y}`)).size,
      coreVerticalSpread:
        Math.max(...coreLandmarks.map(({ y }) => y)) - Math.min(...coreLandmarks.map(({ y }) => y)),
    };
  });
  expect(compactMap.aspectRatio).toBeLessThanOrEqual(2.6);
  expect(compactMap.distinctCoreLandmarks).toBe(5);
  expect(compactMap.coreVerticalSpread).toBeGreaterThan(300);

  await viewer.locator('.structure-node[data-node-id="order-detail-contract"]').click();
  const contractEdgeLabel = viewer.locator(
    '.structure-edge-label[data-edge-id="detail-response-enters-client"]',
  );
  const fullEdgeLabel = "応答契約の整合が確認できた場合に限りtyped payloadをクライアントへ渡す";
  const contractEdgeButton = contractEdgeLabel.locator(".structure-edge-select");
  const contractEdgeText = contractEdgeLabel.locator(".structure-edge-label-text");
  await expect(contractEdgeButton).toHaveAttribute("title", fullEdgeLabel);
  await expect(contractEdgeButton).toHaveAttribute("aria-label", new RegExp(fullEdgeLabel));
  await expect(contractEdgeText).toHaveText(fullEdgeLabel);
  await expect(contractEdgeText).not.toContainText("…");
  const wrappedLabel = await contractEdgeText.evaluate((element) => ({
    breakCount: element.querySelectorAll("br").length,
    lineClamp: getComputedStyle(element).webkitLineClamp,
    fullyVisible: element.scrollHeight <= element.clientHeight + 1,
  }));
  expect(wrappedLabel.breakCount).toBeGreaterThanOrEqual(2);
  expect(wrappedLabel.lineClamp).toBe("none");
  expect(wrappedLabel.fullyVisible).toBe(true);
  const [labelButtonBox, sourceActionBox] = await Promise.all([
    contractEdgeButton.boundingBox(),
    contractEdgeLabel.locator(".structure-edge-sources > summary").boundingBox(),
  ]);
  expect(labelButtonBox).not.toBeNull();
  expect(sourceActionBox).not.toBeNull();
  expect(sourceActionBox!.x).toBeGreaterThanOrEqual(labelButtonBox!.x + labelButtonBox!.width - 1);
  const labelTextContained = await contractEdgeLabel
    .locator(".structure-edge-select")
    .evaluate((button) => {
      const text = button.querySelector<HTMLElement>(".structure-edge-label-text")!;
      const textRange = document.createRange();
      textRange.selectNodeContents(text);
      const buttonBox = button.getBoundingClientRect();
      const textBox = textRange.getBoundingClientRect();
      return (
        textBox.left >= buttonBox.left - 1 &&
        textBox.right <= buttonBox.right + 1 &&
        textBox.top >= buttonBox.top - 1 &&
        textBox.bottom <= buttonBox.bottom + 1
      );
    });
  expect(labelTextContained).toBe(true);
  const contractEdgeSourceSummary = contractEdgeLabel.locator(".structure-edge-sources > summary");
  await contractEdgeSourceSummary.focus();
  await contractEdgeSourceSummary.press("Enter");
  await expect(contractEdgeLabel.locator(".structure-edge-sources")).toHaveAttribute("open", "");
  await expect(
    contractEdgeLabel.locator(".structure-edge-source-menu .structure-source"),
  ).toHaveCount(2);
  const firstContractEdgeSource = contractEdgeLabel
    .locator(".structure-edge-source-menu .structure-source")
    .first();
  await firstContractEdgeSource.focus();
  await firstContractEdgeSource.press("Enter");
  await expect(
    page.getByRole("tab", { name: "src/shared/contracts/order-detail.ts" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("diffs-container")).toHaveAttribute("data-search-target-line", "1");
  await page.getByRole("tab", { name: fullStackTitle }).click();
  await viewer.locator('.structure-node[data-node-id="order-api-client"]').click();
  await expect(
    viewer.locator('.structure-edge-label[data-edge-id="detail-client-provides-hook-result"]'),
  ).toContainText("typed resultを公開する");

  const overlaps = await viewer.evaluate((element) => {
    const nodes = [...element.querySelectorAll<HTMLElement>(".structure-node")].map((node) => ({
      id: node.dataset.nodeId,
      rect: node.getBoundingClientRect(),
    }));
    const labels = [...element.querySelectorAll<HTMLElement>(".structure-edge-label")].map(
      (label) => ({ id: label.dataset.edgeId, rect: label.getBoundingClientRect() }),
    );
    const intersects = (left: DOMRect, right: DOMRect): boolean =>
      left.right > right.left &&
      left.left < right.right &&
      left.bottom > right.top &&
      left.top < right.bottom;
    return {
      labelNodes: labels.flatMap((label) =>
        nodes
          .filter((node) => intersects(label.rect, node.rect))
          .map((node) => `${label.id}:${node.id}`),
      ),
      labelPairs: labels.flatMap((label, index) =>
        labels
          .slice(index + 1)
          .filter((other) => intersects(label.rect, other.rect))
          .map((other) => `${label.id}:${other.id}`),
      ),
    };
  });
  expect(overlaps.labelNodes).toEqual([]);
  expect(overlaps.labelPairs).toEqual([]);
});

test("keeps unassigned Context explicit without manufacturing a transitive Region relation", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, primaryTitle);
  const viewer = page.locator(`[data-structure-id="${primaryStructureId}"]`);
  await viewer.getByRole("button", { name: "Regions", exact: true }).click();

  const map = viewer.locator(".structure-region-map");
  await expect(viewer).toHaveAttribute("data-view-mode", "regions");
  await expect(map).toHaveAttribute("data-context-count", "1");
  await expect(viewer.locator(".structure-region-context-card")).toHaveCount(1);
  await expect(viewer.locator(".structure-region-context-card")).toHaveAccessibleName(
    "Unassigned Context: Application wiring. 1 node.",
  );
  const boundary = viewer.locator(
    '.structure-region-map-relation.context-boundary[data-edge-ids~="composition-constructs-handler"]',
  );
  await expect(boundary).toHaveCount(1);
  await expect(boundary).toHaveAttribute("data-direction", "context-to-region");
  await expect(
    viewer.locator(
      '.structure-region-map-relation:not(.context-boundary)[data-edge-ids~="composition-constructs-handler"]',
    ),
  ).toHaveCount(0);
  await expect(viewer.getByRole("list", { name: "Exact factual relationships" })).toContainText(
    "Context Application wiring to Application coordination",
  );
  const applicationRegionLabel = viewer
    .locator('.structure-region-map-card[data-region-id="application-coordination"]')
    .locator(".structure-region-map-card-heading > strong");
  await expect(applicationRegionLabel).toHaveText("Application coordination");
  expect(
    await applicationRegionLabel.evaluate((element) => ({
      overflow: getComputedStyle(element).overflow,
      textOverflow: getComputedStyle(element).textOverflow,
      whiteSpace: getComputedStyle(element).whiteSpace,
    })),
  ).toEqual({ overflow: "visible", textOverflow: "clip", whiteSpace: "normal" });
});

test("keeps Regions relation arrowheads legible against their lines in dark mode", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, primaryTitle);
  const viewer = page.locator(`[data-structure-id="${primaryStructureId}"]`);
  await viewer.getByRole("button", { name: "Regions", exact: true }).click();

  const paints = await viewer.locator(".structure-region-map").evaluate((map) =>
    [...map.querySelectorAll<SVGGElement>(".structure-region-map-relation")].flatMap((group) => {
      const line = group.querySelector<SVGPathElement>(".structure-region-map-relation-line");
      if (!line) return [];
      const markerPaints = [line.getAttribute("marker-start"), line.getAttribute("marker-end")]
        .flatMap((reference) => reference?.match(/#([^)]*)/u)?.[1] ?? [])
        .map((markerId) => {
          const arrowhead = map.querySelector<SVGPathElement>(`#${markerId} path`);
          return arrowhead
            ? {
                line: getComputedStyle(line).stroke,
                arrowhead: getComputedStyle(arrowhead).fill,
              }
            : null;
        })
        .filter((paint): paint is { line: string; arrowhead: string } => paint !== null);
      return markerPaints;
    }),
  );
  expect(paints.length).toBeGreaterThan(0);
  expect(paints.every(({ line, arrowhead }) => line === arrowhead)).toBe(true);
});

test("keeps native scrolling out of the transformed Graph camera", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, fullStackTitle);
  const viewer = page.locator(`[data-structure-id="${fullStackStructureId}"]`);
  const canvas = viewer.locator(".structure-canvas");

  await viewer.getByRole("button", { name: "Home", exact: true }).click();
  await expectStructureNodesFullyVisible(viewer, ["get-order-query"]);
  const edgeSelect = viewer.locator(
    '.structure-edge-label[data-edge-id="detail-route-executes-query"] .structure-edge-select',
  );
  const edgeSelectBounds = await edgeSelect.boundingBox();
  expect(edgeSelectBounds).not.toBeNull();
  await page.mouse.click(
    edgeSelectBounds!.x + edgeSelectBounds!.width / 2,
    edgeSelectBounds!.y + edgeSelectBounds!.height / 2,
  );
  await expect(edgeSelect).toHaveAttribute("aria-pressed", "true");
  await expect(edgeSelect).toBeFocused();
  await expect
    .poll(async () =>
      canvas.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop })),
    )
    .toEqual({ left: 0, top: 0 });
  await canvas.press("Escape");
  await expect(edgeSelect).toHaveAttribute("aria-pressed", "false");
  const clickVisibleNode = async (nodeId: string): Promise<void> => {
    await expect(viewer.locator(".structure-world")).not.toHaveClass(/camera-transition/u);
    const bounds = await viewer.locator(`.structure-node[data-node-id="${nodeId}"]`).boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  };
  await clickVisibleNode("get-order-query");
  await expect(viewer.locator('.structure-node[data-node-id="get-order-query"]')).toHaveClass(
    /focused/u,
  );
  await expectStructureNodesFullyVisible(viewer, ["orders-read-model"]);

  // A transformed element's untransformed layout box can prompt native focus scrolling.
  // The Structure camera must remain the sole viewport instead of composing that hidden
  // scroll offset with its persisted transform.
  await expect
    .poll(async () =>
      canvas.evaluate((element) => ({
        left: element.scrollLeft,
        top: element.scrollTop,
      })),
    )
    .toEqual({ left: 0, top: 0 });

  const readModel = viewer.locator('.structure-node[data-node-id="orders-read-model"]');
  await readModel.locator(".structure-node-focus").focus();
  await expect
    .poll(async () =>
      canvas.evaluate((element) => ({
        left: element.scrollLeft,
        top: element.scrollTop,
      })),
    )
    .toEqual({ left: 0, top: 0 });
  await readModel.locator(".structure-node-focus").press("Enter");
  await expect(readModel).toHaveClass(/focused/u);
  await expectStructureNodesFullyVisible(viewer, ["orders-read-model"]);
  await expect
    .poll(async () =>
      canvas.evaluate((element) => ({
        left: element.scrollLeft,
        top: element.scrollTop,
      })),
    )
    .toEqual({ left: 0, top: 0 });
});

test("switches between the stable Graph lens and the Regions overview with drill-down and pane-local Back", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, fullStackTitle);
  let viewer = page.locator(`[data-structure-id="${fullStackStructureId}"]`);
  const world = viewer.locator(".structure-world");
  await expect(viewer.locator(".structure-node")).toHaveCount(17);
  await viewer.getByRole("button", { name: "Home", exact: true }).click();
  await expect(viewer).toHaveAttribute("data-navigation-history-count", "0");
  const initialPositions = await viewer.locator(".structure-node").evaluateAll((nodes) =>
    Object.fromEntries(
      nodes.map((node) => [
        (node as HTMLElement).dataset.nodeId!,
        {
          left: (node as HTMLElement).style.left,
          top: (node as HTMLElement).style.top,
        },
      ]),
    ),
  );

  const thesisToggle = viewer.getByRole("button", { name: /Thesis/u });
  const graphMode = viewer.getByRole("button", { name: "Graph", exact: true });
  const regionsMode = viewer.getByRole("button", { name: "Regions", exact: true });
  await thesisToggle.click();
  await expect(thesisToggle).toHaveAttribute("aria-expanded", "false");

  await viewer.getByRole("button", { name: "1-hop", exact: true }).click();
  await expect(viewer.getByText("4/17 Node · 5/19 Relation", { exact: true })).toBeVisible();
  await expect(viewer.locator(".structure-region-member")).toHaveCount(0);
  const graphStateBeforeRegions = await structureGraphLensState(viewer);
  const regionOriginTransform = await world.evaluate(
    (element) => (element as HTMLElement).style.transform,
  );

  await regionsMode.click();
  await expect(viewer).toHaveAttribute("data-view-mode", "regions");
  await expect(regionsMode).toHaveAttribute("aria-pressed", "true");
  await expect(viewer.locator(".structure-canvas")).toBeHidden();
  await expect(viewer.locator(".structure-minimap")).toBeHidden();
  await expect(viewer.locator(".structure-region-map-card")).toHaveCount(4);
  const fittedRegionsCamera = await structureRegionsCameraState(viewer);
  await viewer.getByRole("button", { name: "Regionsを拡大" }).click();
  const regionsSurface = viewer.locator(".structure-regions-canvas-scroll");
  await regionsSurface.dispatchEvent("wheel", { deltaX: -17, deltaY: 13 });
  await expect(viewer).toHaveAttribute("data-regions-camera-mode", "manual");
  expect(await structureRegionsCameraState(viewer)).not.toEqual(fittedRegionsCamera);

  const reactRegionButton = viewer.getByRole("button", {
    name: /^Open region React rendering in Graph, 7 nodes\./u,
  });
  await reactRegionButton.focus();
  const regionsReturnCamera = await structureRegionsCameraState(viewer);
  await reactRegionButton.press("Enter");
  await expect(viewer).toHaveAttribute("data-view-mode", "graph");
  await expect(graphMode).toBeFocused();
  await expect(viewer).toHaveAttribute("data-navigation-history-count", "1");
  await expect(viewer.getByRole("button", { name: "全体", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(viewer).toHaveAttribute("data-framed-region-id", "frontend-rendering");
  await expect(viewer.locator(".structure-node")).toHaveCount(17);
  await expect(viewer.locator(".structure-region-member")).toHaveCount(0);
  const regionLens = viewer.locator('.structure-region-lens[data-region-id="frontend-rendering"]');
  await expect(regionLens).toBeVisible();
  await expect(regionLens).toContainText("React rendering");
  await expect(regionLens).toContainText(
    "typed query stateをcacheし、pageからsummary・items・status・error表示へ分配する。",
  );
  await expect(regionLens).toContainText("7 exact member Nodes · 6 internal Relations");
  expect(
    await viewer.evaluate((element) => {
      const lens = element.querySelector<HTMLElement>(".structure-region-lens")!;
      const lensRect = lens.getBoundingClientRect();
      return [
        ...element.querySelectorAll<HTMLElement>(
          '.structure-node[data-framed-region-member="true"]',
        ),
      ]
        .filter((node) => {
          const nodeRect = node.getBoundingClientRect();
          return (
            lensRect.left < nodeRect.right &&
            lensRect.right > nodeRect.left &&
            lensRect.top < nodeRect.bottom &&
            lensRect.bottom > nodeRect.top
          );
        })
        .map((node) => node.dataset.nodeId);
    }),
  ).toEqual([]);
  await expect(viewer.locator('.structure-node[data-node-id="order-detail-route"]')).toHaveClass(
    /focused/,
  );
  const framedSummaryNode = viewer.locator('.structure-node[data-node-id="order-summary-card"]');
  const framedSummaryRelation = viewer.locator(
    '.structure-edge[data-edge-id="detail-page-renders-summary"]',
  );
  await expect(framedSummaryNode).toHaveAttribute("data-focus-relevance", "distant");
  await expect(framedSummaryNode).toHaveAttribute("data-framed-region-member", "true");
  await expect(framedSummaryNode).not.toHaveClass(/context-distant/);
  await expect(framedSummaryRelation).toHaveAttribute("data-focus-relevance", "distant");
  await expect(framedSummaryRelation).toHaveAttribute("data-framed-region-relation", "true");
  await expect(framedSummaryRelation).not.toHaveClass(/context-distant/);
  await expectStructureNodesFullyVisible(viewer, [
    "order-detail-error",
    "order-detail-page",
    "order-detail-query-hook",
    "order-line-items",
    "order-query-cache",
    "order-status-badge",
    "order-summary-card",
  ]);
  expect(
    await viewer.locator(".structure-node").evaluateAll((nodes) =>
      Object.fromEntries(
        nodes.map((node) => [
          (node as HTMLElement).dataset.nodeId!,
          {
            left: (node as HTMLElement).style.left,
            top: (node as HTMLElement).style.top,
          },
        ]),
      ),
    ),
  ).toEqual(initialPositions);

  await viewer.getByRole("button", { name: "Home", exact: true }).click();
  await expect(viewer).not.toHaveAttribute("data-framed-region-id");
  await expect(viewer).toHaveAttribute("data-navigation-history-count", "2");
  await viewer.getByRole("button", { name: "Back", exact: true }).click();
  await expect(viewer).toHaveAttribute("data-framed-region-id", "frontend-rendering");
  await expect(viewer).toHaveAttribute("data-navigation-history-count", "1");

  await viewer.getByRole("button", { name: "2-hop", exact: true }).click();
  await expect(viewer).not.toHaveAttribute("data-framed-region-id");
  await expect(viewer.getByRole("button", { name: "2-hop", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(viewer).toHaveAttribute("data-navigation-history-count", "2");
  await viewer.getByRole("button", { name: "Back", exact: true }).click();
  await expect(viewer).toHaveAttribute("data-framed-region-id", "frontend-rendering");
  await expect(viewer.getByRole("button", { name: "全体", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(viewer).toHaveAttribute("data-navigation-history-count", "1");

  await viewer.getByRole("button", { name: "Back", exact: true }).click();
  await expect(viewer).toHaveAttribute("data-navigation-history-count", "0");
  await expect(viewer).toHaveAttribute("data-view-mode", "regions");
  await expect(viewer.locator(".structure-regions-canvas")).toBeVisible();
  await expect
    .poll(async () => await structureRegionsCameraState(viewer))
    .toEqual(regionsReturnCamera);
  await graphMode.click();
  await expect(viewer).toHaveAttribute("data-view-mode", "graph");
  await expect(viewer.getByRole("button", { name: "1-hop", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(viewer.locator(".structure-node")).toHaveCount(4);
  await expect(viewer.locator(".structure-region-member")).toHaveCount(0);
  await expect
    .poll(async () => await world.evaluate((element) => (element as HTMLElement).style.transform))
    .toBe(regionOriginTransform);
  await expect
    .poll(async () => await structureGraphLensState(viewer))
    .toEqual(graphStateBeforeRegions);

  await regionsMode.click();
  const regionsCameraBeforeClose = await structureRegionsCameraState(viewer);
  await page.getByRole("button", { name: `${fullStackTitle}を閉じる`, exact: true }).click();
  await openStructure(page, fullStackTitle);
  viewer = page.locator(`[data-structure-id="${fullStackStructureId}"]`);
  await expect(viewer.getByRole("button", { name: /Thesis/u })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(viewer).toHaveAttribute("data-view-mode", "regions");
  await expect
    .poll(async () => await structureRegionsCameraState(viewer))
    .toEqual(regionsCameraBeforeClose);
  await viewer.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(viewer.getByRole("button", { name: "1-hop", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await viewer.getByRole("button", { name: "Regions", exact: true }).click();
  await viewer
    .getByRole("button", { name: /^Open region React rendering in Graph, 7 nodes\./u })
    .click();
  await viewer.locator('.structure-node[data-node-id="order-detail-page"]').click();
  await expect(viewer).not.toHaveAttribute("data-framed-region-id");
  await expect(viewer.locator('.structure-node[data-node-id="order-detail-page"]')).toHaveClass(
    /focused/,
  );
  await expect(viewer).toHaveAttribute("data-navigation-history-count", "2");
  await expectStructureNodesFullyVisible(viewer, [
    "order-detail-query-hook",
    "order-detail-page",
    "order-summary-card",
    "order-line-items",
    "order-status-badge",
  ]);

  await viewer.getByRole("button", { name: "Back", exact: true }).click();
  await expect(viewer.locator('.structure-node[data-node-id="order-detail-route"]')).toHaveClass(
    /focused/,
  );
  await expect(viewer.getByRole("button", { name: "全体", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(viewer).toHaveAttribute("data-framed-region-id", "frontend-rendering");
  await expect(viewer).toHaveAttribute("data-navigation-history-count", "1");
  await viewer.getByRole("button", { name: "Back", exact: true }).click();
  await expect(viewer).toHaveAttribute("data-navigation-history-count", "0");
  await expect(viewer).toHaveAttribute("data-view-mode", "regions");
  await expect(viewer).not.toHaveAttribute("data-framed-region-id");
  await viewer.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(viewer.getByRole("button", { name: "1-hop", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const canvas = viewer.locator(".structure-canvas");
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  await page.mouse.move(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + canvasBox!.height / 2);
  await page.mouse.wheel(90, 65);
  const pannedTransform = await viewer.locator(".structure-world").getAttribute("style");
  await viewer.getByRole("button", { name: "Home", exact: true }).click();
  await expect(viewer.locator('.structure-node[data-node-id="order-detail-route"]')).toHaveClass(
    /focused/,
  );
  await expect
    .poll(async () => await viewer.locator(".structure-world").getAttribute("style"))
    .not.toBe(pannedTransform);
  expect(
    await viewer.locator(".structure-node").evaluateAll((nodes) =>
      Object.fromEntries(
        nodes.map((node) => [
          (node as HTMLElement).dataset.nodeId!,
          {
            left: (node as HTMLElement).style.left,
            top: (node as HTMLElement).style.top,
          },
        ]),
      ),
    ),
  ).toEqual(initialPositions);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await viewer.getAttribute("data-semantic-zoom")) === "overview") break;
    await viewer.getByRole("button", { name: "縮小", exact: true }).click();
  }
  await expect(viewer).toHaveAttribute("data-semantic-zoom", "overview");
  await expect(viewer.getByText("17/17 Node · 19/19 Relation", { exact: true })).toBeVisible();
  await expect(viewer.locator(".structure-minimap")).toBeVisible();
  const secondaryLabel = viewer.locator(
    '.structure-edge-label[data-edge-id="detail-page-renders-summary"]',
  );
  const coreLabel = viewer.locator(
    '.structure-edge-label[data-edge-id="detail-route-executes-query"]',
  );
  await expect
    .poll(async () =>
      secondaryLabel
        .locator(".structure-edge-label-text")
        .evaluate((element) => getComputedStyle(element).visibility),
    )
    .toBe("hidden");
  expect(
    await coreLabel
      .locator(".structure-edge-label-text")
      .evaluate((element) => getComputedStyle(element).visibility),
  ).toBe("visible");
  await secondaryLabel.locator(".structure-edge-select").focus();
  await secondaryLabel.locator(".structure-edge-select").press("Enter");
  await expect(secondaryLabel).toHaveClass(/selected/);
  expect(
    await secondaryLabel
      .locator(".structure-edge-label-text")
      .evaluate((element) => getComputedStyle(element).visibility),
  ).toBe("visible");
  await viewer.getByRole("button", { name: "Regions", exact: true }).click();
  await viewer
    .getByRole("button", { name: /^Open region React rendering in Graph, 7 nodes\./u })
    .click();
  await expect(secondaryLabel).toHaveClass(/selected/);
  await expect(viewer.locator('.structure-node[data-node-id="order-detail-route"]')).toHaveClass(
    /focused/,
  );
});

test("restores a captured Regions camera through same-mode Back after a pane resize", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, fullStackTitle);
  const viewer = page.locator(`[data-structure-id="${fullStackStructureId}"]`);
  const regionsMode = viewer.getByRole("button", { name: "Regions", exact: true });
  await regionsMode.click();
  await viewer.getByRole("button", { name: "Regionsを拡大" }).click();
  await viewer
    .locator(".structure-regions-canvas-scroll")
    .dispatchEvent("wheel", { deltaX: -23, deltaY: 17 });
  const regionButton = viewer.getByRole("button", {
    name: /^Open region React rendering in Graph, 7 nodes\./u,
  });
  await regionButton.focus();
  await regionButton.press("Enter");
  await expect(viewer).toHaveAttribute("data-view-mode", "graph");

  await page.setViewportSize({ width: 1_040, height: 720 });
  await regionsMode.click();
  await expect(viewer).toHaveAttribute("data-view-mode", "regions");
  const resizedReturnCamera = await structureRegionsCameraState(viewer);
  await viewer.getByRole("button", { name: "Regionsを拡大" }).click();
  await expect
    .poll(async () => await structureRegionsCameraState(viewer))
    .not.toEqual(resizedReturnCamera);

  await viewer.getByRole("button", { name: "Back", exact: true }).click();
  await expect
    .poll(async () => await structureRegionsCameraState(viewer))
    .toEqual(resizedReturnCamera);
});

test("reframes an open manual Regions camera when its derived map basis changes", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, fullStackTitle);
  const viewer = page.locator(`[data-structure-id="${fullStackStructureId}"]`);
  const detailResponse = await page.request.get(
    `/api/pull-requests/${pullRequestId}/structures/${fullStackStructureId}`,
  );
  expect(detailResponse.ok()).toBe(true);
  const detail = (await detailResponse.json()) as {
    structure: {
      title: string;
      presentation: {
        thesis: string;
        startNodeId: string;
        primaryBackbone: { edgeIds: string[] } | null;
        regions: Array<{ id: string; label: string; summary: string; nodeIds: string[] }>;
      };
    };
  };
  const originalTitle = detail.structure.title;
  const originalPresentation = detail.structure.presentation;
  const relabeledRegion = originalPresentation.regions[0]!;

  await viewer.getByRole("button", { name: "Regions", exact: true }).click();
  await viewer.getByRole("button", { name: "Regionsを拡大" }).click();
  await viewer
    .locator(".structure-regions-canvas-scroll")
    .dispatchEvent("wheel", { deltaX: 37, deltaY: -19 });
  await expect(viewer).toHaveAttribute("data-regions-camera-mode", "manual");

  const relabeledPresentation = {
    ...originalPresentation,
    regions: originalPresentation.regions.map((region, index) =>
      index === 0 ? { ...region, label: `${relabeledRegion.label} updated` } : region,
    ),
  };
  const updatedTitle = `${originalTitle} Regions updated`;
  try {
    const updateResponse = await page.request.post(
      `/api/fixture/structures/${fullStackStructureId}/update`,
      { data: { title: updatedTitle, presentation: relabeledPresentation } },
    );
    expect(updateResponse.ok()).toBe(true);
    await expect(viewer.locator(".structure-header h2")).toHaveText(updatedTitle);
    await expect(viewer).toHaveAttribute("data-regions-camera-mode", "home");
    await expect
      .poll(async () => Number(await viewer.getAttribute("data-regions-viewport-scale")))
      .toBeLessThan(1);
    expect(Number(await viewer.getAttribute("data-regions-viewport-scale"))).toBeGreaterThanOrEqual(
      0.7,
    );
    await expect(
      viewer.locator(`.structure-region-map-card[data-region-id="${relabeledRegion.id}"]`),
    ).toContainText("updated");
  } finally {
    const restoreResponse = await page.request.post(
      `/api/fixture/structures/${fullStackStructureId}/update`,
      { data: { title: originalTitle, presentation: originalPresentation } },
    );
    expect(restoreResponse.ok()).toBe(true);
    await expect(viewer.locator(".structure-header h2")).toHaveText(originalTitle);
  }
});

test("exports the complete Structure as standalone SVG and 2x PNG without changing reading state", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, primaryTitle);
  const viewer = page.locator(`[data-structure-id="${primaryStructureId}"]`);
  await viewer.getByRole("button", { name: "表示中を収める" }).click();

  const hub = viewer.locator('.structure-node[data-node-id="hub"]');
  await dragVisibleStructureNode(page, viewer, hub);
  const movedHub = await hub.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
  }));
  await viewer.locator('.structure-node[data-node-id="order-aggregate"]').click();
  await viewer.getByRole("button", { name: "1-hop", exact: true }).click();
  await viewer.locator(".structure-edge-select").first().click();
  await viewer.getByRole("button", { name: "拡大" }).click();
  const readingState = await structureReadingState(viewer);
  const worldTransform = await viewer.locator(".structure-world").getAttribute("style");
  const selectedEdgeId = await viewer.getAttribute("data-selected-edge-id");
  const nodeCount = Number(await viewer.getAttribute("data-total-node-count"));
  const edgeCount = Number(await viewer.getAttribute("data-total-edge-count"));
  await viewer.getByRole("button", { name: "Regions", exact: true }).click();
  await expect(viewer).toHaveAttribute("data-view-mode", "regions");

  const exportMenu = viewer.locator('summary[aria-label="Structureをエクスポート"]');
  await exportMenu.click();
  await expect(viewer.locator(".structure-export-popover")).toContainText(
    "現在の配置で、全Node・全Relation・全Edge labelを書き出します。",
  );
  await expect(viewer.locator(".structure-export-popover")).not.toHaveAttribute("role");
  await expect(viewer.locator(".structure-export-popover").getByRole("button")).toHaveCount(2);
  const svgDownloadPromise = page.waitForEvent("download");
  await viewer.getByRole("button", { name: /SVG.*全体・ベクター/u }).click();
  const svgDownload = await svgDownloadPromise;
  expect(svgDownload.suggestedFilename()).toMatch(
    /^rvw-structure-Order-placement-behavior-[a-f0-9]{8}\.svg$/u,
  );
  const svgPath = await svgDownload.path();
  expect(svgPath).not.toBeNull();
  const svg = await readFile(svgPath, "utf8");
  expect(svg.match(/data-node-id=/gu)).toHaveLength(nodeCount);
  expect(svg.match(/<path data-edge-id=/gu)).toHaveLength(edgeCount);
  expect(svg.match(/data-edge-label-id=/gu)).toHaveLength(edgeCount);
  expect(svg).not.toContain("<foreignObject");
  expect(svg).not.toContain("<script");
  expect(svg).not.toContain("var(");
  expect(svg).not.toContain("selected");
  expect(svg).not.toContain("muted");
  const hubMatch = svg.match(/<g data-node-id="hub"[^>]*><rect x="([^"]+)" y="([^"]+)"/u);
  expect(hubMatch).not.toBeNull();
  expect(Number(hubMatch![1])).toBeCloseTo(movedHub.x, 2);
  expect(Number(hubMatch![2])).toBeCloseTo(movedHub.y, 2);
  const svgDimensions = svg.match(/<svg[^>]* width="(\d+)" height="(\d+)"/u);
  expect(svgDimensions).not.toBeNull();

  await expect(viewer).toHaveAttribute("data-view-mode", "regions");
  await viewer.getByRole("button", { name: "Graph", exact: true }).click();
  await expect.poll(async () => await structureReadingState(viewer)).toEqual(readingState);
  expect(await viewer.locator(".structure-world").getAttribute("style")).toBe(worldTransform);
  expect(await viewer.getAttribute("data-selected-edge-id")).toBe(selectedEdgeId);
  await viewer.getByRole("button", { name: "Regions", exact: true }).click();

  await exportMenu.click();
  const pngDownloadPromise = page.waitForEvent("download");
  await viewer.getByRole("button", { name: /PNG.*全体・2×/u }).click();
  const pngDownload = await pngDownloadPromise;
  expect(pngDownload.suggestedFilename()).toMatch(
    /^rvw-structure-Order-placement-behavior-[a-f0-9]{8}\.png$/u,
  );
  const pngPath = await pngDownload.path();
  expect(pngPath).not.toBeNull();
  const png = await readFile(pngPath);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.readUInt32BE(16)).toBe(Number(svgDimensions![1]) * 2);
  expect(png.readUInt32BE(20)).toBe(Number(svgDimensions![2]) * 2);
  await expect(viewer).toHaveAttribute("data-view-mode", "regions");
  await viewer.getByRole("button", { name: "Graph", exact: true }).click();
  await expect.poll(async () => await structureReadingState(viewer)).toEqual(readingState);
  expect(await viewer.locator(".structure-world").getAttribute("style")).toBe(worldTransform);
  expect(await viewer.getAttribute("data-selected-edge-id")).toBe(selectedEdgeId);
});

test("keeps the Export popover inside a narrow Structure pane", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, primaryTitle);
  await page
    .getByRole("navigation", { name: "レビュー文書" })
    .getByRole("button", { name: secondaryTitle, exact: true })
    .click({ modifiers: ["Meta"] });

  const viewer = page
    .locator('.document-pane[data-pane="left"]')
    .locator(`[data-structure-id="${primaryStructureId}"]`);
  const regionsMode = viewer.getByRole("button", { name: "Regions", exact: true });
  await regionsMode.scrollIntoViewIfNeeded();
  await expect(regionsMode).toBeVisible();
  await regionsMode.click();
  await expect(viewer).toHaveAttribute("data-view-mode", "regions");
  const regionsScroll = viewer.locator(".structure-regions-canvas-scroll");
  await expect(regionsScroll).toBeVisible();
  const scrollMetrics = await regionsScroll.evaluate((element) => ({
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
    overflow: getComputedStyle(element).overflow,
  }));
  expect(scrollMetrics.clientWidth).toBeLessThan(320);
  expect(scrollMetrics.overflow).toBe("hidden");
  expect(scrollMetrics.scrollWidth).toBeGreaterThan(0);
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(0);
  await expect(viewer).toHaveAttribute("data-regions-camera-mode", "home");
  const homeCamera = await structureRegionsCameraState(viewer);
  const homeScale = Number(homeCamera.scale);
  expect(homeScale).toBeGreaterThanOrEqual(0.7);
  const startRegion = viewer.locator('.structure-region-map-card[data-start-region="true"]');
  await expect
    .poll(async () => {
      const [surfaceBox, cardBox] = await Promise.all([
        regionsScroll.boundingBox(),
        startRegion.boundingBox(),
      ]);
      if (!surfaceBox || !cardBox) return false;
      return (
        cardBox.x >= surfaceBox.x &&
        cardBox.x + cardBox.width <= surfaceBox.x + surfaceBox.width &&
        cardBox.y >= surfaceBox.y &&
        cardBox.y + cardBox.height <= surfaceBox.y + surfaceBox.height
      );
    })
    .toBe(true);

  await viewer.getByRole("button", { name: "Regions全体を収める" }).click();
  await expect(viewer).toHaveAttribute("data-regions-camera-mode", "fit");
  await expectRegionsMapFullyVisible(viewer);
  const fitCamera = await structureRegionsCameraState(viewer);
  const fitScale = Number(fitCamera.scale);
  expect(fitScale).toBeGreaterThan(0);
  expect(fitScale).toBeLessThan(homeScale);

  const dragStart = await regionsScroll.evaluate((surface) => {
    const bounds = surface.getBoundingClientRect();
    const left = Math.max(bounds.left, 0);
    const top = Math.max(bounds.top, 0);
    const right = Math.min(bounds.right, window.innerWidth);
    const bottom = Math.min(bounds.bottom, window.innerHeight);
    for (let y = bottom - 12; y >= top + 12; y -= 18) {
      for (let x = left + 12; x <= right - 12; x += 18) {
        const target = document.elementFromPoint(x, y);
        if (
          target &&
          target.closest(".structure-regions-canvas-scroll") === surface &&
          !target.closest(
            ".structure-region-map-card, .structure-region-map-relation-label, button",
          )
        ) {
          return { x, y };
        }
      }
    }
    throw new Error("No visible blank Regions canvas point was available for pointer panning.");
  });
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 42, dragStart.y - 34, { steps: 4 });
  await page.mouse.up();
  const draggedCamera = await structureRegionsCameraState(viewer);
  expect(draggedCamera.transform).not.toBe(fitCamera.transform);
  expect(Number(draggedCamera.scale)).toBeCloseTo(fitScale, 3);
  await expect(viewer).toHaveAttribute("data-regions-camera-mode", "manual");

  const surfaceBox = await regionsScroll.boundingBox();
  expect(surfaceBox).not.toBeNull();
  await page.mouse.move(
    surfaceBox!.x + surfaceBox!.width / 2,
    Math.min(surfaceBox!.y + surfaceBox!.height / 2, 700),
  );
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -80);
  await page.keyboard.up("Control");
  await expect
    .poll(async () => Number(await viewer.getAttribute("data-regions-viewport-scale")))
    .toBeGreaterThan(fitScale);

  await viewer.getByRole("button", { name: "Regionsを拡大" }).click();
  await expect
    .poll(async () => Number(await viewer.getAttribute("data-regions-viewport-scale")))
    .toBeGreaterThan(fitScale);
  await expect(viewer).toHaveAttribute("data-regions-camera-mode", "manual");
  const zoomedCamera = await structureRegionsCameraState(viewer);
  await regionsScroll.dispatchEvent("wheel", { deltaX: 24, deltaY: 18 });
  await expect
    .poll(async () => await structureRegionsCameraState(viewer))
    .not.toEqual(zoomedCamera);
  expect(Number((await structureRegionsCameraState(viewer)).scale)).toBeCloseTo(
    Number(zoomedCamera.scale),
    3,
  );

  const lastRegion = viewer.locator(".structure-region-map-card").last();
  await lastRegion.focus();
  await expect(lastRegion).toBeFocused();
  await expect
    .poll(async () => {
      const [surfaceBox, cardBox] = await Promise.all([
        regionsScroll.boundingBox(),
        lastRegion.boundingBox(),
      ]);
      if (!surfaceBox || !cardBox) return false;
      return (
        cardBox.x >= surfaceBox.x + 14 &&
        cardBox.x + cardBox.width <= surfaceBox.x + surfaceBox.width - 14 &&
        cardBox.y >= surfaceBox.y + 14 &&
        cardBox.y + cardBox.height <= surfaceBox.y + surfaceBox.height - 14
      );
    })
    .toBe(true);

  await viewer.getByRole("button", { name: "Regions表示を戻す" }).click();
  await expect(viewer).toHaveAttribute("data-regions-camera-mode", "home");
  expect(Number(await viewer.getAttribute("data-regions-viewport-scale"))).toBeGreaterThanOrEqual(
    0.7,
  );

  await viewer.getByRole("button", { name: "Regions全体を収める" }).click();
  await expect(viewer).toHaveAttribute("data-regions-camera-mode", "fit");
  await expectRegionsMapFullyVisible(viewer);

  const applicationRegion = viewer.getByRole("button", {
    name: /^Open region Application coordination in Graph, 3 nodes\./u,
  });
  await applicationRegion.scrollIntoViewIfNeeded();
  await applicationRegion.click();
  const regionLens = viewer.locator(
    '.structure-region-lens[data-region-id="application-coordination"]',
  );
  await expect(regionLens).toBeVisible();
  await expect(viewer.locator(".structure-canvas-status")).toHaveCount(0);
  const lensContainment = await viewer.evaluate((element) => {
    const canvas = element.querySelector<HTMLElement>(".structure-canvas")!.getBoundingClientRect();
    const toolbar = element
      .querySelector<HTMLElement>(".structure-toolbar")!
      .getBoundingClientRect();
    const lens = element.querySelector<HTMLElement>(".structure-region-lens")!;
    const lensRect = lens.getBoundingClientRect();
    const style = getComputedStyle(lens);
    return {
      canvasLeft: canvas.left,
      canvasRight: canvas.right,
      toolbarBottom: toolbar.bottom,
      lensLeft: lensRect.left,
      lensRight: lensRect.right,
      lensTop: lensRect.top,
      overflowY: style.overflowY,
      pointerEvents: style.pointerEvents,
      whiteSpace: getComputedStyle(lens.querySelector<HTMLElement>(".structure-region-lens > p")!)
        .whiteSpace,
    };
  });
  expect(lensContainment.lensLeft).toBeGreaterThanOrEqual(lensContainment.canvasLeft + 7);
  expect(lensContainment.lensRight).toBeLessThanOrEqual(lensContainment.canvasRight - 7);
  expect(lensContainment.lensTop).toBeGreaterThan(lensContainment.toolbarBottom);
  expect(lensContainment).toMatchObject({
    overflowY: "auto",
    pointerEvents: "auto",
    whiteSpace: "normal",
  });
  await regionLens.focus();
  await expect(regionLens).toBeFocused();
  await viewer.getByRole("button", { name: "Back", exact: true }).click();
  await expect(viewer).toHaveAttribute("data-view-mode", "regions");

  await viewer.locator('summary[aria-label="Structureをエクスポート"]').click();
  const containment = await viewer.evaluate((element) => {
    const viewerRect = element.getBoundingClientRect();
    const popoverRect = element
      .querySelector<HTMLElement>(".structure-export-popover")!
      .getBoundingClientRect();
    return {
      viewerLeft: viewerRect.left,
      viewerRight: viewerRect.right,
      viewerWidth: viewerRect.width,
      popoverLeft: popoverRect.left,
      popoverRight: popoverRect.right,
    };
  });
  expect(containment.viewerWidth).toBeLessThan(320);
  expect(containment.popoverLeft).toBeGreaterThanOrEqual(containment.viewerLeft + 7);
  expect(containment.popoverRight).toBeLessThanOrEqual(containment.viewerRight - 7);
});

test("scrolls complete long content inside a fixed-size Node", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, secondaryTitle);

  const viewer = page.locator(`[data-structure-id="${secondaryStructureId}"]`);
  await viewer.getByRole("button", { name: "表示中を収める" }).click();
  const node = viewer.locator('.structure-node[data-node-id="payment-reconciliation"]');
  const title = node.locator(".structure-node-title-text");
  const description = node.locator(".structure-node-description");
  const sourceAction = node.locator(":scope > .structure-source.compact");
  const scroller = node.locator(".structure-node-focus");

  await expect(node.locator(".structure-kind")).toHaveCount(0);
  await expect(node.locator(".structure-node-expand-trigger")).toHaveCount(0);
  const cardMetrics = await node.evaluate((element) => {
    const titleElement = element.querySelector<HTMLElement>(".structure-node-title-text")!;
    const descriptionElement = element.querySelector<HTMLElement>(".structure-node-description")!;
    const sourceElement = element.querySelector<HTMLElement>(":scope > .structure-source.compact")!;
    const scrollerElement = element.querySelector<HTMLElement>(".structure-node-focus")!;
    const titleStyle = getComputedStyle(titleElement);
    const descriptionStyle = getComputedStyle(descriptionElement);
    const titleBox = titleElement.getBoundingClientRect();
    const descriptionBox = descriptionElement.getBoundingClientRect();
    const sourceBox = sourceElement.getBoundingClientRect();
    const sourceIdentityElement = element.querySelector<HTMLElement>(".structure-source-identity")!;
    const sourceIdentityBox = sourceIdentityElement.getBoundingClientRect();
    const sourceNameElement =
      sourceIdentityElement.querySelector<HTMLElement>(".structure-source-name")!;
    return {
      titleClamp: titleStyle.webkitLineClamp,
      titleClientHeight: titleElement.clientHeight,
      titleScrollHeight: titleElement.scrollHeight,
      titleRight: titleBox.right,
      titleTop: titleBox.top,
      sourceLeft: sourceBox.left,
      sourceBottom: sourceBox.bottom,
      descriptionClamp: descriptionStyle.webkitLineClamp,
      descriptionClientHeight: descriptionElement.clientHeight,
      descriptionScrollHeight: descriptionElement.scrollHeight,
      descriptionRight: descriptionBox.right,
      sourceCenter: sourceBox.left + sourceBox.width / 2,
      sourceIdentityRight: sourceIdentityBox.right,
      sourceNameMaxWidth: getComputedStyle(sourceNameElement).maxWidth,
      scrollerOverflow: getComputedStyle(scrollerElement).overflowY,
      scrollerClientHeight: scrollerElement.clientHeight,
      scrollerScrollHeight: scrollerElement.scrollHeight,
    };
  });
  expect(cardMetrics.titleClamp).toBe("none");
  expect(cardMetrics.titleScrollHeight).toBe(cardMetrics.titleClientHeight);
  expect(cardMetrics.sourceIdentityRight).toBeLessThanOrEqual(cardMetrics.sourceLeft + 0.5);
  expect(cardMetrics.sourceNameMaxWidth).toBe("none");
  expect(cardMetrics.titleTop).toBeGreaterThanOrEqual(cardMetrics.sourceBottom - 0.5);
  expect(cardMetrics.titleRight).toBeGreaterThan(cardMetrics.sourceCenter);
  expect(cardMetrics.descriptionClamp).toBe("none");
  expect(cardMetrics.descriptionScrollHeight).toBe(cardMetrics.descriptionClientHeight);
  expect(cardMetrics.titleRight).toBeCloseTo(cardMetrics.descriptionRight, 0);
  expect(cardMetrics.descriptionRight).toBeGreaterThan(cardMetrics.sourceCenter);
  expect(cardMetrics.scrollerOverflow).toBe("auto");
  expect(cardMetrics.scrollerScrollHeight).toBeGreaterThan(cardMetrics.scrollerClientHeight);

  const fullTitle = (await title.textContent())!.trim();
  const fullDescription = (await description.textContent())!.trim();
  expect(fullTitle.length).toBeGreaterThan(60);
  expect(fullDescription.length).toBeGreaterThan(120);
  await expect(description).not.toHaveAttribute("title");
  await expect(sourceAction).toBeVisible();
  const fixedBox = await node.boundingBox();
  expect(fixedBox).not.toBeNull();
  const world = viewer.locator(".structure-world");
  const worldTransform = await world.getAttribute("style");
  await scroller.hover();
  await page.mouse.wheel(0, 180);
  await expect
    .poll(async () => await scroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await world.getAttribute("style")).toBe(worldTransform);
  const scrolledBox = await node.boundingBox();
  expect(scrolledBox!.x).toBeCloseTo(fixedBox!.x, 0);
  expect(scrolledBox!.y).toBeCloseTo(fixedBox!.y, 0);
  expect(scrolledBox!.width).toBeCloseTo(fixedBox!.width, 0);
  expect(scrolledBox!.height).toBeCloseTo(fixedBox!.height, 0);

  const worldTranslation = async (): Promise<{ x: number; y: number }> =>
    await world.evaluate((element) => {
      const match = element.style.transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
      if (!match) throw new Error(`unexpected Structure transform: ${element.style.transform}`);
      return { x: Number(match[1]), y: Number(match[2]) };
    });
  const scrollAfterVertical = await scroller.evaluate((element) => element.scrollTop);
  const scaleBeforeHorizontalPan = Number(await viewer.getAttribute("data-viewport-scale"));
  const horizontalPanBefore = await worldTranslation();
  await scroller.hover();
  await page.mouse.wheel(36, 0);
  await expect.poll(async () => (await worldTranslation()).x).not.toBe(horizontalPanBefore.x);
  const horizontalPanAfter = await worldTranslation();
  expect(horizontalPanAfter.x - horizontalPanBefore.x).toBeCloseTo(-72, 0);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scrollAfterVertical);
  expect(Number(await viewer.getAttribute("data-viewport-scale"))).toBe(scaleBeforeHorizontalPan);

  const viewportScaleBefore = await page.evaluate(() => window.visualViewport?.scale ?? 1);
  const canvasScaleBefore = Number(await viewer.getAttribute("data-viewport-scale"));
  await scroller.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 40);
  await page.keyboard.up("Control");
  await expect
    .poll(async () => Number(await viewer.getAttribute("data-viewport-scale")))
    .not.toBe(canvasScaleBefore);
  expect(Number(await viewer.getAttribute("data-viewport-scale"))).toBeCloseTo(
    canvasScaleBefore * Math.exp(-40 * 0.005),
    2,
  );
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(viewportScaleBefore);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scrollAfterVertical);

  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  const topBoundaryBefore = await worldTranslation();
  await scroller.hover();
  await page.mouse.wheel(0, -30);
  await expect.poll(async () => (await worldTranslation()).y).not.toBe(topBoundaryBefore.y);
  expect((await worldTranslation()).y - topBoundaryBefore.y).toBeCloseTo(60, 0);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);

  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const bottomScroll = await scroller.evaluate((element) => element.scrollTop);
  const bottomBoundaryBefore = await worldTranslation();
  await scroller.hover();
  await page.mouse.wheel(0, 30);
  await expect.poll(async () => (await worldTranslation()).y).not.toBe(bottomBoundaryBefore.y);
  expect((await worldTranslation()).y - bottomBoundaryBefore.y).toBeCloseTo(-60, 0);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(bottomScroll);

  const scrollBeforeExport = await scroller.evaluate((element) => element.scrollTop);
  const svgDownloadPromise = page.waitForEvent("download");
  await viewer.locator('summary[aria-label="Structureをエクスポート"]').click();
  await viewer.getByRole("button", { name: /SVG.*全体・ベクター/u }).click();
  const svgDownload = await svgDownloadPromise;
  const svgPath = await svgDownload.path();
  expect(svgPath).not.toBeNull();
  const svg = await readFile(svgPath, "utf8");
  expect(svg).toMatch(
    /<g data-node-id="payment-reconciliation"[\s\S]*?<text[^>]*font-size="11"[^>]*font-weight="700"[^>]*><tspan[^>]*>Payment/u,
  );
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scrollBeforeExport);
});

test("preserves Structure fallback meaning through commit and head changes", async ({
  page,
  request,
}) => {
  const anchorOid = "b".repeat(40);
  const oldHead = "c".repeat(40);
  const newHead = "e".repeat(40);
  const anchorPath = "src/application/orders/create-order.ts";
  let exposeNewHead = false;
  type TestPullRequestView = {
    pullRequest: { latestHeadOid: string } & Record<string, unknown>;
    comparisonBaseOid: string;
    headOid: string;
    commits: Array<{
      oid: string;
      parentOids: string[];
      subject: string;
      authorName: string;
      authoredAt: string;
    }>;
  };
  await page.route("**/structures/*/anchors/resolve*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      resolution: {
        outcome: "latest" | "source-fallback";
        anchorSourceOid: string;
        latestHeadOid: string;
        target: {
          sourceOid: string;
          path: string;
          diffBaseOid: string | null;
          oldPath: string | null;
          newPath: string | null;
          hasDiff: boolean;
          startLine: number | null;
          endLine: number | null;
        };
        latestFile: {
          sourceOid: string;
          path: string;
          diffBaseOid: string | null;
          oldPath: string | null;
          newPath: string | null;
          hasDiff: boolean;
        } | null;
        document: { ref: { sourceOid: string }; text: string | null; byteLength: number };
      };
    };
    if (exposeNewHead) {
      body.resolution.outcome = "latest";
      body.resolution.latestHeadOid = newHead;
      body.resolution.target.sourceOid = newHead;
      body.resolution.target.diffBaseOid = null;
      body.resolution.target.hasDiff = false;
      body.resolution.target.startLine = 1;
      body.resolution.target.endLine = 1;
      body.resolution.latestFile = null;
      body.resolution.document.ref.sourceOid = newHead;
      body.resolution.document.text =
        body.resolution.document.text?.replace(/\n\n\/\/ Updated orchestration path\.\n$/, "\n") ??
        null;
      body.resolution.document.byteLength = new TextEncoder().encode(
        body.resolution.document.text ?? "",
      ).byteLength;
    } else {
      body.resolution.outcome = "source-fallback";
      body.resolution.anchorSourceOid = anchorOid;
      body.resolution.latestHeadOid = oldHead;
      body.resolution.target.sourceOid = anchorOid;
      body.resolution.target.diffBaseOid = "a".repeat(40);
      body.resolution.target.hasDiff = true;
      body.resolution.latestFile = {
        sourceOid: oldHead,
        path: anchorPath,
        diffBaseOid: null,
        oldPath: anchorPath,
        newPath: anchorPath,
        hasDiff: false,
      };
      body.resolution.document.ref.sourceOid = anchorOid;
      body.resolution.document.text =
        body.resolution.document.text?.replace(/\n\n\/\/ Updated orchestration path\.\n$/, "\n") ??
        null;
      body.resolution.document.byteLength = new TextEncoder().encode(
        body.resolution.document.text ?? "",
      ).byteLength;
    }
    await route.fulfill({ response, json: body });
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
  await openStructure(page, primaryTitle);
  const viewer = page.locator(`[data-structure-id="${primaryStructureId}"]`);
  await viewer.locator('.structure-node[data-node-id="hub"] > .structure-source.compact').click();

  await expect(page.getByRole("tab", { name: anchorPath })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const fallbackBanner = page.locator(".reference-anchor-fallback-banner");
  await expect(fallbackBanner).toContainText(`参照時点のコード · ${anchorOid.slice(0, 8)}`);
  await expect(fallbackBanner).toContainText(
    "最新コード上の対応位置を確実に特定できませんでした。",
  );
  await expect(fallbackBanner.getByRole("button", { name: "最新のファイルを見る" })).toBeVisible();

  const reviewScope = page.getByRole("region", { name: "レビュー範囲", exact: true });
  const commitPicker = reviewScope.getByRole("button", { name: /^対象commit:/ });
  await commitPicker.click();
  await page
    .getByRole("dialog", { name: "対象commitを選択" })
    .getByRole("option", { name: /Add fixture function/ })
    .click();
  await expect(commitPicker).toHaveAccessibleName(/Add fixture function/);
  await expect(fallbackBanner).toBeVisible();
  await expect(fallbackBanner.getByRole("button", { name: "最新のファイルを見る" })).toBeVisible();
  await reviewScope.getByRole("button", { name: "変更", exact: true }).click();

  const currentResponse = await request.get(`/api/pull-requests/${pullRequestId}`);
  const current = (await currentResponse.json()) as TestPullRequestView;
  const withNewHead = <View extends TestPullRequestView>(view: View): View => ({
    ...view,
    pullRequest: { ...view.pullRequest, latestHeadOid: newHead },
    headOid: newHead,
    commits: [
      ...view.commits,
      {
        oid: newHead,
        parentOids: [oldHead],
        subject: "Post-Structure update",
        authorName: "Fixture Author",
        authoredAt: "2026-08-08T03:00:00.000Z",
      },
    ],
  });
  expect(current.headOid).toBe(oldHead);
  await page.route(`**/api/pull-requests/${pullRequestId}`, async (route) => {
    const response = await route.fetch();
    const view = (await response.json()) as TestPullRequestView;
    await route.fulfill({ response, json: exposeNewHead ? withNewHead(view) : view });
  });
  await page.route(`**/api/pull-requests/${pullRequestId}/refresh`, async (route) => {
    const response = await route.fetch();
    const view = (await response.json()) as TestPullRequestView & {
      commentUpdatesApplied: number;
    };
    exposeNewHead = true;
    await route.fulfill({ response, json: withNewHead(view) });
  });
  await page.getByRole("button", { name: "その他の操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "GitHubと同期" }).click();

  const staleBanner = page.locator(".reference-stale-banner");
  await expect(staleBanner).toContainText(
    `解決時 ${oldHead.slice(0, 8)} → 現在 ${newHead.slice(0, 8)}`,
  );
  await expect(staleBanner).toContainText(`参照時点のコード · ${anchorOid.slice(0, 8)} を表示中`);
  await expect(fallbackBanner).toHaveCount(0);
  await expect(page.getByRole("button", { name: "最新のファイルを見る" })).toHaveCount(0);

  const reresolution = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/anchors/resolve"),
  );
  await staleBanner.getByRole("button", { name: "最新へ再解決" }).click();
  await reresolution;
  await expect(staleBanner).toHaveCount(0);
  await expect(fallbackBanner).toHaveCount(0);
  await expect(
    page.getByText("選択中の比較範囲は最新HEADで終わっていないため · 最新の全文表示", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(commitPicker).toHaveAccessibleName(/Add fixture function/);
});

test("re-resolves Structure sources by stable Node and Edge identity", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, fullStackTitle);
  const viewer = page.locator(`[data-structure-id="${fullStackStructureId}"]`);
  const nodeSource = viewer.locator(
    '.structure-node[data-node-id="order-detail-route"] > .structure-source.compact',
  );
  await nodeSource.click();
  await expect(page.getByRole("tab", { name: "src/http/routes/order-detail.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const movedNodeAnchor = {
    path: "src/http/routes/order-detail.ts",
    startLine: 1,
    endLine: 2,
  };
  const moveNode = await page.request.post(
    `/api/fixture/structures/${fullStackStructureId}/source-lifecycle`,
    {
      data: {
        nodeId: "order-detail-route",
        anchor: movedNodeAnchor,
        reusePreviousAnchorOnNodeId: "detail-actor-auth",
      },
    },
  );
  expect(moveNode.ok()).toBe(true);

  const staleBanner = page.locator(".reference-stale-banner");
  await expect(staleBanner).toContainText("Structureが更新されています");
  const nodeResolution = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/anchors/resolve") &&
      url.searchParams.get("locatorKind") === "node" &&
      url.searchParams.get("nodeId") === "order-detail-route"
    );
  });
  await staleBanner.getByRole("button", { name: "最新へ再解決" }).click();
  expect(await (await nodeResolution).json()).toMatchObject({
    resolution: { resolvedAnchor: movedNodeAnchor, target: { startLine: 1, endLine: 2 } },
  });
  await expect(staleBanner).toHaveCount(0);
  await expect(page.locator("diffs-container")).toHaveAttribute("data-search-target-line", "1");

  await page.getByRole("tab", { name: fullStackTitle }).click();
  const edgeSource = viewer.locator(
    '.structure-edge-label[data-edge-id="detail-route-authenticates"] .structure-source.compact',
  );
  await edgeSource.click();
  const movedEdgeAnchor = {
    path: "src/http/routes/order-detail.ts",
    startLine: 3,
    endLine: 3,
  };
  const moveEdge = await page.request.post(
    `/api/fixture/structures/${fullStackStructureId}/source-lifecycle`,
    {
      data: {
        edgeId: "detail-route-authenticates",
        anchorIndex: 0,
        anchor: movedEdgeAnchor,
      },
    },
  );
  expect(moveEdge.ok()).toBe(true);
  await expect(staleBanner).toContainText("Structureが更新されています");
  const edgeResolution = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/anchors/resolve") &&
      url.searchParams.get("locatorKind") === "edge" &&
      url.searchParams.get("edgeId") === "detail-route-authenticates" &&
      url.searchParams.get("anchorIndex") === "0"
    );
  });
  await staleBanner.getByRole("button", { name: "最新へ再解決" }).click();
  expect(await (await edgeResolution).json()).toMatchObject({
    resolution: { resolvedAnchor: movedEdgeAnchor, target: { startLine: 3, endLine: 3 } },
  });
  await expect(staleBanner).toHaveCount(0);

  await page.getByRole("tab", { name: fullStackTitle }).click();
  await viewer.getByRole("button", { name: "表示中を収める", exact: true }).click();
  await viewer
    .locator('.structure-node[data-node-id="order-query-cache"] > .structure-source.compact')
    .click();
  const removeNode = await page.request.post(
    `/api/fixture/structures/${fullStackStructureId}/source-lifecycle`,
    { data: { removeNodeId: "order-query-cache" } },
  );
  expect(removeNode.ok()).toBe(true);
  await expect(staleBanner).toContainText("Structureの参照元claimが削除されています");
  await expect(staleBanner).toContainText("削除された参照元から最後に解決された状態です");
  await expect(staleBanner.getByRole("button", { name: "最新へ再解決" })).toHaveCount(0);
});

test("resolves Structure anchors to latest and preserves spatial context across navigation and update", async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/?pullRequestId=${pullRequestId}`);

  const structureFolder = page.getByRole("button", { name: "Structure 5", exact: true });
  await expect(structureFolder).toHaveAttribute("aria-expanded", "false");
  await structureFolder.click();
  await expect(structureFolder).toHaveAttribute("aria-expanded", "true");
  await structureFolder.press("Escape");
  await expect(structureFolder).toHaveAttribute("aria-expanded", "false");
  await structureFolder.click();
  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  await expect(reviewTree.locator(".review-tree-structure")).toHaveCount(5);
  await expect(reviewTree.getByRole("button", { name: primaryTitle })).toHaveAttribute(
    "title",
    `${primaryTitle}\nOrder creation from the authenticated HTTP boundary through domain decisions, remote side effects, transactional persistence, and event handoff; background delivery, recovery, and read paths are excluded.\nbbbbbbbb`,
  );
  await reviewTree.getByRole("button", { name: primaryTitle }).click();

  await expect(page.getByRole("tab", { name: primaryTitle })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const viewer = page.locator(`[data-structure-id="${primaryStructureId}"]`);
  await expect(viewer.getByRole("heading", { name: primaryTitle })).toBeVisible();
  await expect(viewer.getByText("16/16 Node · 19/19 Relation", { exact: true })).toBeVisible();
  await expect(viewer.locator('.structure-node[data-node-id="hub"]')).toHaveClass(/focused/);
  await expect(viewer.locator('.structure-node[data-node-id="http-routes"]')).toHaveAttribute(
    "data-origin-node",
    "true",
  );
  await expect(viewer.getByText("origin · Orders HTTP routes", { exact: true })).toBeVisible();
  await expect(viewer.locator(".structure-node")).toHaveCount(16);
  await expect(viewer.locator(".structure-edge")).toHaveCount(19);
  await expect(viewer.locator(".structure-edge-label")).toHaveCount(19);
  const initialViewportScale = Number(await viewer.getAttribute("data-viewport-scale"));
  expect(initialViewportScale).toBeGreaterThan(0);
  expect(initialViewportScale).toBeLessThanOrEqual(1.25);
  await expect(viewer.locator(".structure-minimap")).toBeVisible();
  await expect(viewer.locator(".structure-details")).toHaveCount(0);
  await viewer.getByRole("button", { name: "参照をコピー" }).click();
  await expect
    .poll(async () => await page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`rvw://structure/${primaryStructureId}`);

  const canvas = viewer.locator(".structure-canvas");
  await expectStructureNodesFullyVisible(viewer, [
    "http-controller",
    "hub",
    "authorization-policy",
  ]);
  await expect
    .poll(async () => {
      return await viewer.evaluate((element) => {
        const canvasBox = element
          .querySelector<HTMLElement>(".structure-canvas")!
          .getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>(".structure-node")].some((item) => {
          const box = item.getBoundingClientRect();
          return (
            box.left < canvasBox.left ||
            box.right > canvasBox.right ||
            box.top < canvasBox.top ||
            box.bottom > canvasBox.bottom
          );
        });
      });
    })
    .toBe(true);
  const initialHub = viewer.locator('.structure-node[data-node-id="hub"]');
  await expect(initialHub.locator(".structure-source-identity")).toBeVisible();
  await expect(initialHub.locator(".structure-node-description")).toBeVisible();

  await openStructure(page, secondaryTitle);
  const secondaryViewer = page.locator(`[data-structure-id="${secondaryStructureId}"]`);
  await expect(secondaryViewer.locator(".structure-node")).toHaveCount(3);
  await expect(secondaryViewer.locator(".structure-edge")).toHaveCount(2);
  await openStructure(page, primaryTitle);
  await expect(viewer.locator('.structure-node[data-node-id="hub"]')).toHaveClass(/focused/);
  await expect(viewer.locator(".structure-node")).toHaveCount(16);
  await expect(viewer.locator(".structure-edge")).toHaveCount(19);

  await page.setViewportSize({ width: 900, height: 700 });
  await expectFocusedNodeVisible(viewer);
  await page.setViewportSize({ width: 1280, height: 720 });

  const hubNode = viewer.locator('.structure-node[data-node-id="hub"]');
  const hubTitle = hubNode.locator(".structure-node-title");
  const hubIdentity = hubNode.locator(".structure-source-identity");
  const hubTitleText = hubTitle.locator(".structure-node-title-text");
  const hubSourceAction = viewer.locator(
    '.structure-node[data-node-id="hub"] > .structure-source.compact',
  );
  await expect(hubIdentity).toHaveAttribute(
    "data-source-path",
    "src/application/orders/create-order.ts",
  );
  await expect(hubIdentity.locator(".structure-source-name")).toHaveText("orders/create-order.ts");
  await expect(hubIdentity.locator(".file-change-icon")).toHaveAttribute(
    "data-change-kind",
    "modified",
  );
  await expect(hubNode).toHaveAttribute("data-node-notation", "class");
  await expect(viewer.locator('.structure-node[data-node-id="outbox"]')).toHaveAttribute(
    "data-node-notation",
    "database",
  );
  expect(
    await hubIdentity
      .locator(":scope > *")
      .evaluateAll((children) =>
        children.map((child) =>
          child.classList.contains("tree-entry-icon")
            ? "file"
            : child.classList.contains("file-change-icon")
              ? "change"
              : child.classList.contains("structure-source-name")
                ? "name"
                : "other",
        ),
      ),
  ).toEqual(["file", "change", "name"]);
  const [identityBox, titleTextBox, sourceActionBox] = await Promise.all([
    hubIdentity.boundingBox(),
    hubTitleText.boundingBox(),
    hubSourceAction.boundingBox(),
  ]);
  expect(identityBox).not.toBeNull();
  expect(titleTextBox).not.toBeNull();
  expect(sourceActionBox).not.toBeNull();
  expect(identityBox!.y + identityBox!.height).toBeLessThanOrEqual(titleTextBox!.y + 1);
  const currentViewportScale = Number(await viewer.getAttribute("data-viewport-scale"));
  expect(titleTextBox!.width / currentViewportScale).toBeGreaterThan(130);
  expect(sourceActionBox!.x).toBeGreaterThan(titleTextBox!.x);

  await hubNode.click();
  await expect(hubNode).toHaveClass(/focused/);

  await viewer.getByRole("button", { name: "表示中を収める" }).click();
  await expect
    .poll(async () => {
      return await viewer.evaluate((element) => {
        const canvasBox = element
          .querySelector<HTMLElement>(".structure-canvas")!
          .getBoundingClientRect();
        return [
          ...element.querySelectorAll<HTMLElement>(".structure-node, .structure-edge-label"),
        ].every((item) => {
          const box = item.getBoundingClientRect();
          return (
            box.left >= canvasBox.left - 1 &&
            box.right <= canvasBox.right + 1 &&
            box.top >= canvasBox.top - 1 &&
            box.bottom <= canvasBox.bottom + 1
          );
        });
      });
    })
    .toBe(true);
  await expect(hubIdentity).toBeVisible();
  await expect(hubNode.locator(".structure-node-description")).toBeVisible();

  await viewer.locator('.structure-node[data-node-id="idempotency-store"]').click();
  await viewer.getByRole("button", { name: "表示中を収める" }).click();
  await expect
    .poll(async () => {
      const [canvasBounds, loopBounds, labelBounds] = await Promise.all([
        canvas.boundingBox(),
        viewer.locator('.structure-edge[data-edge-id="idempotency-reuses-result"]').boundingBox(),
        viewer
          .locator('.structure-edge-label[data-edge-id="idempotency-reuses-result"]')
          .boundingBox(),
      ]);
      if (!canvasBounds || !loopBounds || !labelBounds) return false;
      return [loopBounds, labelBounds].every(
        (bounds) =>
          bounds.x >= canvasBounds.x - 1 &&
          bounds.y >= canvasBounds.y - 1 &&
          bounds.x + bounds.width <= canvasBounds.x + canvasBounds.width + 1 &&
          bounds.y + bounds.height <= canvasBounds.y + canvasBounds.height + 1,
      );
    })
    .toBe(true);
  await hubNode.click();

  const firstEdge = viewer.locator('.structure-edge[data-edge-id="controller-executes-handler"]');
  const firstEdgeArrow = viewer.locator(
    '.structure-edge-arrow-carrier[data-edge-arrow-id="controller-executes-handler"]',
  );
  await expect(firstEdge).toHaveAttribute("d", / C /);
  await expect(firstEdge).not.toHaveAttribute("marker-end", /.+/u);
  await expect(firstEdgeArrow).toHaveAttribute("marker-end", /structure-left-.+-arrow/);
  await expect(firstEdge).toHaveAttribute("data-source-change-kind", "modified");
  const endpointsMeetNodeBoundaries = await firstEdge.evaluate((element) => {
    const path = element as SVGPathElement;
    const viewerElement = path.closest(".structure-viewer")!;
    const controller = viewerElement.querySelector<HTMLElement>(
      '.structure-node[data-node-id="http-controller"]',
    )!;
    const hub = viewerElement.querySelector<HTMLElement>('.structure-node[data-node-id="hub"]')!;
    const pointOnBoundary = (x: number, y: number, node: HTMLElement): boolean => {
      const left = Number.parseFloat(node.style.left);
      const top = Number.parseFloat(node.style.top);
      const right = left + node.offsetWidth;
      const bottom = top + node.offsetHeight;
      const epsilon = 0.01;
      const withinX = x >= left - epsilon && x <= right + epsilon;
      const withinY = y >= top - epsilon && y <= bottom + epsilon;
      const onVertical = Math.abs(x - left) <= epsilon || Math.abs(x - right) <= epsilon;
      const onHorizontal = Math.abs(y - top) <= epsilon || Math.abs(y - bottom) <= epsilon;
      return withinX && withinY && (onVertical || onHorizontal);
    };
    return (
      pointOnBoundary(Number(path.dataset.startX), Number(path.dataset.startY), controller) &&
      pointOnBoundary(Number(path.dataset.endX), Number(path.dataset.endY), hub)
    );
  });
  expect(endpointsMeetNodeBoundaries).toBe(true);
  await expect(viewer.locator(".structure-edges marker").first()).toHaveAttribute("refX", "12");

  const firstEdgeLabel = viewer.locator(
    '.structure-edge-label[data-edge-id="controller-executes-handler"]',
  );
  await expect(firstEdgeLabel).toHaveAttribute("data-source-anchor-count", "2");
  await expect(firstEdgeLabel.locator(".structure-source-identity")).toHaveCount(0);
  await expect(firstEdgeLabel.locator(".structure-edge-sources")).toBeVisible();
  await expect(firstEdgeLabel.locator(".structure-edge-select")).toHaveAccessibleName(
    "Create order controller から Create order へ: HTTP commandとして実行する · explanation backbone relation",
  );

  const graphCollisions = await viewer.evaluate((element) => {
    const boxes = (selector: string) =>
      [...element.querySelectorAll<HTMLElement>(selector)].map((item) => ({
        id: item.dataset.edgeId ?? item.dataset.nodeId,
        rect: item.getBoundingClientRect(),
      }));
    const labels = boxes(".structure-edge-label");
    const nodes = boxes(".structure-node");
    const displacedLabelIds = [
      ...element.querySelectorAll<HTMLElement>(
        '.structure-edge-label[data-label-displaced="true"]',
      ),
    ]
      .map((label) => label.dataset.edgeId!)
      .sort();
    const leaders = [...element.querySelectorAll<SVGGElement>(".structure-edge-label-leader")];
    const leaderIds = leaders.map((leader) => leader.dataset.edgeId!).sort();
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
      displacedLabelIds,
      leaderIds,
      leadersAreVisible: leaders.every((leader) => {
        const line = leader.querySelector<SVGPathElement>(".structure-edge-label-leader-line");
        const halo = leader.querySelector<SVGPathElement>(".structure-edge-label-leader-halo");
        const anchor = leader.querySelector<SVGCircleElement>(
          ".structure-edge-label-leader-anchor",
        );
        if (!line || !halo || !anchor) return false;
        const lineStyle = getComputedStyle(line);
        const haloStyle = getComputedStyle(halo);
        return (
          line.getTotalLength() > 0 &&
          lineStyle.stroke !== "none" &&
          lineStyle.strokeDasharray !== "none" &&
          Number.parseFloat(haloStyle.strokeWidth) >= 4 &&
          Number.parseFloat(anchor.getAttribute("r") ?? "0") > 0 &&
          Number(lineStyle.opacity) > 0
        );
      }),
    };
  });
  expect(graphCollisions.labelNodes).toEqual([]);
  expect(graphCollisions.labelPairs).toEqual([]);
  expect(graphCollisions.allEdgesAreCurved).toBe(true);
  expect(graphCollisions.displacedLabelIds).not.toEqual([]);
  expect(graphCollisions.leaderIds).toEqual(graphCollisions.displacedLabelIds);
  expect(graphCollisions.leadersAreVisible).toBe(true);

  // Exercise the visible transformed control with a real pointer. Locator.click()
  // first scrolls an element's untransformed layout box into view, which is not a
  // browser interaction a reviewer can perform and would introduce a second camera.
  const firstEdgeSelect = firstEdgeLabel.locator(".structure-edge-select");
  const firstEdgeSelectBounds = await firstEdgeSelect.boundingBox();
  expect(firstEdgeSelectBounds).not.toBeNull();
  await page.mouse.click(
    firstEdgeSelectBounds!.x + firstEdgeSelectBounds!.width / 2,
    firstEdgeSelectBounds!.y + firstEdgeSelectBounds!.height / 2,
  );
  await expect(firstEdge).toHaveClass(/selected/);
  await expect(viewer.locator(".structure-edge.muted")).not.toHaveCount(0);
  await expect(viewer.locator(".structure-edge-label.muted")).not.toHaveCount(0);
  await expect(firstEdgeSelect).toHaveAttribute("aria-pressed", "true");
  await expect(firstEdgeSelect).toBeFocused();
  await expect
    .poll(async () =>
      canvas.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop })),
    )
    .toEqual({ left: 0, top: 0 });
  await expect(viewer.locator('.structure-node[data-node-id="http-controller"]')).toHaveClass(
    /edge-endpoint/,
  );
  await expect(viewer.locator('.structure-node[data-node-id="hub"]')).toHaveClass(/edge-endpoint/);
  await firstEdgeLabel.locator(".structure-edge-sources > summary").click();
  await expect(firstEdgeLabel.locator(".structure-edge-source-menu .structure-source")).toHaveCount(
    2,
  );
  await firstEdgeSelect.focus();
  await firstEdgeSelect.press("Enter");
  await expect(firstEdge).not.toHaveClass(/selected/);

  await viewer.locator('.structure-node[data-node-id="http-controller"]').click();
  await expect(viewer.locator('.structure-node[data-node-id="http-controller"]')).toHaveClass(
    /focused/,
  );
  await viewer.locator('.structure-node[data-node-id="hub"]').click();
  await expect(viewer.locator('.structure-node[data-node-id="hub"]')).toHaveClass(/focused/);

  const allLayoutEntries = await viewer
    .locator(".structure-node")
    .evaluateAll((nodes): Array<[string, [string, string]]> =>
      nodes.map((node) => [
        (node as HTMLElement).dataset.nodeId ?? "",
        [(node as HTMLElement).style.left, (node as HTMLElement).style.top],
      ]),
    );
  const allLayout = Object.fromEntries(allLayoutEntries);
  const viewportBeforeNeighborhood = await viewer
    .locator(".structure-world")
    .evaluate((element) => (element as HTMLElement).style.transform);
  await viewer.getByRole("button", { name: "2-hop", exact: true }).click();
  await expect(viewer.getByText("14/16 Node · 16/19 Relation", { exact: true })).toBeVisible();
  await expect(viewer.locator('.structure-node[data-node-id="pricing-policy"]')).toBeVisible();
  const localViewport = await viewer
    .locator(".structure-world")
    .evaluate((element) => (element as HTMLElement).style.transform);
  expect(localViewport).toBe(viewportBeforeNeighborhood);
  await viewer.getByRole("button", { name: "全体", exact: true }).click();
  await expect(viewer.getByText("16/16 Node · 19/19 Relation", { exact: true })).toBeVisible();
  await expect(viewer.locator(".structure-edge-label")).toHaveCount(19);
  await expect
    .poll(
      async () =>
        await viewer
          .locator(".structure-world")
          .evaluate((element) => (element as HTMLElement).style.transform),
    )
    .toBe(localViewport);
  await expect
    .poll(async () => {
      const entries = await viewer
        .locator(".structure-node")
        .evaluateAll((nodes): Array<[string, [string, string]]> =>
          nodes.map((node) => [
            (node as HTMLElement).dataset.nodeId ?? "",
            [(node as HTMLElement).style.left, (node as HTMLElement).style.top],
          ]),
        );
      return Object.fromEntries(entries);
    })
    .toEqual(allLayout);
  await viewer.getByRole("button", { name: "focusを解除" }).click();
  await expect(viewer.locator(".structure-node.focused")).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "1-hop", exact: true })).toBeDisabled();
  await expect(viewer.locator(".structure-edge-label")).toHaveCount(19);
  await viewer.locator('.structure-node[data-node-id="hub"]').click();
  await canvas.focus();
  await page.keyboard.press("Escape");
  await expect(viewer.locator(".structure-node.focused")).toHaveCount(0);
  await viewer.locator('.structure-node[data-node-id="hub"]').click();
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
  const outerViewportBeforeWheel = await page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    visualScale: window.visualViewport?.scale ?? 1,
  }));
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
  expect(Number(await viewer.getAttribute("data-viewport-scale"))).toBeGreaterThan(
    Number(scaleBeforePan) * 1.2,
  );
  expect(
    await page.evaluate(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      visualScale: window.visualViewport?.scale ?? 1,
    })),
  ).toEqual(outerViewportBeforeWheel);

  const hub = viewer.locator('.structure-node[data-node-id="hub"]');
  await viewer.getByRole("button", { name: "focusを中央へ", exact: true }).click();
  const beforeDrag = await hub.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  }));
  await dragVisibleStructureNode(page, viewer, hub);
  let dragged = await hub.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  }));
  expect(dragged).not.toEqual(beforeDrag);
  const screenCenterBeforeReset = await hub.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    return {
      x: Math.round(rectangle.left + rectangle.width / 2),
      y: Math.round(rectangle.top + rectangle.height / 2),
    };
  });
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
  await expect
    .poll(async () => {
      const rectangle = await hub.boundingBox();
      if (!rectangle) return false;
      const center = {
        x: Math.round(rectangle.x + rectangle.width / 2),
        y: Math.round(rectangle.y + rectangle.height / 2),
      };
      return (
        Math.abs(center.x - screenCenterBeforeReset.x) <= 1 &&
        Math.abs(center.y - screenCenterBeforeReset.y) <= 1
      );
    })
    .toBe(true);
  await dragVisibleStructureNode(page, viewer, hub);
  dragged = await hub.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  }));
  expect(dragged).not.toEqual(beforeDrag);

  const commitSelection = await page
    .getByRole("button", { name: /^対象commit:/ })
    .getAttribute("aria-label");
  await expect(hubSourceAction).toHaveAttribute(
    "aria-label",
    "src/application/orders/create-order.ts:8-50を開く",
  );
  const resolutionResponsePromise = page.waitForResponse((response) =>
    response
      .url()
      .includes(`/structures/${primaryStructureId}/anchors/resolve?locatorKind=node&nodeId=hub`),
  );
  await hubSourceAction.click();
  const resolutionResponse = await resolutionResponsePromise;
  expect(resolutionResponse.ok()).toBe(true);
  expect(await resolutionResponse.json()).toMatchObject({
    resolution: {
      outcome: "latest",
      anchorSourceOid: "b".repeat(40),
      latestHeadOid: "c".repeat(40),
      target: {
        sourceOid: "c".repeat(40),
        path: "src/application/orders/create-order.ts",
        startLine: 8,
        endLine: 50,
      },
    },
  });
  await expect(
    page.getByRole("tab", { name: "src/application/orders/create-order.ts" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('.document-pane[data-pane="left"] diffs-container')).toHaveAttribute(
    "data-search-target-line",
    "8",
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
  await hubSourceAction.click({ modifiers: ["Meta"] });
  await expect(page.locator('.document-pane[data-pane="right"]')).toBeVisible();
  await expect(
    page
      .locator('.document-pane[data-pane="right"]')
      .getByRole("tab", { name: "src/application/orders/create-order.ts" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator('.document-pane[data-pane="left"]').getByRole("tab", { name: primaryTitle }),
  ).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(async () => {
      const [viewerBox, toolbarBox, canvasBox, focusedBox] = await Promise.all([
        viewer.boundingBox(),
        viewer.locator(".structure-toolbar").boundingBox(),
        viewer.locator(".structure-canvas").boundingBox(),
        viewer.locator(".structure-node.focused").boundingBox(),
      ]);
      if (!viewerBox || !toolbarBox || !canvasBox || !focusedBox) return false;
      const toolbarIsSingleRow = await viewer
        .locator(".structure-toolbar")
        .evaluate((element) => element.getBoundingClientRect().height <= 36);
      return (
        toolbarIsSingleRow &&
        toolbarBox.x + toolbarBox.width <= viewerBox.x + viewerBox.width + 1 &&
        toolbarBox.y >= canvasBox.y - 1 &&
        toolbarBox.y + toolbarBox.height <= canvasBox.y + canvasBox.height + 1 &&
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
  await expect(rightViewer.getByText("16/16 Node · 19/19 Relation", { exact: true })).toBeVisible();
  await expect(leftViewer.getByText("9/16 Node · 10/19 Relation", { exact: true })).toBeVisible();
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
  const updatedTitle = "Order placement behavior updated";
  await expect(leftViewer.locator('.structure-node[data-node-id="hub"]')).toContainText(
    "Create order updated",
  );
  await expect(rightViewer.locator('.structure-node[data-node-id="hub"]')).toContainText(
    "Create order updated",
  );
  await expect(leftViewer.getByRole("status")).toContainText("Structureが更新されました");
  await expect(rightViewer.getByRole("status")).toContainText("Structureが更新されました");
  await expect(leftViewer.locator('.structure-node[data-node-id="new-neighbor"]')).toBeVisible();
  await expect(rightViewer.locator('.structure-node[data-node-id="new-neighbor"]')).toBeVisible();
  const updatedLabelNodeOverlaps = await rightViewer.evaluate((element) => {
    const nodes = [...element.querySelectorAll<HTMLElement>(".structure-node")].map((node) => ({
      id: node.dataset.nodeId,
      rect: node.getBoundingClientRect(),
    }));
    return [...element.querySelectorAll<HTMLElement>(".structure-edge-label")].flatMap((label) => {
      const labelRect = label.getBoundingClientRect();
      return nodes
        .filter(
          ({ rect }) =>
            labelRect.right > rect.left &&
            labelRect.left < rect.right &&
            labelRect.bottom > rect.top &&
            labelRect.top < rect.bottom,
        )
        .map(({ id }) => `${label.dataset.edgeId}:${id}`);
    });
  });
  expect(updatedLabelNodeOverlaps).toEqual([]);
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
    { data: { clearFocus: true, replacementOrigin: "http-controller" } },
  );
  expect(clearFocus.ok()).toBe(true);
  await expect(
    page.getByRole("tab", { name: "Order placement behavior without focus" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(viewer.locator(".structure-node.focused")).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "全体", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(viewer.getByRole("button", { name: "1-hop", exact: true })).toBeDisabled();
  await expect(viewer.getByRole("button", { name: "2-hop", exact: true })).toBeDisabled();
  await expect(viewer.getByText("4/4 Node · 3/3 Relation", { exact: true })).toBeVisible();

  await openStructure(page, secondaryTitle);
  await expect(page.getByRole("tab", { name: secondaryTitle })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    secondaryViewer.locator('.structure-node[data-node-id="payment-reconciliation"]'),
  ).toHaveClass(/focused/);
  await expect(secondaryViewer.getByRole("button", { name: "全体", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(secondaryViewer.getByRole("button", { name: "1-hop", exact: true })).toBeEnabled();
  await expect(secondaryViewer.locator(".structure-edge-label")).toHaveCount(2);
  await secondaryViewer.getByRole("button", { name: "表示中を収める" }).click();
  await page.setViewportSize({ width: 900, height: 700 });
  const [headerBox, guideBox, toolbarBox, canvasBox, viewerBox] = await Promise.all([
    secondaryViewer.locator(".structure-header").boundingBox(),
    secondaryViewer.locator(".structure-presentation-overview").boundingBox(),
    secondaryViewer.locator(".structure-toolbar").boundingBox(),
    secondaryViewer.locator(".structure-canvas-shell").boundingBox(),
    secondaryViewer.boundingBox(),
  ]);
  expect(headerBox).not.toBeNull();
  expect(guideBox).not.toBeNull();
  expect(toolbarBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(viewerBox).not.toBeNull();
  expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(
    viewerBox!.x + viewerBox!.width + 1,
  );
  expect(headerBox!.height).toBeLessThanOrEqual(44);
  expect(toolbarBox!.height).toBeLessThanOrEqual(36);
  expect(toolbarBox!.y).toBeGreaterThanOrEqual(canvasBox!.y - 1);
  expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(
    canvasBox!.y + canvasBox!.height + 1,
  );
  expect(canvasBox!.height).toBeGreaterThanOrEqual(
    viewerBox!.height - headerBox!.height - guideBox!.height - 2,
  );
  expect(canvasBox!.y + canvasBox!.height).toBeLessThanOrEqual(
    viewerBox!.y + viewerBox!.height + 1,
  );
  let structureReferenceIndexRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === `/api/pull-requests/${pullRequestId}/structure-reference-index`
    ) {
      structureReferenceIndexRequests += 1;
    }
  });
  await page
    .getByRole("button", { name: "src/fixture.ts", exact: true })
    .click({ modifiers: ["Meta"] });
  const rightFilePane = page.locator('.document-pane[data-pane="right"]');
  await expect(
    rightFilePane.getByRole("tab", { name: "src/fixture.ts", exact: true }),
  ).toBeVisible();
  await expect(
    rightFilePane.getByRole("button", {
      name: /このファイルを参照するStructure|このレビュー版では、このファイルをNodeから参照するStructureはありません/u,
    }),
  ).toBeVisible();
  const requestsBeforeDelete = structureReferenceIndexRequests;
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator(`[data-structure-id="${secondaryStructureId}"]`)
    .getByRole("button", {
      name: "削除",
    })
    .click();
  await expect(page.getByRole("tab", { name: secondaryTitle })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Structure 4", exact: true })).toBeVisible();
  await expect.poll(() => structureReferenceIndexRequests).toBe(requestsBeforeDelete + 1);
  await page.waitForTimeout(250);
  expect(structureReferenceIndexRequests).toBe(requestsBeforeDelete + 1);
});

test("rebases a cached Structure session when authored presentation changes while its tab is closed", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, fullStackTitle);
  const viewer = page.locator(`[data-structure-id="${fullStackStructureId}"]`);
  const focusedNode = viewer.locator('.structure-node[data-node-id="order-response-presenter"]');
  await viewer.getByRole("button", { name: "表示中を収める", exact: true }).click();
  await focusedNode.click();
  await viewer.getByRole("button", { name: "2-hop", exact: true }).click();
  await viewer.getByRole("button", { name: "focusを中央へ", exact: true }).click();
  await viewer.getByRole("button", { name: "拡大", exact: true }).click();
  await dragVisibleStructureNode(page, viewer, focusedNode);

  const before = await focusedNode.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    return {
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
      screenCenter: {
        x: rectangle.left + rectangle.width / 2,
        y: rectangle.top + rectangle.height / 2,
      },
    };
  });
  await expect(focusedNode).toHaveAttribute("data-region-id", "backend-read-and-present");
  await expect(focusedNode).toHaveAttribute("data-region-label", "Read and present");
  await expect(viewer.locator(".structure-region-member")).toHaveCount(0);
  const scaleBefore = await viewer.getAttribute("data-viewport-scale");
  const detailResponse = await page.request.get(
    `/api/pull-requests/${pullRequestId}/structures/${fullStackStructureId}`,
  );
  expect(detailResponse.ok()).toBe(true);
  const detail = (await detailResponse.json()) as {
    structure: {
      presentation: {
        thesis: string;
        startNodeId: string;
        primaryBackbone: { edgeIds: string[] };
        regions: Array<{ id: string; label: string; summary: string; nodeIds: string[] }>;
      };
    };
  };
  const previousPresentation = detail.structure.presentation;
  const updatedTitle = "Order detail response rendering reordered";

  await page.getByRole("button", { name: `${fullStackTitle}を閉じる`, exact: true }).click();
  await expect(viewer).toHaveCount(0);
  const updateResponse = await page.request.post(
    `/api/fixture/structures/${fullStackStructureId}/update`,
    {
      data: {
        title: updatedTitle,
        presentation: {
          thesis: `${previousPresentation.thesis} Authorial orientation updated.`,
          startNodeId: "order-detail-page",
          primaryBackbone: previousPresentation.primaryBackbone,
          regions: [...previousPresentation.regions].reverse(),
        },
      },
    },
  );
  expect(updateResponse.ok()).toBe(true);
  await expect(
    page
      .getByRole("navigation", { name: "レビュー文書" })
      .getByRole("button", { name: updatedTitle, exact: true }),
  ).toBeVisible();

  await openStructure(page, updatedTitle);
  const restoredViewer = page.locator(`[data-structure-id="${fullStackStructureId}"]`);
  const restoredFocus = restoredViewer.locator(
    '.structure-node[data-node-id="order-response-presenter"]',
  );
  await expect(restoredFocus).toHaveClass(/focused/);
  await expect(restoredViewer.getByRole("button", { name: "2-hop", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(restoredViewer).toHaveAttribute("data-viewport-scale", scaleBefore!);
  await expect(restoredFocus).toHaveAttribute("data-region-id", "backend-read-and-present");
  await expect(restoredFocus).toHaveAttribute("data-region-label", "Read and present");
  await expect
    .poll(async () => {
      const rectangle = await restoredFocus.boundingBox();
      if (!rectangle) return false;
      const center = {
        x: Math.round(rectangle.x + rectangle.width / 2),
        y: Math.round(rectangle.y + rectangle.height / 2),
      };
      return (
        Math.abs(center.x - Math.round(before.screenCenter.x)) <= 1 &&
        Math.abs(center.y - Math.round(before.screenCenter.y)) <= 1
      );
    })
    .toBe(true);
  expect(
    await restoredFocus.evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    })),
  ).not.toEqual({ left: before.left, top: before.top });
});

test("shows thesis and an attention start without manufacturing a backbone or regions", async ({
  page,
}) => {
  const detailResponse = await page.request.get(
    `/api/pull-requests/${pullRequestId}/structures/${fullStackStructureId}`,
  );
  expect(detailResponse.ok()).toBe(true);
  const detail = (await detailResponse.json()) as {
    structure: { title: string; presentation: unknown; nodes: unknown[]; edges: unknown[] };
  };
  const thesis = "The shared response contract is the best place to begin free exploration.";
  const updateResponse = await page.request.post(
    `/api/fixture/structures/${fullStackStructureId}/update`,
    {
      data: {
        presentation: {
          thesis,
          startNodeId: "order-detail-contract",
          primaryBackbone: null,
          regions: [],
        },
      },
    },
  );
  expect(updateResponse.ok()).toBe(true);

  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await openStructure(page, detail.structure.title);
    const viewer = page.locator(`[data-structure-id="${fullStackStructureId}"]`);
    const overview = viewer.locator(".structure-presentation-overview");
    const startNode = viewer.locator('.structure-node[data-node-id="order-detail-contract"]');

    await expect(viewer).toHaveAttribute("data-has-presentation", "true");
    await expect(viewer).toHaveAttribute("data-view-mode", "graph");
    await expect(overview.locator(".structure-presentation-overview-thesis")).toContainText(thesis);
    await expect(overview.getByRole("button", { name: /Authorial start node/u })).toBeVisible();
    await expect(overview.getByRole("button", { name: /Core relations/u })).toHaveCount(0);
    await expect(overview.locator(".structure-region-map")).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "Regions", exact: true })).toBeDisabled();
    await expect(viewer.locator(".structure-regions-canvas")).toHaveCount(0);
    await expect(startNode).toHaveClass(/focused/);
    await expect(startNode).toHaveAttribute("data-presentation-start-node", "true");
    await expect(viewer.locator('.structure-node[data-primary-backbone="true"]')).toHaveCount(0);
    await expect(viewer.locator(".structure-region-member")).toHaveCount(0);
    await expect(viewer.locator(".structure-minimap-presentation-start")).toHaveCount(1);
    await expect(viewer.locator(".structure-minimap-primary-backbone")).toHaveCount(0);
    await expect(viewer.locator(".structure-node")).toHaveCount(detail.structure.nodes.length);
    await expect(viewer.locator(".structure-edges .structure-edge")).toHaveCount(
      detail.structure.edges.length,
    );

    await viewer
      .locator('.structure-node[data-node-id="order-detail-page"] .structure-node-focus')
      .click();
    await overview
      .locator('.structure-presentation-overview-node[data-node-id="order-detail-contract"]')
      .click();
    await expect(startNode).toHaveClass(/focused/);
  } finally {
    const restoreResponse = await page.request.post(
      `/api/fixture/structures/${fullStackStructureId}/update`,
      { data: { presentation: detail.structure.presentation } },
    );
    expect(restoreResponse.ok()).toBe(true);
  }
});

test("keeps the topology-only fallback in Graph with Regions unavailable", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, topologyOnlyTitle);
  const viewer = page.locator(`[data-structure-id="${topologyOnlyStructureId}"]`);

  await expect(viewer).toHaveAttribute("data-view-mode", "graph");
  await expect(viewer.locator(".structure-presentation-overview")).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Graph", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(viewer.getByRole("button", { name: "Regions", exact: true })).toBeDisabled();
  await expect(viewer.locator(".structure-regions-canvas")).toHaveCount(0);
  await expect(viewer.locator(".structure-canvas")).toBeVisible();
});
