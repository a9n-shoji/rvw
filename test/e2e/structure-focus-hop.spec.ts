import { expect, test, type Locator, type Page } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const structureId = "80000000-0000-4000-8000-000000000001";

async function openOrderPlacementStructure(page: Page): Promise<void> {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const folder = page.getByRole("button", { name: /^Structure \d+$/u });
  if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
  await page
    .getByRole("navigation", { name: "レビュー文書" })
    .getByRole("button", { name: "Order placement behavior", exact: true })
    .click();
}

async function graphDomState(viewer: Locator) {
  return await viewer.evaluate((element) => {
    const sortedIds = (selector: string, attribute: string): string[] =>
      [...element.querySelectorAll<HTMLElement | SVGElement>(selector)]
        .map((target) => target.getAttribute(attribute))
        .filter((value): value is string => value !== null)
        .sort((left, right) => left.localeCompare(right, "en"));
    const nodePositions = [...element.querySelectorAll<HTMLElement>(".structure-node")]
      .map((node) => ({
        id: node.dataset.nodeId ?? "",
        left: node.style.left,
        top: node.style.top,
      }))
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    return {
      nodeIds: sortedIds(".structure-node", "data-node-id"),
      edgeIds: sortedIds(".structure-edge", "data-edge-id"),
      labelEdgeIds: sortedIds(".structure-edge-label", "data-edge-id"),
      nodePositions,
      worldTransform:
        element.querySelector<HTMLElement>(".structure-world")?.style.transform ?? null,
      depth: element.getAttribute("data-neighborhood-depth"),
      localCenterId: element.getAttribute("data-local-center-id"),
    };
  });
}

async function minimapBackboneState(viewer: Locator) {
  return await viewer.locator(".structure-minimap").evaluate((element) => ({
    backbone: [...element.querySelectorAll<SVGLineElement>(".structure-minimap-primary-backbone")]
      .map((edge) => ({
        id: edge.dataset.edgeId ?? "",
        x1: edge.getAttribute("x1"),
        y1: edge.getAttribute("y1"),
        x2: edge.getAttribute("x2"),
        y2: edge.getAttribute("y2"),
      }))
      .sort((left, right) => left.id.localeCompare(right.id, "en")),
    nodeCount: element.querySelectorAll("circle:not(.structure-minimap-presentation-start)").length,
  }));
}

test("renders a stable local 2-hop graph while keeping selection separate from its center", async ({
  page,
}) => {
  await openOrderPlacementStructure(page);
  const viewer = page.locator(`[data-structure-id="${structureId}"]`);
  const world = viewer.locator(".structure-world");
  const hub = viewer.locator('.structure-node[data-node-id="hub"]');
  const orderAggregate = viewer.locator('.structure-node[data-node-id="order-aggregate"]');

  await expect(hub).toHaveClass(/(?:^|\s)focused(?:\s|$)/u);
  await expect(viewer.locator(".structure-node")).toHaveCount(16);
  await expect(viewer.locator(".structure-edge")).toHaveCount(19);
  await expect(viewer.locator(".structure-edge-label")).toHaveCount(19);
  await viewer.getByRole("button", { name: "表示中を収める", exact: true }).click();
  const fullState = await graphDomState(viewer);
  const fullMinimap = await minimapBackboneState(viewer);
  await expect(viewer.locator(".structure-minimap-viewport")).toHaveAttribute(
    "data-map-frame",
    "viewport",
  );
  expect(fullMinimap.backbone).toHaveLength(10);
  expect(fullMinimap.nodeCount).toBe(16);

  await viewer.getByRole("button", { name: "2-hop", exact: true }).click();
  await expect(viewer).toHaveAttribute("data-neighborhood-depth", "2");
  await expect(viewer).toHaveAttribute("data-local-center-id", "hub");
  await expect(world).not.toHaveClass(/layout-transition/u);
  await expect(viewer.locator(".structure-minimap-viewport")).toHaveAttribute(
    "data-map-frame",
    "local-footprint",
  );

  await expect(viewer.locator(".structure-node")).toHaveCount(14);
  await expect(viewer.locator(".structure-edge")).toHaveCount(16);
  await expect(viewer.locator(".structure-edge-label")).toHaveCount(16);
  await expect(viewer.locator('.structure-node[data-node-id="auth-middleware"]')).toHaveCount(0);
  await expect(viewer.locator('.structure-node[data-node-id="database-schema"]')).toHaveCount(0);
  await expect(viewer.locator('.structure-edge[data-edge-id="orders-use-schema"]')).toHaveCount(0);
  await expect(
    viewer.locator('.structure-edge-arrow-carrier[data-edge-arrow-id="orders-use-schema"]'),
  ).toHaveCount(0);
  await expect(
    viewer.locator('.structure-edge-label[data-edge-id="orders-use-schema"]'),
  ).toHaveCount(0);
  await expect(
    viewer.locator('.structure-edge-label-leader[data-edge-id="orders-use-schema"]'),
  ).toHaveCount(0);

  await expect(hub).toHaveClass(/(?:^|\s)local-center(?:\s|$)/u);
  await expect(hub).toHaveClass(/(?:^|\s)focused(?:\s|$)/u);
  await expect(hub).toHaveAttribute("data-local-center", "true");
  const beforeSelection = await graphDomState(viewer);
  expect(await minimapBackboneState(viewer)).toEqual(fullMinimap);

  await orderAggregate.click();
  await expect(orderAggregate).toHaveClass(/(?:^|\s)focused(?:\s|$)/u);
  await expect(orderAggregate).not.toHaveClass(/(?:^|\s)local-center(?:\s|$)/u);
  await expect(orderAggregate).not.toHaveAttribute("data-local-center", "true");
  await expect(hub).not.toHaveClass(/(?:^|\s)focused(?:\s|$)/u);
  await expect(hub).toHaveClass(/(?:^|\s)local-center(?:\s|$)/u);
  await expect(hub).toHaveAttribute("data-local-center", "true");
  await expect(viewer.locator(".structure-minimap circle.focused")).toHaveCount(1);
  await expect(viewer.locator(".structure-minimap circle.local-center")).toHaveCount(1);

  const afterSelection = await graphDomState(viewer);
  expect(afterSelection.nodeIds).toEqual(beforeSelection.nodeIds);
  expect(afterSelection.edgeIds).toEqual(beforeSelection.edgeIds);
  expect(afterSelection.labelEdgeIds).toEqual(beforeSelection.labelEdgeIds);
  expect(afterSelection.nodePositions).toEqual(beforeSelection.nodePositions);
  expect(afterSelection.worldTransform).toBe(beforeSelection.worldTransform);
  expect(afterSelection.depth).toBe("2");
  expect(afterSelection.localCenterId).toBe("hub");
  expect(await minimapBackboneState(viewer)).toEqual(fullMinimap);

  await viewer.getByRole("button", { name: "全体", exact: true }).click();
  await expect(viewer).toHaveAttribute("data-neighborhood-depth", "all");
  await expect(world).not.toHaveClass(/layout-transition/u);
  expect(await viewer.getAttribute("data-local-center-id")).toBeNull();
  await expect(viewer.locator(".structure-minimap-viewport")).toHaveAttribute(
    "data-map-frame",
    "viewport",
  );

  const restored = await graphDomState(viewer);
  expect(restored.nodeIds).toEqual(fullState.nodeIds);
  expect(restored.edgeIds).toEqual(fullState.edgeIds);
  expect(restored.labelEdgeIds).toEqual(fullState.labelEdgeIds);
  expect(restored.nodePositions).toEqual(fullState.nodePositions);
  expect(restored.worldTransform).toBe(fullState.worldTransform);
  expect(await minimapBackboneState(viewer)).toEqual(fullMinimap);
  await expect(viewer.locator('.structure-node[data-node-id="auth-middleware"]')).toHaveCount(1);
  await expect(viewer.locator('.structure-node[data-node-id="database-schema"]')).toHaveCount(1);
  await expect(viewer.locator('.structure-edge[data-edge-id="orders-use-schema"]')).toHaveCount(1);
  await expect(
    viewer.locator('.structure-edge-label[data-edge-id="orders-use-schema"]'),
  ).toHaveCount(1);
});

test("keeps Region framing emphasis when returning from the independent Regions view", async ({
  page,
}) => {
  await openOrderPlacementStructure(page);
  const viewer = page.locator(`[data-structure-id="${structureId}"]`);

  await viewer.getByRole("button", { name: "Regions", exact: true }).click();
  await viewer
    .getByRole("button", { name: /^Open region Atomic persistence in Graph, 4 nodes\./u })
    .click();
  await expect(viewer).toHaveAttribute("data-view-mode", "graph");
  await expect(viewer).toHaveAttribute("data-framed-region-id", "atomic-persistence");
  await expect(viewer.locator('.structure-node[data-node-id="database-schema"]')).toHaveClass(
    /(?:^|\s)framed-region-member(?:\s|$)/u,
  );
  await expect(viewer.locator('.structure-edge[data-edge-id="orders-use-schema"]')).toHaveClass(
    /(?:^|\s)framed-region-relation(?:\s|$)/u,
  );
  await expect(viewer.locator('.structure-node[data-node-id="pricing-policy"]')).toHaveClass(
    /(?:^|\s)region-frame-context(?:\s|$)/u,
  );

  const layering = await viewer.evaluate((element) => {
    const opacity = (selector: string): number => {
      const target = element.querySelector<HTMLElement | SVGElement>(selector);
      if (!target) throw new Error(`missing Region visual target: ${selector}`);
      return Number(getComputedStyle(target).opacity);
    };
    return {
      contextNode: opacity('.structure-node[data-node-id="pricing-policy"]'),
      contextEdge: opacity('.structure-edge[data-edge-id="controller-validates-request"]'),
      memberNode: opacity('.structure-node[data-node-id="database-schema"]'),
      memberEdge: opacity('.structure-edge[data-edge-id="orders-use-schema"]'),
    };
  });
  expect(layering.memberNode).toBeGreaterThan(layering.contextNode);
  expect(layering.memberEdge).toBeGreaterThan(layering.contextEdge);
});
