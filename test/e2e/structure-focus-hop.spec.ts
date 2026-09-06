import { expect, test, type Page } from "@playwright/test";

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

test("keeps focus-hop distance visually dominant over authored backbone emphasis", async ({
  page,
}) => {
  await openOrderPlacementStructure(page);
  const viewer = page.locator(`[data-structure-id="${structureId}"]`);
  await expect(viewer.locator('.structure-node[data-node-id="hub"]')).toHaveClass(/focused/u);

  await viewer.getByRole("button", { name: "2-hop", exact: true }).click();

  const immediateBackboneNode = viewer.locator('.structure-node[data-node-id="order-aggregate"]');
  const distantBackboneNode = viewer.locator('.structure-node[data-node-id="pricing-policy"]');
  const distantOrdinaryNode = viewer.locator('.structure-node[data-node-id="request-schema"]');
  const distantBackboneEdge = viewer.locator(
    '.structure-edge[data-edge-id="order-calculates-total"]',
  );
  const distantOrdinaryEdge = viewer.locator(
    '.structure-edge[data-edge-id="controller-validates-request"]',
  );
  const distantBackboneArrow = viewer.locator(
    '.structure-edge-arrow-carrier[data-edge-arrow-id="order-calculates-total"]',
  );
  const distantBackboneLabel = viewer.locator(
    '.structure-edge-label[data-edge-id="order-calculates-total"]',
  );
  const distantOrdinaryLabel = viewer.locator(
    '.structure-edge-label[data-edge-id="controller-validates-request"]',
  );

  await expect(immediateBackboneNode).not.toHaveClass(/context-distant/u);
  await expect(distantBackboneNode).toHaveClass(/primary-backbone/u);
  await expect(distantBackboneNode).toHaveClass(/context-distant/u);
  await expect(distantOrdinaryNode).toHaveClass(/context-distant/u);
  await expect(distantBackboneEdge).toHaveAttribute("data-focus-relevance", "distant");
  await expect(distantBackboneEdge).toHaveClass(/primary-backbone/u);
  await expect(distantBackboneEdge).toHaveClass(/context-distant/u);
  await expect(distantOrdinaryEdge).toHaveAttribute("data-focus-relevance", "distant");
  await expect(distantOrdinaryEdge).toHaveClass(/context-distant/u);
  await expect(distantBackboneArrow).toHaveClass(/context-distant/u);
  await expect(distantBackboneLabel).toHaveClass(/context-distant/u);
  await expect(distantOrdinaryLabel).toHaveClass(/context-distant/u);

  const visualHierarchy = await viewer.evaluate((element) => {
    const style = (selector: string): CSSStyleDeclaration => {
      const target = element.querySelector<HTMLElement | SVGElement>(selector);
      if (!target) throw new Error(`missing visual target: ${selector}`);
      return getComputedStyle(target);
    };
    return {
      immediateBackboneNodeOpacity: style('.structure-node[data-node-id="order-aggregate"]')
        .opacity,
      distantBackboneNodeOpacity: style('.structure-node[data-node-id="pricing-policy"]').opacity,
      distantOrdinaryNodeOpacity: style('.structure-node[data-node-id="request-schema"]').opacity,
      distantBackboneEdgeOpacity: style('.structure-edge[data-edge-id="order-calculates-total"]')
        .opacity,
      distantOrdinaryEdgeOpacity: style(
        '.structure-edge[data-edge-id="controller-validates-request"]',
      ).opacity,
      distantBackboneArrowOpacity: style(
        '.structure-edge-arrow-carrier[data-edge-arrow-id="order-calculates-total"]',
      ).opacity,
      distantBackboneLabelOpacity: style(
        '.structure-edge-label[data-edge-id="order-calculates-total"]',
      ).opacity,
      distantOrdinaryLabelOpacity: style(
        '.structure-edge-label[data-edge-id="controller-validates-request"]',
      ).opacity,
      backboneDash: style('.structure-edge[data-edge-id="order-calculates-total"]').strokeDasharray,
      backboneNodeMark: style(
        '.structure-node[data-node-id="pricing-policy"] .structure-node-focus',
      ).backgroundImage,
      minimapBackboneEdges: element.querySelectorAll(".structure-minimap-primary-backbone").length,
    };
  });

  expect(Number(visualHierarchy.distantBackboneNodeOpacity)).toBeLessThan(
    Number(visualHierarchy.immediateBackboneNodeOpacity),
  );
  expect(visualHierarchy.distantBackboneNodeOpacity).toBe(
    visualHierarchy.distantOrdinaryNodeOpacity,
  );
  expect(visualHierarchy.distantBackboneEdgeOpacity).toBe(
    visualHierarchy.distantOrdinaryEdgeOpacity,
  );
  expect(visualHierarchy.distantBackboneArrowOpacity).toBe(
    visualHierarchy.distantBackboneEdgeOpacity,
  );
  expect(visualHierarchy.distantBackboneLabelOpacity).toBe(
    visualHierarchy.distantOrdinaryLabelOpacity,
  );
  expect(visualHierarchy.backboneDash).not.toBe("none");
  expect(visualHierarchy.backboneNodeMark).not.toBe("none");
  expect(visualHierarchy.minimapBackboneEdges).toBeGreaterThan(0);

  await distantBackboneLabel
    .locator(".structure-edge-select")
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect(distantBackboneEdge).toHaveClass(/selected/u);
  await expect(distantBackboneNode).toHaveClass(/edge-endpoint/u);
  expect(await distantBackboneEdge.evaluate((element) => getComputedStyle(element).opacity)).toBe(
    "1",
  );
  expect(await distantBackboneArrow.evaluate((element) => getComputedStyle(element).opacity)).toBe(
    "1",
  );
  expect(await distantBackboneLabel.evaluate((element) => getComputedStyle(element).opacity)).toBe(
    "1",
  );
  expect(await distantBackboneNode.evaluate((element) => getComputedStyle(element).opacity)).toBe(
    "1",
  );
  await distantBackboneLabel
    .locator(".structure-edge-select")
    .evaluate((element) => (element as HTMLButtonElement).click());

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if ((await viewer.getAttribute("data-semantic-zoom")) === "overview") break;
    await viewer.getByRole("button", { name: "縮小", exact: true }).click();
  }
  await expect(viewer).toHaveAttribute("data-semantic-zoom", "overview");
  expect(
    await distantBackboneLabel
      .locator(".structure-edge-label-text")
      .evaluate((element) => getComputedStyle(element).visibility),
  ).toBe("hidden");
  expect(
    await viewer
      .locator(
        '.structure-edge-label[data-edge-id="handler-places-order"] .structure-edge-label-text',
      )
      .evaluate((element) => getComputedStyle(element).visibility),
  ).toBe("visible");
  await distantBackboneLabel
    .locator(".structure-edge-select")
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect(distantBackboneLabel).toHaveClass(/selected/u);
  expect(
    await distantBackboneLabel
      .locator(".structure-edge-label-text")
      .evaluate((element) => getComputedStyle(element).visibility),
  ).toBe("visible");
  await distantBackboneLabel
    .locator(".structure-edge-select")
    .evaluate((element) => (element as HTMLButtonElement).click());

  await viewer.getByRole("button", { name: "Regions", exact: true }).click();
  await viewer
    .getByRole("button", { name: /^Open region Atomic persistence in Graph, 4 nodes\./u })
    .click();
  await expect(viewer).toHaveAttribute("data-view-mode", "graph");
  await expect(viewer).toHaveAttribute("data-framed-region-id", "atomic-persistence");
  const regionLayering = await viewer.evaluate((element) => {
    const opacity = (selector: string): string => {
      const target = element.querySelector<HTMLElement | SVGElement>(selector);
      if (!target) throw new Error(`missing region visual target: ${selector}`);
      return getComputedStyle(target).opacity;
    };
    return {
      distantBackboneNode: opacity('.structure-node[data-node-id="pricing-policy"]'),
      distantOrdinaryNode: opacity('.structure-node[data-node-id="request-schema"]'),
      distantBackboneEdge: opacity('.structure-edge[data-edge-id="order-calculates-total"]'),
      distantOrdinaryEdge: opacity('.structure-edge[data-edge-id="controller-validates-request"]'),
      activeRegionMember: opacity('.structure-node[data-node-id="database-schema"]'),
      activeRegionRelation: opacity('.structure-edge[data-edge-id="orders-use-schema"]'),
    };
  });
  expect(regionLayering.distantBackboneNode).toBe(regionLayering.distantOrdinaryNode);
  expect(regionLayering.distantBackboneEdge).toBe(regionLayering.distantOrdinaryEdge);
  expect(Number(regionLayering.activeRegionMember)).toBeGreaterThan(
    Number(regionLayering.distantBackboneNode),
  );
  expect(Number(regionLayering.activeRegionRelation)).toBeGreaterThan(
    Number(regionLayering.distantBackboneEdge),
  );
});
