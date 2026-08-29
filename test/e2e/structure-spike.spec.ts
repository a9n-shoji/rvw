import { expect, test, type Page } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";

async function openStructure(page: Page, title: string): Promise<void> {
  const group = page.getByRole("button", { name: "Structure Spike 10" });
  if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(page.locator(".structure-header h2")).toHaveText(title);
}

async function showStructureInspector(page: Page) {
  const inspector = page.locator(".structure-inspector");
  await expect(inspector).toHaveCount(0);
  await page.getByRole("button", { name: "詳細サイドバーを表示" }).click();
  await expect(inspector).toBeVisible();
  return inspector;
}

async function edgeLabelNodeOverlaps(page: Page): Promise<string[]> {
  return await page.locator(".structure-world").evaluate((world) => {
    const nodes = [...world.querySelectorAll<HTMLElement>(".structure-node")].map((node) => ({
      id: node.dataset.nodeId,
      rect: node.getBoundingClientRect(),
    }));
    return [...world.querySelectorAll<HTMLElement>(".structure-edge-label")].flatMap((label) => {
      const labelRect = label.getBoundingClientRect();
      return nodes
        .filter(
          ({ rect }) =>
            !(
              labelRect.right <= rect.left ||
              labelRect.left >= rect.right ||
              labelRect.bottom <= rect.top ||
              labelRect.top >= rect.bottom
            ),
        )
        .map(({ id }) => `${label.dataset.edgeId}:${id}`);
    });
  });
}

async function edgeEndpointsInsideNodes(page: Page): Promise<string[]> {
  return await page.locator(".structure-world").evaluate((world) => {
    const inside = (point: DOMPoint, rect: DOMRect): boolean =>
      point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom;
    return [
      ...world.querySelectorAll<SVGPathElement>(".structure-edges > path[data-edge-id]"),
    ].flatMap((path) => {
      const transform = path.getScreenCTM();
      const fromId = path.dataset.fromNodeId;
      const toId = path.dataset.toNodeId;
      if (!transform || !fromId || !toId) return [];
      const fromNode = world.querySelector<HTMLElement>(
        `.structure-node[data-node-id="${CSS.escape(fromId)}"]`,
      );
      const toNode = world.querySelector<HTMLElement>(
        `.structure-node[data-node-id="${CSS.escape(toId)}"]`,
      );
      if (!fromNode || !toNode) return [];
      const start = path.getPointAtLength(0).matrixTransform(transform);
      const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(transform);
      return [
        ...(inside(start, fromNode.getBoundingClientRect()) ? [`${path.dataset.edgeId}:from`] : []),
        ...(inside(end, toNode.getBoundingClientRect()) ? [`${path.dataset.edgeId}:to`] : []),
      ];
    });
  });
}

test("explores dependencies around a concrete class without imposing a reading order", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, "RvwServiceのコード依存関係");

  const structure = page.locator(".structure-viewer");
  const focusedNode = page.locator('.structure-node[data-node-id="rvw-service-class"]');
  await expect(focusedNode).toHaveAttribute("data-node-notation", "class");
  await expect(page.locator('.structure-node[data-node-id="rvw-database-class"]')).toHaveAttribute(
    "data-node-notation",
    "database",
  );
  await expect(page.locator('.structure-node[data-node-id="github-port"]')).toHaveAttribute(
    "data-node-notation",
    "interface",
  );
  await expect(focusedNode).toContainText(
    "RVWのapplication use caseをまとめるclass。DB、Git、GitHubをconstructorから受け取り",
  );
  const longRelationLabel = page.locator(
    '.structure-edge-label[data-edge-id="service-code-18"] .structure-edge-select',
  );
  await expect(longRelationLabel).toHaveText("Runtime.service経由でuse caseを呼ぶ");
  const labelLayout = await longRelationLabel.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }));
  expect(labelLayout.whiteSpace).toBe("normal");
  expect(labelLayout.scrollHeight).toBeLessThanOrEqual(labelLayout.clientHeight + 1);
  expect(labelLayout.scrollWidth).toBeLessThanOrEqual(labelLayout.clientWidth + 1);

  const notationClearance = await page.locator(".structure-world").evaluate((world) => {
    const component = world.querySelector<HTMLElement>(
      '.structure-node[data-node-id="runtime-composition"]',
    );
    const database = world.querySelector<HTMLElement>(
      '.structure-node[data-node-id="rvw-database-class"]',
    );
    const componentDescription = component?.querySelector<HTMLElement>(
      ".structure-node-description",
    );
    const databaseKind = database?.querySelector<HTMLElement>(".structure-node-select small");
    if (!component || !database || !componentDescription || !databaseKind) return null;
    return {
      componentTextInset:
        componentDescription.getBoundingClientRect().left - component.getBoundingClientRect().left,
      databaseKindInset:
        databaseKind.getBoundingClientRect().top - database.getBoundingClientRect().top,
    };
  });
  expect(notationClearance).not.toBeNull();
  expect(notationClearance!.componentTextInset).toBeGreaterThanOrEqual(29);
  expect(notationClearance!.databaseKindInset).toBeGreaterThanOrEqual(33);
  expect(await edgeEndpointsInsideNodes(page)).toEqual([]);

  const inspector = await showStructureInspector(page);
  await expect(inspector.getByRole("heading", { level: 3 })).toHaveText("RvwService class");
  await expect(structure).toHaveAttribute("data-visible-node-count", "9");
  await expect(
    page.getByRole("button", { name: /折りたたまれたRelation 5件を展開/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Walkthrough Mermaidと比較" })).toHaveCount(0);
  expect(await edgeLabelNodeOverlaps(page)).toEqual([]);

  await page
    .locator('.structure-node[data-node-id="rvw-database-class"] .structure-node-select')
    .click();
  await expect(inspector.getByRole("heading", { level: 3 })).toHaveText("RvwDatabase class");
  await expect(inspector).toContainText("constructorで永続化dependencyを要求する");

  await inspector
    .locator(
      '> .structure-source-button[aria-label="src/infrastructure/db/database.ts:L354–399をソースで開く"]',
    )
    .click();
  const leftPane = page.getByRole("region", { name: "左のコードペイン" });
  await expect(
    leftPane.getByRole("tab", { name: "src/infrastructure/db/database.ts", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await leftPane.getByRole("tab", { name: "RvwServiceのコード依存関係", exact: true }).click();
  await expect(inspector.getByRole("heading", { level: 3 })).toHaveText("RvwDatabase class");

  await openStructure(page, "document-workspace moduleの関連コード");
  const workspaceInspector = await showStructureInspector(page);
  await expect(workspaceInspector.getByRole("heading", { level: 3 })).toHaveText(
    "ActiveDocument union",
  );
  await expect(structure).toHaveAttribute("data-visible-node-count", "8");
});

test("explores both sides of a Rails View and React mount boundary", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, "Rails ViewとReact rootをまたぐ求人検索ページ");

  const structure = page.locator(".structure-viewer");
  await expect(structure).toHaveAttribute("data-total-node-count", "16");
  await expect(structure).toHaveAttribute("data-visible-node-count", "3");
  await expect(page.getByRole("button", { name: "Walkthrough Mermaidと比較" })).toHaveCount(0);

  const positions = await page.locator(".structure-world").evaluate((world) =>
    Object.fromEntries(
      ["jobs-index-view", "jobs-dom-mount-contract", "jobs-react-entry"].map((nodeId) => {
        const value = world
          .querySelector<HTMLElement>(`.structure-node[data-node-id="${nodeId}"]`)
          ?.dataset.nodePosition?.split(",")[0];
        return [nodeId, Number(value)];
      }),
    ),
  );
  expect(positions["jobs-index-view"]).toBeLessThan(positions["jobs-dom-mount-contract"]!);
  expect(positions["jobs-react-entry"]).toBeGreaterThan(positions["jobs-dom-mount-contract"]!);
  await page.getByRole("button", { name: "全体", exact: true }).click();
  const longNodeTitle = page.locator(
    '.structure-node[data-node-id="job-search-result"] .structure-node-title-text',
  );
  await expect(longNodeTitle).toHaveText("JobSearchService::SearchResult");
  await expect(longNodeTitle.locator("wbr")).toHaveCount(1);
  const longNodeTitleLayout = await longNodeTitle.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));
  expect(longNodeTitleLayout.scrollWidth).toBeLessThanOrEqual(longNodeTitleLayout.clientWidth);
  expect(longNodeTitleLayout.scrollHeight).toBeLessThanOrEqual(longNodeTitleLayout.clientHeight);
  expect(longNodeTitleLayout.clientHeight).toBeGreaterThan(longNodeTitleLayout.lineHeight * 1.5);
  await page.getByRole("button", { name: "1-hop" }).click();
  await expect(
    page.locator('.structure-node[data-node-id="jobs-dom-mount-contract"]'),
  ).toContainText("Rails ViewとReact entryが共有する境界");
  const boundaryKindInset = await page
    .locator('.structure-node[data-node-id="jobs-dom-mount-contract"] .structure-node-select')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingLeft));
  expect(boundaryKindInset).toBeGreaterThanOrEqual(36);

  const viewSourceIdentity = page.locator(
    '.structure-node[data-node-id="jobs-index-view"] .structure-node-title .structure-source-identity',
  );
  await expect(viewSourceIdentity).toHaveAttribute(
    "data-source-path",
    "test/fixtures/structure-spike/rails-react-page/app/views/jobs/index.html.erb",
  );
  await expect(viewSourceIdentity.locator("[data-file-icon]")).toBeVisible();
  await expect(viewSourceIdentity.locator('[data-change-kind="modified"]')).toBeVisible();

  const reactSourceIdentity = page.locator(
    '.structure-node[data-node-id="jobs-react-entry"] .structure-node-title .structure-source-identity',
  );
  await expect(reactSourceIdentity.locator("[data-file-icon]")).toBeVisible();
  await expect(reactSourceIdentity.locator('[data-change-kind="added"]')).toBeVisible();

  const sourceOutlineColors = await page.locator(".structure-world").evaluate((world) => {
    const nodeBorder = (nodeId: string): string => {
      const select = world.querySelector<HTMLElement>(
        `.structure-node[data-node-id="${nodeId}"] .structure-node-select`,
      );
      return select ? getComputedStyle(select).borderTopColor : "";
    };
    const edgeLabelBorder = (edgeId: string): string => {
      const select = world.querySelector<HTMLElement>(
        `.structure-edge-label[data-edge-id="${edgeId}"] .structure-edge-select`,
      );
      return select ? getComputedStyle(select).borderTopColor : "";
    };
    const edgeStroke = (edgeId: string): string => {
      const path = world.querySelector<SVGPathElement>(
        `.structure-edges > path[data-edge-id="${edgeId}"]`,
      );
      return path ? getComputedStyle(path).stroke : "";
    };
    const nodeTheme = (nodeId: string): string => {
      const node = world.querySelector<HTMLElement>(`.structure-node[data-node-id="${nodeId}"]`);
      return node ? getComputedStyle(node).getPropertyValue("--structure-node-theme").trim() : "";
    };
    const componentDecoration = (nodeId: string): string => {
      const select = world.querySelector<HTMLElement>(
        `.structure-node[data-node-id="${nodeId}"] .structure-node-select`,
      );
      return select ? getComputedStyle(select).boxShadow : "";
    };
    return {
      unchangedNode: nodeBorder("jobs-dom-mount-contract"),
      modifiedNode: nodeBorder("jobs-index-view"),
      addedNode: nodeBorder("jobs-react-entry"),
      modifiedEdgeLabel: edgeLabelBorder("rails-react-12"),
      addedEdgeLabel: edgeLabelBorder("rails-react-13"),
      modifiedEdgeStroke: edgeStroke("rails-react-12"),
      addedEdgeStroke: edgeStroke("rails-react-13"),
      unchangedNodeTheme: nodeTheme("jobs-dom-mount-contract"),
      modifiedNodeTheme: nodeTheme("jobs-index-view"),
      addedNodeTheme: nodeTheme("jobs-react-entry"),
      modifiedComponentDecoration: componentDecoration("jobs-index-view"),
      addedComponentDecoration: componentDecoration("jobs-react-entry"),
    };
  });
  expect(sourceOutlineColors.modifiedNode).not.toBe(sourceOutlineColors.unchangedNode);
  expect(sourceOutlineColors.addedNode).not.toBe(sourceOutlineColors.unchangedNode);
  expect(sourceOutlineColors.modifiedNode).not.toBe(sourceOutlineColors.addedNode);
  expect(sourceOutlineColors.modifiedEdgeLabel).not.toBe(sourceOutlineColors.addedEdgeLabel);
  expect(sourceOutlineColors.modifiedEdgeStroke).toBe(sourceOutlineColors.addedEdgeStroke);
  expect(sourceOutlineColors.modifiedNodeTheme).not.toBe(sourceOutlineColors.unchangedNodeTheme);
  expect(sourceOutlineColors.addedNodeTheme).not.toBe(sourceOutlineColors.unchangedNodeTheme);
  expect(sourceOutlineColors.modifiedNodeTheme).not.toBe(sourceOutlineColors.addedNodeTheme);
  expect(sourceOutlineColors.modifiedComponentDecoration).not.toBe(
    sourceOutlineColors.addedComponentDecoration,
  );

  const viewEdgeIdentity = page.locator(
    '.structure-edge-label[data-edge-id="rails-react-12"] .structure-edge-select .structure-source-identity',
  );
  await expect(viewEdgeIdentity.locator("[data-file-icon]")).toBeVisible();
  await expect(viewEdgeIdentity.locator('[data-change-kind="modified"]')).toBeVisible();
  const edgeIdentityOrder = await viewEdgeIdentity.evaluate((identity) => {
    const text = identity.parentElement?.querySelector<HTMLElement>(".structure-edge-label-text");
    return text ? identity.getBoundingClientRect().left < text.getBoundingClientRect().left : false;
  });
  expect(edgeIdentityOrder).toBe(true);
  const edgeIdentityGap = await viewEdgeIdentity.evaluate((identity) => {
    const text = identity.parentElement?.querySelector<HTMLElement>(".structure-edge-label-text");
    return text
      ? text.getBoundingClientRect().left - identity.getBoundingClientRect().right
      : Number.POSITIVE_INFINITY;
  });
  expect(edgeIdentityGap).toBeLessThanOrEqual(3.5);

  await page.getByRole("button", { name: "2-hop" }).click();
  await expect(structure).toHaveAttribute("data-visible-node-count", "6");
  await expect(page.locator('.structure-node[data-node-id="jobs-controller"]')).toBeVisible();
  await expect(page.locator('.structure-node[data-node-id="jobs-page-component"]')).toBeVisible();
  expect(await edgeLabelNodeOverlaps(page)).toEqual([]);
  expect(await edgeEndpointsInsideNodes(page)).toEqual([]);

  await page
    .locator('.structure-node[data-node-id="jobs-index-view"] .structure-source-button')
    .click();
  const leftPane = page.getByRole("region", { name: "左のコードペイン" });
  await expect(
    leftPane.getByRole("tab", {
      name: "test/fixtures/structure-spike/rails-react-page/app/views/jobs/index.html.erb",
      exact: true,
    }),
  ).toHaveAttribute("aria-selected", "true");
  await leftPane
    .getByRole("tab", { name: "Rails ViewとReact rootをまたぐ求人検索ページ", exact: true })
    .click();
  await expect(
    page.locator('.structure-node[data-node-id="jobs-dom-mount-contract"] .structure-node-select'),
  ).toHaveAttribute("aria-pressed", "true");

  await page
    .locator('.structure-node[data-node-id="jobs-page-component"] .structure-node-select')
    .click();
  await page.getByRole("button", { name: "1-hop" }).click();
  await expect(page.locator('.structure-node[data-node-id="search-form-component"]')).toBeVisible();
  const reciprocalEdgeClearance = await page.locator(".structure-world").evaluate((world) => {
    const midpoint = (edgeId: string): DOMPoint | null => {
      const path = world.querySelector<SVGPathElement>(
        `.structure-edges > path[data-edge-id="${edgeId}"]`,
      );
      const transform = path?.getScreenCTM();
      if (!path || !transform) return null;
      return path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(transform);
    };
    const forward = midpoint("rails-react-16");
    const reverse = midpoint("rails-react-17");
    return forward && reverse ? Math.hypot(forward.x - reverse.x, forward.y - reverse.y) : 0;
  });
  expect(reciprocalEdgeClearance).toBeGreaterThanOrEqual(20);
  expect(await edgeEndpointsInsideNodes(page)).toEqual([]);
});

test("explores repository claims, preserves focus across source navigation, and compares Mermaid", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, "コメント監視フロー");

  const structure = page.locator(".structure-viewer");
  const inspector = await showStructureInspector(page);
  await expect(inspector.getByRole("heading", { level: 3 })).toHaveText(
    "DB全体で順序付けされた投稿イベント列",
  );
  await expect(structure).toHaveAttribute("data-visible-node-count", "4");

  await page
    .locator('.structure-node[data-node-id="watch-application"] .structure-node-select')
    .click();
  await expect(inspector.getByRole("heading", { level: 3 })).toHaveText(
    "Applicationが不透明なカーソルを有限件のイベントページへ解決する",
  );
  const oneHopCount = Number(await structure.getAttribute("data-visible-node-count"));
  await page.getByRole("button", { name: "2-hop" }).click();
  const twoHopCount = Number(await structure.getAttribute("data-visible-node-count"));
  expect(twoHopCount).toBeGreaterThan(oneHopCount);

  await page.getByRole("button", { name: "1-hop" }).click();
  expect(await edgeLabelNodeOverlaps(page)).toEqual([]);

  const focusBeforeSource = await inspector.getByRole("heading", { level: 3 }).innerText();
  await inspector
    .locator(
      '> .structure-source-button[aria-label="src/application/rvw-service.ts:L1493–1524をソースで開く"]',
    )
    .click();
  const leftPane = page.getByRole("region", { name: "左のコードペイン" });
  await expect(
    leftPane.getByRole("tab", { name: "src/application/rvw-service.ts", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await leftPane.getByRole("tab", { name: "コメント監視フロー", exact: true }).click();
  await expect(inspector.getByRole("heading", { level: 3 })).toHaveText(focusBeforeSource);

  await page
    .locator('.structure-node[data-node-id="ordered-event-log"] .structure-node-select')
    .click();
  await inspector
    .locator(
      '> .structure-source-button[aria-label="src/infrastructure/db/database.ts:L544–569をソースで開く"]',
    )
    .click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  const rightPane = page.getByRole("region", { name: "右のコードペイン" });
  await expect(
    rightPane.getByRole("tab", { name: "src/infrastructure/db/database.ts", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(leftPane.getByRole("heading", { name: "コメント監視フロー" })).toBeVisible();

  await leftPane.getByRole("tab", { name: "コメント監視フロー", exact: true }).click();
  await page.getByRole("button", { name: "Walkthrough Mermaidと比較" }).click();
  const comparison = page.getByRole("dialog", { name: "Walkthrough Mermaid比較" });
  await expect(comparison.locator("svg")).toBeVisible();
  await expect(comparison).toContainText("Authorが構成した図を読む比較surface");
});

test("keeps stable positions through an update and stages 20, 100, and 500 node fixtures", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openStructure(page, "合成グラフ 20 Node · 混合トポロジー");
  const structure = page.locator(".structure-viewer");
  const rootNode = page.locator('.structure-node[data-node-id="node-000"]');
  await showStructureInspector(page);

  await expect(
    page.getByRole("button", { name: /折りたたまれたRelation 14件を展開/ }),
  ).toBeVisible();
  const collapsedEdges = Number(await structure.getAttribute("data-visible-edge-count"));
  await page.getByRole("button", { name: /折りたたまれたRelation 14件を展開/ }).click();
  await expect(page.getByRole("button", { name: "Relationを折りたたむ" })).toBeVisible();
  expect(Number(await structure.getAttribute("data-visible-edge-count"))).toBeGreaterThan(
    collapsedEdges,
  );

  const baselinePosition = await rootNode.getAttribute("data-node-position");
  await page.getByRole("button", { name: "current value更新を再現" }).click();
  await expect(structure).toHaveAttribute("data-current-value", "updated");
  await expect(rootNode).toHaveAttribute("data-node-position", baselinePosition!);

  const originalScale = Number(await structure.getAttribute("data-viewport-scale"));
  await page.getByRole("button", { name: "拡大" }).click();
  expect(Number(await structure.getAttribute("data-viewport-scale"))).toBeGreaterThan(
    originalScale,
  );

  await openStructure(page, "合成グラフ 100 Node · 混合トポロジー");
  await expect(structure).toHaveAttribute("data-total-node-count", "100");
  await expect(page.locator(".structure-node-select[aria-pressed='true']")).toHaveCount(1);

  await openStructure(page, "合成グラフ 500 Node · 混合トポロジー");
  await expect(structure).toHaveAttribute("data-total-node-count", "500");
  expect(Number(await structure.getAttribute("data-visible-node-count"))).toBeLessThan(50);
  await page.getByRole("button", { name: "全体", exact: true }).click();
  await expect(structure).toHaveAttribute("data-visible-node-count", "500");
  await expect(structure).toHaveAttribute("data-visible-edge-count", "975");
  const renderedNodeCount = Number(await structure.getAttribute("data-rendered-node-count"));
  expect(renderedNodeCount).toBeGreaterThan(0);
  expect(renderedNodeCount).toBeLessThan(500);
});
