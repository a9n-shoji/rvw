import { expect, test, type Locator, type Page } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const structureId = "80000000-0000-4000-8000-000000000001";

async function openStructure(page: Page): Promise<Locator> {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const folder = page.getByRole("button", { name: /^Structure \d+$/u });
  if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
  await page
    .getByRole("navigation", { name: "レビュー文書" })
    .getByRole("button", { name: "Order placement behavior", exact: true })
    .click();
  return page.locator(`[data-structure-id="${structureId}"]`);
}

async function waitForGraphMotion(viewer: Locator): Promise<void> {
  const world = viewer.locator(".structure-world");
  await expect(world).not.toHaveClass(/(?:camera|layout)-transition/u);
}

async function graphGeometry(viewer: Locator) {
  return await viewer.evaluate((element) => {
    const sorted = <Value extends { id: string }>(values: Value[]): Value[] =>
      values.sort((left, right) => left.id.localeCompare(right.id, "en"));
    return {
      nodes: sorted(
        [...element.querySelectorAll<HTMLElement>(".structure-node")].map((node) => ({
          id: node.dataset.nodeId ?? "",
          left: node.style.left,
          top: node.style.top,
        })),
      ),
      edges: sorted(
        [...element.querySelectorAll<SVGPathElement>(".structure-edge")].map((edge) => ({
          id: edge.dataset.edgeId ?? "",
          path: edge.getAttribute("d") ?? "",
        })),
      ),
      labels: sorted(
        [...element.querySelectorAll<HTMLElement>(".structure-edge-label")].map((label) => ({
          id: label.dataset.edgeId ?? "",
          left: label.style.left,
          top: label.style.top,
          width: label.style.width,
          height: label.style.height,
        })),
      ),
      leaders: sorted(
        [...element.querySelectorAll<SVGGElement>(".structure-edge-label-leader")].map(
          (leader) => ({
            id: leader.dataset.edgeId ?? "",
            path:
              leader
                .querySelector<SVGPathElement>(".structure-edge-label-leader-line")
                ?.getAttribute("d") ?? "",
          }),
        ),
      ),
    };
  });
}

async function nodeScreenCenter(node: Locator): Promise<{ x: number; y: number }> {
  return await node.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  });
}

async function expectVisibleRelationshipGeometryInsideCanvas(viewer: Locator): Promise<void> {
  const canvasBounds = await viewer.locator(".structure-canvas").boundingBox();
  expect(canvasBounds).not.toBeNull();
  const geometry = viewer.locator(
    ".structure-edge, .structure-edge-arrow-carrier, .structure-edge-label, .structure-edge-label-leader",
  );
  expect(await geometry.count()).toBeGreaterThan(0);
  for (const element of await geometry.all()) {
    const bounds = await element.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(canvasBounds!.x - 1);
    expect(bounds!.y).toBeGreaterThanOrEqual(canvasBounds!.y - 1);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
      canvasBounds!.x + canvasBounds!.width + 1,
    );
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
      canvasBounds!.y + canvasBounds!.height + 1,
    );
  }
}

async function dragNode(page: Page, node: Locator, deltaX: number, deltaY: number): Promise<void> {
  const bounds = await node.boundingBox();
  expect(bounds).not.toBeNull();
  const startX = bounds!.x + bounds!.width / 2;
  const startY = bounds!.y + bounds!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 4 });
  await page.mouse.up();
}

function expectSamePoint(
  actual: { x: number; y: number },
  expected: { x: number; y: number },
): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(1);
}

test("keeps the chosen center anchored across depths and makes local Fit camera-only", async ({
  page,
}) => {
  const viewer = await openStructure(page);
  const world = viewer.locator(".structure-world");
  const canvas = viewer.locator(".structure-canvas");
  const hub = viewer.locator('.structure-node[data-node-id="hub"]');

  await viewer.getByRole("button", { name: "表示中を収める", exact: true }).click();
  await waitForGraphMotion(viewer);
  await viewer.getByRole("button", { name: "拡大", exact: true }).click();
  await viewer.getByRole("button", { name: "focusを中央へ", exact: true }).click();
  const canonicalHubPosition = await hub.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  }));
  await dragNode(page, hub, 44, -28);
  await expect
    .poll(async () =>
      hub.evaluate((element) => ({
        left: (element as HTMLElement).style.left,
        top: (element as HTMLElement).style.top,
      })),
    )
    .not.toEqual(canonicalHubPosition);

  const allGeometry = await graphGeometry(viewer);
  const allTransform = await world.getAttribute("style");
  const allScale = await viewer.getAttribute("data-viewport-scale");
  const hubBeforeDepth = await nodeScreenCenter(hub);

  await viewer.getByRole("button", { name: "1-hop", exact: true }).click();
  await expect(world).toHaveClass(/layout-transition/u);
  await page.waitForTimeout(30);
  expect(
    await viewer
      .locator(".structure-edges")
      .evaluate((element) => Number(getComputedStyle(element).opacity)),
  ).toBeLessThanOrEqual(0.05);
  await waitForGraphMotion(viewer);
  await expect(viewer).toHaveAttribute("data-neighborhood-depth", "1");
  await expect(viewer).toHaveAttribute("data-local-center-id", "hub");
  await expect(viewer).toHaveAttribute("data-viewport-scale", allScale!);
  expectSamePoint(await nodeScreenCenter(hub), hubBeforeDepth);
  const oneHopGeometry = await graphGeometry(viewer);
  const localCenterStyles = await hub.evaluate((element) => {
    const marker = getComputedStyle(element.querySelector(".structure-node-local-center-marker")!);
    const focus = getComputedStyle(element.querySelector(".structure-node-focus")!);
    return {
      markerBorderStyle: marker.borderStyle,
      markerInset: [marker.top, marker.right, marker.bottom, marker.left],
      focusOutlineStyle: focus.outlineStyle,
    };
  });
  expect(localCenterStyles.markerBorderStyle).toBe("dashed");
  expect(localCenterStyles.markerInset).toEqual(["3px", "3px", "3px", "3px"]);
  expect(localCenterStyles.focusOutlineStyle).not.toBe("dashed");

  const orderAggregate = viewer.locator('.structure-node[data-node-id="order-aggregate"]');
  await orderAggregate.click();
  await dragNode(page, orderAggregate, 36, 24);
  const aggregateLocalPosition = await orderAggregate.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  }));
  const hubBeforeDepthChange = await nodeScreenCenter(hub);
  const oneHopScale = await viewer.getAttribute("data-viewport-scale");
  await viewer.getByRole("button", { name: "2-hop", exact: true }).click();
  await waitForGraphMotion(viewer);
  await expect(viewer).toHaveAttribute("data-neighborhood-depth", "2");
  await expect(viewer).toHaveAttribute("data-local-center-id", "hub");
  await expect(viewer).toHaveAttribute("data-viewport-scale", oneHopScale!);
  expectSamePoint(await nodeScreenCenter(hub), hubBeforeDepthChange);
  expect(
    await orderAggregate.evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    })),
  ).not.toEqual(aggregateLocalPosition);

  const hubBeforeCompaction = await nodeScreenCenter(hub);
  await viewer.getByRole("button", { name: "1-hop", exact: true }).click();
  await waitForGraphMotion(viewer);
  await expect(viewer).toHaveAttribute("data-local-center-id", "hub");
  expectSamePoint(await nodeScreenCenter(hub), hubBeforeCompaction);
  expect(await graphGeometry(viewer)).toEqual(oneHopGeometry);

  await viewer.getByRole("button", { name: "2-hop", exact: true }).click();
  await waitForGraphMotion(viewer);

  const localGeometry = await graphGeometry(viewer);
  const beforePan = await world.getAttribute("style");
  await canvas.dispatchEvent("wheel", { deltaX: 120, deltaY: 80 });
  await expect.poll(async () => await world.getAttribute("style")).not.toBe(beforePan);
  const panned = await world.getAttribute("style");
  await viewer.getByRole("button", { name: "表示中を収める", exact: true }).click();
  await waitForGraphMotion(viewer);
  expect(await world.getAttribute("style")).not.toBe(panned);
  expect(await graphGeometry(viewer)).toEqual(localGeometry);
  await expect(viewer).toHaveAttribute("data-neighborhood-depth", "2");
  await expect(viewer).toHaveAttribute("data-local-center-id", "hub");

  await viewer.getByRole("button", { name: "全体", exact: true }).click();
  await waitForGraphMotion(viewer);
  await expect(viewer).toHaveAttribute("data-neighborhood-depth", "all");
  await expect(viewer).not.toHaveAttribute("data-local-center-id");
  expect(await graphGeometry(viewer)).toEqual(allGeometry);
  expect(await world.getAttribute("style")).toBe(allTransform);
});

test("previews the exact Relation route from its label without moving the camera", async ({
  page,
}) => {
  const viewer = await openStructure(page);
  const world = viewer.locator(".structure-world");
  await viewer.getByRole("button", { name: "1-hop", exact: true }).click();
  await waitForGraphMotion(viewer);

  const edgeId = "order-returns-snapshot";
  const label = viewer.locator(`.structure-edge-label[data-edge-id="${edgeId}"]`);
  const route = viewer.locator(`path.structure-edge[data-edge-id="${edgeId}"]`);
  const transform = await world.getAttribute("style");

  await label.hover();
  const hoverPreview = viewer.locator(`[data-edge-label-emphasis-id="${edgeId}"]`);
  await expect(hoverPreview).toHaveCount(1);
  await expect(hoverPreview.locator(".structure-edge-label-emphasis-line")).toHaveAttribute(
    "d",
    (await route.getAttribute("d"))!,
  );
  expect(await world.getAttribute("style")).toBe(transform);

  await page.mouse.move(0, 0);
  await expect(hoverPreview).toHaveCount(0);
  await label.locator(".structure-edge-select").focus();
  await expect(hoverPreview).toHaveCount(1);
  expect(await world.getAttribute("style")).toBe(transform);
});

test("compacts automatic local positions when its center changes", async ({ page }) => {
  const viewer = await openStructure(page);
  const world = viewer.locator(".structure-world");
  const aggregate = viewer.locator('.structure-node[data-node-id="order-aggregate"]');

  await viewer.getByRole("button", { name: "1-hop", exact: true }).click();
  await waitForGraphMotion(viewer);
  await aggregate.locator(".structure-node-neighborhood").click();
  await waitForGraphMotion(viewer);
  await expect(viewer).toHaveAttribute("data-local-center-id", "order-aggregate");
  const recenteredGeometry = await graphGeometry(viewer);

  await viewer.getByRole("button", { name: "全体", exact: true }).click();
  await waitForGraphMotion(viewer);
  await viewer.getByRole("button", { name: "1-hop", exact: true }).click();
  await waitForGraphMotion(viewer);
  await expect(viewer).toHaveAttribute("data-local-center-id", "order-aggregate");
  expect(await graphGeometry(viewer)).toEqual(recenteredGeometry);
  await expect(world).not.toHaveClass(/(?:camera|layout)-transition/u);
});

test("does not commit interpolated full positions when an All restoration is only clicked", async ({
  page,
}) => {
  const viewer = await openStructure(page);
  const world = viewer.locator(".structure-world");
  const hub = viewer.locator('.structure-node[data-node-id="hub"]');

  await waitForGraphMotion(viewer);
  await dragNode(page, hub, 72, -36);
  await page.waitForTimeout(50);
  const committedAllPositions = (await graphGeometry(viewer)).nodes;
  const committedAllViewport = await world.getAttribute("style");
  await viewer.getByRole("button", { name: "1-hop", exact: true }).click();
  await waitForGraphMotion(viewer);

  await viewer.getByRole("button", { name: "全体", exact: true }).click();
  await expect(world).toHaveClass(/layout-transition/u);
  await page.waitForTimeout(35);
  const movingCenter = await nodeScreenCenter(hub);
  await page.mouse.move(movingCenter.x, movingCenter.y);
  await page.mouse.down();
  await expect(world).not.toHaveClass(/layout-transition/u);
  await page.mouse.up();

  await expect.poll(async () => (await graphGeometry(viewer)).nodes).toEqual(committedAllPositions);
  expect(await world.getAttribute("style")).toBe(committedAllViewport);
  await viewer.getByRole("button", { name: "1-hop", exact: true }).click();
  await waitForGraphMotion(viewer);
  await viewer.getByRole("button", { name: "全体", exact: true }).click();
  await waitForGraphMotion(viewer);
  expect((await graphGeometry(viewer)).nodes).toEqual(committedAllPositions);
  expect(await world.getAttribute("style")).toBe(committedAllViewport);
});

test("recenters a local graph at the same depth, restores it through history, and honors reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const viewer = await openStructure(page);
  const world = viewer.locator(".structure-world");
  const canvas = viewer.locator(".structure-canvas");

  await viewer.getByRole("button", { name: "2-hop", exact: true }).click();
  await expect(world).toHaveClass(/layout-transition/u);
  const reducedMotionStyles = await viewer.evaluate((element) => {
    const node = element.querySelector<HTMLElement>(".structure-node")!;
    const edgeLayer = element.querySelector<SVGElement>(".structure-edges")!;
    return {
      nodeTransition: getComputedStyle(node).transitionDuration,
      edgeAnimation: getComputedStyle(edgeLayer).animationName,
    };
  });
  expect(reducedMotionStyles.nodeTransition).toBe("0s");
  expect(reducedMotionStyles.edgeAnimation).toBe("none");
  await waitForGraphMotion(viewer);

  const hub = viewer.locator('.structure-node[data-node-id="hub"]');
  await dragNode(page, hub, 32, 20);
  const retainedHubPosition = await hub.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  }));
  const hubGeometry = await graphGeometry(viewer);
  const hubTransform = await world.getAttribute("style");
  const pricing = viewer.locator('.structure-node[data-node-id="pricing-policy"]');
  await pricing.dblclick();
  await waitForGraphMotion(viewer);
  await expect(viewer).toHaveAttribute("data-neighborhood-depth", "2");
  await expect(viewer).toHaveAttribute("data-local-center-id", "pricing-policy");
  await expect(pricing).toHaveClass(/(?:^|\s)focused(?:\s|$)/u);
  const pricingGeometry = await graphGeometry(viewer);
  expect(pricingGeometry).not.toEqual(hubGeometry);
  expect(pricingGeometry.nodes.map(({ id }) => id)).toEqual([
    "hub",
    "order-aggregate",
    "pricing-policy",
  ]);
  expect(pricingGeometry.edges.map(({ id }) => id)).toEqual([
    "handler-places-order",
    "order-calculates-total",
    "order-returns-snapshot",
  ]);
  const localCanvasBounds = await canvas.boundingBox();
  expect(localCanvasBounds).not.toBeNull();
  for (const node of await viewer.locator(".structure-node").all()) {
    const bounds = await node.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(localCanvasBounds!.x - 1);
    expect(bounds!.y).toBeGreaterThanOrEqual(localCanvasBounds!.y - 1);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
      localCanvasBounds!.x + localCanvasBounds!.width + 1,
    );
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
      localCanvasBounds!.y + localCanvasBounds!.height + 1,
    );
  }
  await expectVisibleRelationshipGeometryInsideCanvas(viewer);
  await expect(pricing.locator(".structure-node-neighborhood")).toHaveAttribute(
    "title",
    "このNodeと2-hop周辺へ移動",
  );
  expect(
    await hub.evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    })),
  ).toEqual(retainedHubPosition);

  await viewer.getByRole("button", { name: "Back", exact: true }).click();
  await expect(viewer).toHaveAttribute("data-local-center-id", "hub");
  await expect.poll(async () => await graphGeometry(viewer)).toEqual(hubGeometry);
  await expect.poll(async () => await world.getAttribute("style")).toBe(hubTransform);

  await page.goForward();
  await expect(viewer).toHaveAttribute("data-local-center-id", "pricing-policy");
  await expect.poll(async () => await graphGeometry(viewer)).toEqual(pricingGeometry);

  const pricingFrame = await world.getAttribute("style");
  await canvas.dispatchEvent("wheel", { deltaX: 105, deltaY: 70 });
  await expect.poll(async () => await world.getAttribute("style")).not.toBe(pricingFrame);
  const pannedPricingFrame = await world.getAttribute("style");
  await pricing.locator(".structure-node-neighborhood").click();
  await waitForGraphMotion(viewer);
  expect(await world.getAttribute("style")).not.toBe(pannedPricingFrame);
  expect(await world.getAttribute("style")).toBe(pricingFrame);
  await expectVisibleRelationshipGeometryInsideCanvas(viewer);

  await hub.locator(".structure-node-neighborhood").focus();
  await hub.locator(".structure-node-neighborhood").press("Enter");
  await expect(viewer).toHaveAttribute("data-local-center-id", "hub");
  await expect(viewer).toHaveAttribute("data-neighborhood-depth", "2");

  const beforeInterrupt = await world.getAttribute("style");
  await canvas.dispatchEvent("wheel", { deltaX: 75, deltaY: 45 });
  await expect(world).not.toHaveClass(/(?:camera|layout)-transition/u);
  await expect.poll(async () => await world.getAttribute("style")).not.toBe(beforeInterrupt);
  const interruptedTransform = await world.getAttribute("style");
  await page.waitForTimeout(320);
  expect(await world.getAttribute("style")).toBe(interruptedTransform);
});

test("continues wheel and pointer pans from the camera's interpolated position", async ({
  page,
}) => {
  const viewer = await openStructure(page);
  const world = viewer.locator(".structure-world");
  const canvas = viewer.locator(".structure-canvas");
  const viewport = async () =>
    await world.evaluate((element) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return { x: matrix.e, y: matrix.f, scale: matrix.a };
    });
  const inlineViewport = async () =>
    await world.evaluate((element) => {
      const matrix = new DOMMatrixReadOnly((element as HTMLElement).style.transform);
      return { x: matrix.e, y: matrix.f, scale: matrix.a };
    });

  await waitForGraphMotion(viewer);
  await viewer.locator('.structure-node[data-node-id="database-schema"]').dblclick();
  await expect(world).toHaveClass(/camera-transition/u);
  const wheelDestination = await inlineViewport();
  await page.waitForTimeout(35);
  const wheelStart = await canvas.evaluate((element) => {
    const worldElement = element.querySelector<HTMLElement>(".structure-world")!;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(worldElement).transform);
    element.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: element.getBoundingClientRect().left + 30,
        clientY: element.getBoundingClientRect().top + 30,
        deltaX: 180,
        deltaY: 120,
      }),
    );
    return { x: matrix.e, y: matrix.f, scale: matrix.a };
  });
  await expect(world).not.toHaveClass(/camera-transition/u);
  const wheelResult = await viewport();
  expect(
    Math.hypot(wheelStart.x - wheelDestination.x, wheelStart.y - wheelDestination.y),
  ).toBeGreaterThan(4);
  expect(wheelResult.x).toBeCloseTo(wheelStart.x - 360, 1);
  expect(wheelResult.y).toBeCloseTo(wheelStart.y - 240, 1);
  expect(wheelResult.scale).toBeCloseTo(wheelStart.scale, 4);

  await viewer.getByRole("button", { name: "Home", exact: true }).evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  await expect(world).toHaveClass(/camera-transition/u);
  const panDestination = await inlineViewport();
  await page.waitForTimeout(35);
  const panStart = await canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const worldElement = element.querySelector<HTMLElement>(".structure-world")!;
    const destination = new DOMMatrixReadOnly(worldElement.style.transform);
    const blockers = Array.from(
      element.querySelectorAll<HTMLElement>(".structure-node, .structure-edge-label"),
    ).map((candidate) => {
      const current = candidate.getBoundingClientRect();
      const futureLeft =
        bounds.left + destination.e + Number.parseFloat(candidate.style.left) * destination.a;
      const futureTop =
        bounds.top + destination.f + Number.parseFloat(candidate.style.top) * destination.d;
      const futureRight = futureLeft + candidate.offsetWidth * destination.a;
      const futureBottom = futureTop + candidate.offsetHeight * destination.d;
      return {
        left: Math.min(current.left, futureLeft),
        right: Math.max(current.right, futureRight),
        top: Math.min(current.top, futureTop),
        bottom: Math.max(current.bottom, futureBottom),
      };
    });
    blockers.push(
      ...Array.from(element.querySelectorAll<HTMLElement>("button"))
        .filter((candidate) => !candidate.closest(".structure-world"))
        .map((candidate) => candidate.getBoundingClientRect()),
    );
    for (let y = bounds.bottom - 16; y >= bounds.top + 72; y -= 24) {
      for (let x = bounds.left + 16; x <= bounds.right - 16; x += 24) {
        const hit = document.elementFromPoint(x, y);
        if (
          hit &&
          element.contains(hit) &&
          !hit.closest("button, .structure-node, .structure-edge-label") &&
          blockers.every(
            (rectangle) =>
              x < rectangle.left - 8 ||
              x > rectangle.right + 8 ||
              y < rectangle.top - 8 ||
              y > rectangle.bottom + 8,
          )
        ) {
          return { x, y };
        }
      }
    }
    throw new Error("no open Structure canvas point for pointer pan");
  });
  await page.mouse.move(panStart.x, panStart.y);
  await page.mouse.down();
  await expect(world).not.toHaveClass(/camera-transition/u);
  const frozenPanStart = await viewport();
  expect(
    Math.hypot(frozenPanStart.x - panDestination.x, frozenPanStart.y - panDestination.y),
  ).toBeGreaterThan(4);

  await page.mouse.move(panStart.x + 34, panStart.y + 22);
  await page.mouse.up();
  const panResult = await viewport();
  expect(panResult.x).toBeCloseTo(frozenPanStart.x + 34, 1);
  expect(panResult.y).toBeCloseTo(frozenPanStart.y + 22, 1);
  expect(panResult.scale).toBeCloseTo(frozenPanStart.scale, 4);
  await page.waitForTimeout(280);
  expect(await viewport()).toEqual(panResult);

  await viewer.getByRole("button", { name: "Home", exact: true }).click();
  await waitForGraphMotion(viewer);
  const draggedNode = viewer.locator('.structure-node[data-node-id="database-schema"]');
  await draggedNode.dblclick();
  await expect(world).toHaveClass(/camera-transition/u);
  const dragDestination = await inlineViewport();
  await page.waitForTimeout(25);
  const dragBounds = await draggedNode.boundingBox();
  expect(dragBounds).not.toBeNull();
  const dragStart = {
    x: dragBounds!.x + dragBounds!.width / 2,
    y: dragBounds!.y + dragBounds!.height / 2,
  };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await expect(world).not.toHaveClass(/camera-transition/u);
  const frozenDragViewport = await viewport();
  const frozenNodeCenter = await nodeScreenCenter(draggedNode);
  expect(
    Math.hypot(frozenDragViewport.x - dragDestination.x, frozenDragViewport.y - dragDestination.y),
  ).toBeGreaterThan(4);

  await page.mouse.move(dragStart.x + 38, dragStart.y + 26);
  await page.mouse.up();
  const draggedNodeCenter = await nodeScreenCenter(draggedNode);
  expect(draggedNodeCenter.x).toBeCloseTo(frozenNodeCenter.x + 38, 1);
  expect(draggedNodeCenter.y).toBeCloseTo(frozenNodeCenter.y + 26, 1);
  expect(await viewport()).toEqual(frozenDragViewport);

  // The preceding camera exercise intentionally leaves hub outside the interactive viewport.
  // Dispatch the selection action without Playwright scrolling the transformed world under the sidebar.
  await viewer
    .locator('.structure-node[data-node-id="hub"] > .structure-node-focus')
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect(viewer).toHaveAttribute("data-selected-node-id", "hub");
  await viewer
    .locator('.structure-node[data-node-id="hub"] > .structure-node-neighborhood')
    .evaluate((element) => (element as HTMLButtonElement).click());
  await waitForGraphMotion(viewer);
  await viewer.getByRole("button", { name: "1-hop", exact: true }).click();
  await expect(world).toHaveClass(/layout-transition/u);
  const layoutDraggedNode = viewer.locator('.structure-node[data-node-id="hub"]');
  await page.waitForTimeout(35);
  const interpolatedCenter = await nodeScreenCenter(layoutDraggedNode);
  const layoutCanvasBounds = await canvas.boundingBox();
  expect(layoutCanvasBounds).not.toBeNull();
  expect(interpolatedCenter.x).toBeGreaterThan(layoutCanvasBounds!.x);
  expect(interpolatedCenter.x).toBeLessThan(layoutCanvasBounds!.x + layoutCanvasBounds!.width);
  expect(interpolatedCenter.y).toBeGreaterThan(layoutCanvasBounds!.y);
  expect(interpolatedCenter.y).toBeLessThan(layoutCanvasBounds!.y + layoutCanvasBounds!.height);
  await page.mouse.move(interpolatedCenter.x, interpolatedCenter.y);
  await page.mouse.down();
  await expect(world).not.toHaveClass(/layout-transition/u);
  const frozenLayoutCenter = await nodeScreenCenter(layoutDraggedNode);
  expect(frozenLayoutCenter.x).toBeCloseTo(interpolatedCenter.x, 1);
  expect(frozenLayoutCenter.y).toBeCloseTo(interpolatedCenter.y, 1);

  await page.mouse.move(interpolatedCenter.x + 38, interpolatedCenter.y + 26);
  await page.mouse.up();
  const layoutDraggedCenter = await nodeScreenCenter(layoutDraggedNode);
  expect(layoutDraggedCenter.x).toBeCloseTo(frozenLayoutCenter.x + 38, 1);
  expect(layoutDraggedCenter.y).toBeCloseTo(frozenLayoutCenter.y + 26, 1);
});
