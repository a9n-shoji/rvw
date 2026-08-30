import { expect, test, type Locator, type Page } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const primaryStructureId = "80000000-0000-4000-8000-000000000001";
const secondaryStructureId = "80000000-0000-4000-8000-000000000002";
const fullStackStructureId = "80000000-0000-4000-8000-000000000003";
const primaryTitle = "Order placement behavior";
const secondaryTitle = "Failure recovery and evidence";
const fullStackTitle = "Order detail response rendering";

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

async function dragVisibleStructureNode(page: Page, viewer: Locator, node: Locator): Promise<void> {
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
  const structureFolder = page.getByRole("button", { name: "Structure 3", exact: true });
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
  expect(expectedRightState.focusedNodeId).toBe("http-routes");
  expect(expectedRightState.depth).toBe("全体");
  expect(Number(expectedRightState.viewportScale)).toBeLessThan(initialRightScale);
  expect(Number(expectedRightState.viewportScale)).toBeGreaterThanOrEqual(0.08);

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
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, fullStackTitle);
  const viewer = page.locator(`[data-structure-id="${fullStackStructureId}"]`);
  await expect(viewer.getByRole("heading", { name: fullStackTitle })).toBeVisible();
  await expect(viewer.getByText("17/17 Node · 19/19 Relation", { exact: true })).toBeVisible();
  await expect(viewer.locator('.structure-node[data-node-id="order-detail-route"]')).toHaveClass(
    /focused/,
  );
  await expect(viewer.locator(".structure-claim-note")).toHaveCount(0);
  await expect(viewer.locator(".structure-details")).toHaveCount(0);

  await viewer.getByRole("button", { name: "表示中を収める" }).click();
  const horizontalFlow = await viewer.evaluate((element) => {
    const x = (id: string): number =>
      Number.parseFloat(
        element.querySelector<HTMLElement>(`.structure-node[data-node-id="${id}"]`)!.style.left,
      );
    return {
      route: x("order-detail-route"),
      query: x("get-order-query"),
      contract: x("order-detail-contract"),
      client: x("order-api-client"),
      page: x("order-detail-page"),
    };
  });
  expect(horizontalFlow.route).toBeLessThan(horizontalFlow.query);
  expect(horizontalFlow.query).toBeLessThan(horizontalFlow.contract);
  expect(horizontalFlow.contract).toBeLessThan(horizontalFlow.client);
  expect(horizontalFlow.client).toBeLessThan(horizontalFlow.page);

  await viewer.locator('.structure-node[data-node-id="order-detail-contract"]').click();
  const contractEdgeLabel = viewer.locator(
    '.structure-edge-label[data-edge-id="detail-client-consumes-contract"]',
  );
  const [labelButtonBox, sourceActionBox] = await Promise.all([
    contractEdgeLabel.locator(".structure-edge-select").boundingBox(),
    contractEdgeLabel.locator(".structure-edge-sources > summary").boundingBox(),
  ]);
  expect(labelButtonBox).not.toBeNull();
  expect(sourceActionBox).not.toBeNull();
  expect(sourceActionBox!.x).toBeGreaterThanOrEqual(labelButtonBox!.x + labelButtonBox!.width);
  const labelRightGap = await contractEdgeLabel
    .locator(".structure-edge-select")
    .evaluate((button) => {
      const text = button.querySelector<HTMLElement>(".structure-edge-label-text")!;
      const textRange = document.createRange();
      textRange.selectNodeContents(text);
      return button.getBoundingClientRect().right - textRange.getBoundingClientRect().right;
    });
  expect(labelRightGap).toBeLessThanOrEqual(4.1);
  await contractEdgeLabel.locator(".structure-edge-sources > summary").click();
  await expect(
    contractEdgeLabel.locator(".structure-edge-source-menu .structure-source"),
  ).toHaveCount(2);
  await contractEdgeLabel.locator(".structure-edge-source-menu .structure-source").first().click();
  await expect(
    page.getByRole("tab", { name: "src/shared/contracts/order-detail.ts" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("diffs-container")).toHaveAttribute("data-search-target-line", "1");
  await page.getByRole("tab", { name: fullStackTitle }).click();

  const overlaps = await viewer.evaluate((element) => {
    const nodes = [...element.querySelectorAll<HTMLElement>(".structure-node")].map((node) => ({
      id: node.dataset.nodeId,
      rect: node.getBoundingClientRect(),
    }));
    return [...element.querySelectorAll<HTMLElement>(".structure-edge-label")].flatMap((label) => {
      const rect = label.getBoundingClientRect();
      return nodes
        .filter(
          (node) =>
            rect.right > node.rect.left &&
            rect.left < node.rect.right &&
            rect.bottom > node.rect.top &&
            rect.top < node.rect.bottom,
        )
        .map((node) => `${label.dataset.edgeId}:${node.id}`);
    });
  });
  expect(overlaps).toEqual([]);
});

test("explores source-exact Structures and preserves spatial context across navigation and update", async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/?pullRequestId=${pullRequestId}`);

  const structureFolder = page.getByRole("button", { name: "Structure 3", exact: true });
  await expect(structureFolder).toHaveAttribute("aria-expanded", "false");
  await structureFolder.click();
  await expect(structureFolder).toHaveAttribute("aria-expanded", "true");
  await structureFolder.press("Escape");
  await expect(structureFolder).toHaveAttribute("aria-expanded", "false");
  await structureFolder.click();
  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  await expect(reviewTree.locator(".review-tree-structure")).toHaveCount(3);
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
  await expect(viewer.getByText("16/16 Node · 18/18 Relation", { exact: true })).toBeVisible();
  await expect(viewer.locator('.structure-node[data-node-id="http-routes"]')).toHaveClass(
    /focused/,
  );
  await expect(viewer.locator(".structure-node")).toHaveCount(16);
  await expect(viewer.locator(".structure-edge")).toHaveCount(18);
  await expect(viewer.locator(".structure-edge-label")).toHaveCount(2);
  await expect(viewer).toHaveAttribute("data-viewport-scale", "1.000");
  await expect(viewer.locator(".structure-minimap")).toBeVisible();
  await expect(viewer.locator(".structure-details")).toHaveCount(0);
  await viewer.getByRole("button", { name: "参照をコピー" }).click();
  await expect
    .poll(async () => await page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`rvw://structure/${primaryStructureId}`);

  const canvas = viewer.locator(".structure-canvas");
  await expect
    .poll(async () => {
      const [canvasBox, focusBox] = await Promise.all([
        canvas.boundingBox(),
        viewer.locator('.structure-node[data-node-id="http-routes"]').boundingBox(),
      ]);
      if (!canvasBox || !focusBox) return null;
      return {
        xCentered:
          Math.abs(focusBox.x + focusBox.width / 2 - (canvasBox.x + canvasBox.width / 2)) <= 1,
        yCentered:
          Math.abs(focusBox.y + focusBox.height / 2 - (canvasBox.y + canvasBox.height / 2)) <= 1,
      };
    })
    .toEqual({ xCentered: true, yCentered: true });
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
  await expect(secondaryViewer.locator(".structure-node")).toHaveCount(10);
  await expect(secondaryViewer.locator(".structure-edge")).toHaveCount(15);
  await openStructure(page, primaryTitle);
  await expect(viewer.locator('.structure-node[data-node-id="http-routes"]')).toHaveClass(
    /focused/,
  );
  await expect(viewer.locator(".structure-node")).toHaveCount(16);
  await expect(viewer.locator(".structure-edge")).toHaveCount(18);

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
  expect(titleTextBox!.width).toBeGreaterThan(150);
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

  const firstEdge = viewer.locator('.structure-edge[data-edge-id="controller-executes-handler"]');
  await expect(firstEdge).toHaveAttribute("d", / C /);
  await expect(firstEdge).toHaveAttribute("marker-end", /structure-left-.+-arrow/);
  await expect(firstEdge).toHaveAttribute("data-source-change-kind", "modified");
  const endpointsAreOutsideNodes = await firstEdge.evaluate((element) => {
    const path = element as SVGPathElement;
    const viewerElement = path.closest(".structure-viewer")!;
    const controller = viewerElement.querySelector<HTMLElement>(
      '[data-node-id="http-controller"]',
    )!;
    const hub = viewerElement.querySelector<HTMLElement>('[data-node-id="hub"]')!;
    const pointOutside = (x: number, y: number, node: HTMLElement): boolean => {
      const left = Number.parseFloat(node.style.left);
      const top = Number.parseFloat(node.style.top);
      return x < left || x > left + 228 || y < top || y > top + 112;
    };
    return (
      pointOutside(Number(path.dataset.startX), Number(path.dataset.startY), controller) &&
      pointOutside(Number(path.dataset.endX), Number(path.dataset.endY), hub)
    );
  });
  expect(endpointsAreOutsideNodes).toBe(true);

  const firstEdgeLabel = viewer.locator(
    '.structure-edge-label[data-edge-id="controller-executes-handler"]',
  );
  await expect(firstEdgeLabel).toHaveAttribute("data-source-anchor-count", "2");
  await expect(firstEdgeLabel.locator(".structure-source-identity")).toHaveCount(0);
  await expect(firstEdgeLabel.locator(".structure-edge-sources")).toBeVisible();
  await expect(firstEdgeLabel.locator(".structure-edge-select")).toHaveAccessibleName(
    "Create order controller から Create order へ: HTTP commandとして実行する",
  );

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
      maxLabelDistance: Math.max(
        ...labels.map((label) => {
          const path = element.querySelector<SVGPathElement>(
            `.structure-edge[data-edge-id="${label.id}"]`,
          )!;
          const x = Number.parseFloat(
            element.querySelector<HTMLElement>(`.structure-edge-label[data-edge-id="${label.id}"]`)!
              .style.left,
          );
          const y = Number.parseFloat(
            element.querySelector<HTMLElement>(`.structure-edge-label[data-edge-id="${label.id}"]`)!
              .style.top,
          );
          const length = path.getTotalLength();
          return Math.min(
            ...Array.from({ length: 81 }, (_, index) => {
              const point = path.getPointAtLength((length * index) / 80);
              return Math.hypot(point.x - x, point.y - y);
            }),
          );
        }),
      ),
    };
  });
  expect(graphCollisions.labelNodes).toEqual([]);
  expect(graphCollisions.labelPairs).toEqual([]);
  expect(graphCollisions.allEdgesAreCurved).toBe(true);
  expect(graphCollisions.maxLabelDistance).toBeLessThanOrEqual(49);

  await firstEdgeLabel.locator(".structure-edge-select").click();
  await expect(firstEdge).toHaveClass(/selected/);
  await expect(viewer.locator(".structure-edge.muted")).not.toHaveCount(0);
  await expect(viewer.locator(".structure-edge-label.muted")).not.toHaveCount(0);
  await expect(firstEdgeLabel.locator(".structure-edge-select")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(viewer.locator('.structure-node[data-node-id="http-controller"]')).toHaveClass(
    /edge-endpoint/,
  );
  await expect(viewer.locator('.structure-node[data-node-id="hub"]')).toHaveClass(/edge-endpoint/);
  await firstEdgeLabel.locator(".structure-edge-sources > summary").click();
  await expect(firstEdgeLabel.locator(".structure-edge-source-menu .structure-source")).toHaveCount(
    2,
  );
  await firstEdgeLabel.locator(".structure-edge-select").click();
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
  await expect(viewer.getByText("14/16 Node · 15/18 Relation", { exact: true })).toBeVisible();
  await expect(viewer.locator('.structure-node[data-node-id="pricing-policy"]')).toBeVisible();
  const localViewport = await viewer
    .locator(".structure-world")
    .evaluate((element) => (element as HTMLElement).style.transform);
  expect(localViewport).toBe(viewportBeforeNeighborhood);
  await viewer.getByRole("button", { name: "全体", exact: true }).click();
  await expect(viewer.getByText("16/16 Node · 18/18 Relation", { exact: true })).toBeVisible();
  await expect(viewer.locator(".structure-edge-label")).toHaveCount(9);
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
  await expect(viewer.locator(".structure-edge-label")).toHaveCount(18);
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
    "src/application/orders/create-order.ts:9-37を開く",
  );
  await hubSourceAction.click();
  await expect(
    page.getByRole("tab", { name: "src/application/orders/create-order.ts" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('.document-pane[data-pane="left"] diffs-container')).toHaveAttribute(
    "data-search-target-line",
    "9",
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
      const toolbarFits = await viewer
        .locator(".structure-toolbar")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
      return (
        toolbarFits &&
        toolbarBox.x + toolbarBox.width <= viewerBox.x + viewerBox.width + 1 &&
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
  await expect(rightViewer.getByText("16/16 Node · 18/18 Relation", { exact: true })).toBeVisible();
  await expect(leftViewer.getByText("9/16 Node · 9/18 Relation", { exact: true })).toBeVisible();
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
    { data: { clearFocus: true, replacementFocus: "http-controller" } },
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
  await expect(viewer.getByText("16/16 Node · 10/10 Relation", { exact: true })).toBeVisible();

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
  await expect(secondaryViewer.locator(".structure-edge-label")).toHaveCount(3);
  await secondaryViewer.getByRole("button", { name: "表示中を収める" }).click();
  await secondaryViewer.locator('.structure-node[data-node-id="idempotency-store"]').click();
  await secondaryViewer.getByRole("button", { name: "表示中を収める" }).click();
  await expect
    .poll(async () => {
      const [canvasBounds, loopBounds, labelBounds] = await Promise.all([
        secondaryViewer.locator(".structure-canvas").boundingBox(),
        secondaryViewer
          .locator('.structure-edge[data-edge-id="idempotency-reuses-result"]')
          .boundingBox(),
        secondaryViewer
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
  await page.setViewportSize({ width: 900, height: 700 });
  const [toolbarBox, canvasBox, viewerBox] = await Promise.all([
    secondaryViewer.locator(".structure-toolbar").boundingBox(),
    secondaryViewer.locator(".structure-canvas-shell").boundingBox(),
    secondaryViewer.boundingBox(),
  ]);
  expect(toolbarBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(viewerBox).not.toBeNull();
  expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(
    viewerBox!.x + viewerBox!.width + 1,
  );
  expect(
    await secondaryViewer
      .locator(".structure-toolbar")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  expect(canvasBox!.y + canvasBox!.height).toBeLessThanOrEqual(
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
  await expect(page.getByRole("button", { name: "Structure 2", exact: true })).toBeVisible();
});
