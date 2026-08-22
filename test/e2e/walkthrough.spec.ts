import { expect, test, type Locator, type Page } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const primaryWalkthrough = "注文作成フロー：HTTPからtransactional outboxまで";
const markdownShowcase = "Markdown表現デモ：レビューコメントのショーケース";

async function openWalkthroughFromSidebar(page: Page, title: string): Promise<void> {
  const walkthroughsFolder = page.getByRole("button", { name: /^ウォークスルー \d+$/ });
  if ((await walkthroughsFolder.getAttribute("aria-expanded")) !== "true") {
    await walkthroughsFolder.click();
  }
  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  await reviewTree.getByRole("button", { name: title, exact: true }).click();
}

async function openCommentsSidebar(page: Page): Promise<void> {
  const toggle = page.locator(".sidebar-stack--comments > .sidebar-stack-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function selectMappedText(locator: Locator, firstCharacterOnly = false): Promise<void> {
  await expect(locator).toBeVisible();
  await locator.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "nearest" });
  });
  await expect(locator).toBeVisible();
  await locator.evaluate((element, selectFirstCharacter) => {
    const text = element.firstChild;
    if (!(text instanceof Text) || text.data.length === 0) {
      throw new Error("Expected a non-empty mapped text node.");
    }
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, selectFirstCharacter ? 1 : text.data.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  }, firstCharacterOnly);
}

async function dragNativeText(page: Page, start: Locator, end: Locator = start): Promise<string> {
  await start.scrollIntoViewIfNeeded();
  if (end !== start) {
    await end.scrollIntoViewIfNeeded();
  }
  const textRect = async (locator: Locator) =>
    await locator.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
  const [startRect, endRect] = await Promise.all([textRect(start), textRect(end)]);
  await page.mouse.move(startRect.x + 1, startRect.y + startRect.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    endRect.x + Math.max(2, endRect.width - 1),
    endRect.y + endRect.height / 2,
    { steps: 10 },
  );
  const duringDrag = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  await page.mouse.up();
  return duringDrag;
}

test("keeps agent explanation passive until a human opens an exact code reference", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await expect(
    page.locator(".topbar").getByRole("heading", { name: "Fixture review updated" }),
  ).toBeVisible();

  const walkthroughShortcut = page.getByRole("button", {
    name: "ウォークスルー 5",
    exact: true,
  });
  await expect(page.getByRole("button", { name: "Pull Request.md", exact: true })).toBeVisible();
  await expect(walkthroughShortcut).toHaveAttribute("aria-expanded", "false");
  await walkthroughShortcut.click();
  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  await expect(reviewTree.locator(".review-tree-walkthrough")).toHaveCount(5);
  await reviewTree.getByRole("button", { name: primaryWalkthrough, exact: true }).click();

  await expect(page.getByRole("tab", { name: primaryWalkthrough })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(walkthroughShortcut).toHaveAttribute("aria-expanded", "true");
  await expect(reviewTree.locator(".review-tree-walkthrough")).toHaveCount(5);
  await expect(
    reviewTree.getByRole("button", { name: primaryWalkthrough, exact: true }),
  ).toHaveAttribute(
    "title",
    `${primaryWalkthrough}\nCodex · implementation walkthrough · cccccccc`,
  );
  const [walkthroughFolderColor, repositoryFolderColor] = await Promise.all([
    walkthroughShortcut.evaluate((element) => getComputedStyle(element).color),
    page
      .getByRole("button", { name: "src フォルダ", exact: true })
      .evaluate((element) => getComputedStyle(element).color),
  ]);
  expect(walkthroughFolderColor).toBe(repositoryFolderColor);
  const walkthroughCountGap = await walkthroughShortcut.evaluate((element) => {
    const label = element.querySelector(".file-tree-label");
    const count = element.querySelector(".review-tree-count");
    if (!(label instanceof HTMLElement) || !(count instanceof HTMLElement)) return -1;
    return count.getBoundingClientRect().left - label.getBoundingClientRect().right;
  });
  expect(walkthroughCountGap).toBeCloseTo(4, 0);
  await expect(page.getByRole("heading", { name: "注文作成フローの全体像" })).toBeVisible();
  await expect(
    page.getByRole("img", { name: "画像: External walkthrough（自動読み込み停止）" }),
  ).toBeVisible();
  await expect(page.locator('img[src="https://example.invalid/walkthrough.png"]')).toHaveCount(0);
  await expect(page.locator(".walkthrough-viewer-header .walkthrough-meta")).toHaveCount(0);
  await expect(page.getByText("Code references", { exact: true })).toHaveCount(0);
  await expect(page.locator(".document-tabs").getByRole("tab")).toHaveCount(2);
  await expect(page.locator(".walkthrough-diagram svg")).toBeVisible();
  await expect(page.locator(".walkthrough-diagram-node--linked")).toHaveCount(9);
  await expect(page.locator(".walkthrough-diagram-node--linked").first()).toHaveCSS(
    "cursor",
    "pointer",
  );
  const commitPicker = page.getByRole("button", { name: /^対象commit:/ });
  const initialCommitSelection = await commitPicker.getAttribute("aria-label");
  expect(initialCommitSelection).not.toBeNull();
  await expect(
    page.locator(".walkthrough-diagram-node--linked").first().locator("rect").first(),
  ).toHaveCSS("stroke-width", "1.6px");
  await page
    .locator(".walkthrough-diagram svg")
    .first()
    .evaluate((element) => element.setAttribute("data-render-instance", "initial"));

  const handlerReference = page
    .locator(".walkthrough-markdown .walkthrough-inline-reference")
    .filter({ hasText: "CreateOrderHandler.execute" });
  await handlerReference.click({ modifiers: ["Meta"] });

  const handlerTab = page.getByRole("tab", {
    name: "src/application/orders/create-order.ts",
  });
  await expect(handlerTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: primaryWalkthrough })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator('.document-pane[data-pane="right"]')).toBeVisible();
  await expect(commitPicker).toHaveAttribute("aria-label", initialCommitSelection!);
  await expect(page.locator(".document-tabs").getByRole("tab")).toHaveCount(3);
  await expect(page.locator('.document-pane[data-pane="right"] diffs-container')).toHaveAttribute(
    "data-search-target-line",
    "9",
  );
  const firstSelectedHandlerLine = page
    .locator(
      '.document-pane[data-pane="right"] diffs-container [data-line="9"][data-selected-line="first"]',
    )
    .first();
  await expect(firstSelectedHandlerLine).toBeVisible();
  await expect(firstSelectedHandlerLine).toHaveCSS("box-shadow", "none");
  await expect(
    page
      .locator(
        '.document-pane[data-pane="right"] diffs-container [data-line="39"][data-selected-line="last"]',
      )
      .first(),
  ).toBeVisible();
  await expect(
    page.locator('.walkthrough-diagram svg[data-render-instance="initial"]'),
  ).toHaveCount(1);
  await page
    .locator('.document-pane[data-pane="right"] diffs-container [data-column-number="9"]')
    .first()
    .click();
  await expect(
    page
      .locator(
        '.document-pane[data-pane="right"] diffs-container [data-line="9"][data-selected-line="first"]',
      )
      .first(),
  ).toBeVisible();
  await expect(
    page.locator('.document-pane[data-pane="right"] .inline-comment-composer--line'),
  ).toBeVisible();
  await expect(
    page.locator(
      '.document-pane[data-pane="right"] diffs-container [data-line="39"][data-selected-line]',
    ),
  ).toHaveCount(0);
  await expect(
    page.locator('.walkthrough-diagram svg[data-render-instance="initial"]'),
  ).toHaveCount(1);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(
    page.locator('.walkthrough-diagram svg[data-render-instance="initial"]'),
  ).toHaveCount(0);
  await expect(page.locator(".walkthrough-diagram svg")).toBeVisible();

  const activeTabIndicator = await page
    .locator(".document-pane.active .document-tab.active")
    .evaluate((element) => {
      const tab = element.getBoundingClientRect();
      const indicator = getComputedStyle(element, "::before");
      return {
        tabWidth: tab.width,
        indicatorWidth: Number.parseFloat(indicator.width),
        indicatorLeft: Number.parseFloat(indicator.left),
        indicatorRight: Number.parseFloat(indicator.right),
      };
    });
  expect(activeTabIndicator.indicatorLeft).toBe(0);
  expect(activeTabIndicator.indicatorRight).toBe(0);
  expect(activeTabIndicator.indicatorWidth).toBeLessThanOrEqual(activeTabIndicator.tabWidth);
  expect(activeTabIndicator.tabWidth - activeTabIndicator.indicatorWidth).toBeLessThanOrEqual(1);
  for (const shell of await page.locator(".document-tabs-shell").all()) {
    await expect(shell).toHaveCSS("box-shadow", "none");
  }

  const walkthroughHeader = page.locator(
    '.document-pane[data-pane="left"] .walkthrough-viewer-header',
  );
  const headerBoxes = await Promise.all([
    walkthroughHeader.locator(".walkthrough-viewer-title").boundingBox(),
    walkthroughHeader.locator(".walkthrough-comment-button").boundingBox(),
  ]);
  const overlaps = (
    first: NonNullable<(typeof headerBoxes)[number]>,
    second: NonNullable<(typeof headerBoxes)[number]>,
  ) =>
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y;
  expect(headerBoxes.every((box) => box !== null)).toBe(true);
  expect(overlaps(headerBoxes[0]!, headerBoxes[1]!)).toBe(false);
  await expect(walkthroughHeader.locator(".walkthrough-comment-button")).toBeInViewport();
  expect(
    await walkthroughHeader.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);

  const routeReference = page
    .locator(".walkthrough-markdown .walkthrough-inline-reference")
    .filter({ hasText: "POST /orders" });
  await routeReference.click();
  await expect(page.getByRole("tab", { name: "src/http/routes/orders.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator('.document-pane[data-pane="left"] diffs-container')).toHaveAttribute(
    "data-search-target-line",
    "10",
  );

  await page.getByRole("tab", { name: primaryWalkthrough }).click();
  const fileReference = page
    .locator(".walkthrough-markdown .walkthrough-inline-reference")
    .filter({ hasText: "application composition" });
  await expect(fileReference.locator("small")).toHaveText("File");
  await expect(fileReference).toHaveAttribute("title", "src/bootstrap/application.ts");
  await fileReference.click();
  await expect(page.getByRole("tab", { name: "src/bootstrap/application.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.locator('.document-pane[data-pane="left"] diffs-container'),
  ).not.toHaveAttribute("data-search-target-line");

  await page.getByRole("tab", { name: primaryWalkthrough }).click();
  await expect(page.getByRole("heading", { name: "注文作成フローの全体像" })).toBeVisible();
  const orderDiagramNode = page.getByRole("button", { name: "Order.placeをコードで開く" });
  await expect(orderDiagramNode).toBeVisible();
  await orderDiagramNode.dispatchEvent("pointerdown", { metaKey: true });

  await expect(page.getByRole("tab", { name: "src/domain/orders/order.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator('.document-pane[data-pane="right"] diffs-container')).toHaveAttribute(
    "data-search-target-line",
    "21",
  );
  await expect(page.getByRole("tab", { name: primaryWalkthrough })).toBeVisible();
  await expect(handlerTab).toBeVisible();
});

test("falls back to full text for an unchanged file opened from a Walkthrough reference", async ({
  page,
}) => {
  const historicalWalkthroughOid = "b".repeat(40);
  await page.route("**/api/pull-requests/*/walkthroughs**", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      walkthroughs?: Array<{ title: string; sourceOid: string }>;
      walkthrough?: { title: string; sourceOid: string };
    };
    if (body.walkthroughs) {
      body.walkthroughs = body.walkthroughs.map((walkthrough) =>
        walkthrough.title === primaryWalkthrough
          ? { ...walkthrough, sourceOid: historicalWalkthroughOid }
          : walkthrough,
      );
    }
    if (body.walkthrough?.title === primaryWalkthrough) {
      body.walkthrough = { ...body.walkthrough, sourceOid: historicalWalkthroughOid };
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const reviewScope = page.getByRole("region", { name: "レビュー範囲", exact: true });
  const displayDiffButton = reviewScope.getByRole("button", { name: "変更", exact: true });

  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  await expect(displayDiffButton).toHaveAttribute("aria-pressed", "true");
  await openWalkthroughFromSidebar(page, primaryWalkthrough);
  const destinationDocumentRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname.endsWith("/document") &&
      url.searchParams.get("path") === "src/bootstrap/application.ts" &&
      url.searchParams.get("sourceOid") === "c".repeat(40)
    );
  });
  await page
    .locator(".walkthrough-markdown .walkthrough-inline-reference")
    .filter({ hasText: "application composition" })
    .click();
  await destinationDocumentRequest;

  await expect(page.getByRole("tab", { name: "src/bootstrap/application.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(displayDiffButton).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText(/参照元 b{8} ≠ 対象 c{8} · 差分なし · 全文表示/, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("export const application = {", { exact: true })).toBeVisible();
  await expect(reviewScope.getByRole("button", { name: "stacked", exact: true })).toBeDisabled();
  await expect(reviewScope.getByRole("button", { name: "split", exact: true })).toBeDisabled();
});

test("keeps the PR range while switching a Walkthrough reference diff to split", async ({
  page,
}) => {
  const historicalWalkthroughOid = "b".repeat(40);
  await page.route("**/api/pull-requests/*/walkthroughs**", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      walkthroughs?: Array<{ title: string; sourceOid: string }>;
      walkthrough?: { title: string; sourceOid: string };
    };
    if (body.walkthroughs) {
      body.walkthroughs = body.walkthroughs.map((walkthrough) =>
        walkthrough.title === primaryWalkthrough
          ? { ...walkthrough, sourceOid: historicalWalkthroughOid }
          : walkthrough,
      );
    }
    if (body.walkthrough?.title === primaryWalkthrough) {
      body.walkthrough = { ...body.walkthrough, sourceOid: historicalWalkthroughOid };
    }
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/pull-requests/*/changed-files?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      files: Array<{
        kind: string;
        status: string;
        similarity: number | null;
        oldPath: string | null;
        newPath: string | null;
      }>;
    };
    body.files.push({
      kind: "modified",
      status: "M",
      similarity: null,
      oldPath: "src/application/orders/create-order.ts",
      newPath: "src/application/orders/create-order.ts",
    });
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page
    .getByRole("button", { name: "src/fixture.ts", exact: true })
    .click({ modifiers: ["Meta"] });
  await page
    .locator('.document-pane[data-pane="left"]')
    .getByRole("tab", { name: "Pull Request.md" })
    .click();
  await openWalkthroughFromSidebar(page, primaryWalkthrough);
  const reviewScope = page.getByRole("region", { name: "レビュー範囲", exact: true });
  const commitPicker = reviewScope.getByRole("button", { name: /^対象commit:/ });
  const displayDiffButton = reviewScope.getByRole("button", { name: "変更", exact: true });
  const initialCommitSelection = await commitPicker.getAttribute("aria-label");
  expect(initialCommitSelection).not.toBeNull();
  await expect(displayDiffButton).toHaveAttribute("aria-pressed", "true");

  await page
    .locator(".walkthrough-markdown .walkthrough-inline-reference")
    .filter({ hasText: "CreateOrderHandler.execute" })
    .click({ modifiers: ["Meta"] });

  const rightDiff = page.locator('.document-pane[data-pane="right"] diffs-container');
  await expect(rightDiff).toBeVisible();
  await expect(page.getByText(/参照元 b{8} ≠ 対象 c{8}/, { exact: true })).toBeVisible();
  await expect(commitPicker).toHaveAttribute("aria-label", initialCommitSelection!);
  await expect(displayDiffButton).toHaveAttribute("aria-pressed", "true");
  const splitButton = reviewScope.getByRole("button", { name: "split", exact: true });
  await expect(splitButton).toBeEnabled();
  await splitButton.click();

  await expect(splitButton).toHaveAttribute("aria-pressed", "true");
  await expect(rightDiff.locator('[data-diff-type="split"]')).toBeVisible();
  await expect(commitPicker).toHaveAttribute("aria-label", initialCommitSelection!);
});

test("keeps the review scope and reports a broken Walkthrough reference temporarily", async ({
  page,
}) => {
  const missingPath = "src/application/orders/create-order.ts";
  await page.route("**/api/pull-requests/*/document?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== missingPath) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        document: {
          ref: {
            kind: "repository-file",
            pullRequestId,
            sourceOid: url.searchParams.get("sourceOid"),
            path: missingPath,
          },
          availability: "missing",
          text: null,
          byteLength: null,
          entryKind: "file",
          normalizedLineEndings: false,
          oid: null,
        },
      }),
    });
  });

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openWalkthroughFromSidebar(page, primaryWalkthrough);
  const commitPicker = page.getByRole("button", { name: /^対象commit:/ });
  const initialCommitSelection = await commitPicker.getAttribute("aria-label");
  expect(initialCommitSelection).not.toBeNull();

  await page
    .locator(".walkthrough-markdown .walkthrough-inline-reference")
    .filter({ hasText: "CreateOrderHandler.execute" })
    .click({ modifiers: ["Meta"] });

  const notice = page.locator(".walkthrough-reference-notice");
  await expect(notice).toHaveText(`リンク切れ · ${missingPath}`);
  await expect(commitPicker).toHaveAttribute("aria-label", initialCommitSelection!);
  await expect(page.getByRole("tab", { name: missingPath })).toHaveCount(0);
  await expect(page.locator('.document-pane[data-pane="right"]')).toHaveCount(0);
  await expect(notice).toHaveCount(0, { timeout: 4_000 });
});

test("reports a Walkthrough reference load failure without calling it a broken link", async ({
  page,
}) => {
  const unavailablePath = "src/application/orders/create-order.ts";
  await page.route("**/api/pull-requests/*/document?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") === unavailablePath) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openWalkthroughFromSidebar(page, primaryWalkthrough);
  await page
    .locator(".walkthrough-markdown .walkthrough-inline-reference")
    .filter({ hasText: "CreateOrderHandler.execute" })
    .click({ modifiers: ["Meta"] });

  const notice = page.locator(".walkthrough-reference-notice");
  await expect(notice).toHaveText(`参照先を開けません · ${unavailablePath}`);
  await expect(notice).not.toContainText("リンク切れ");
  await expect(page.getByRole("tab", { name: unavailablePath })).toHaveCount(0);
});

test("resolves concurrent Walkthrough references independently in each pane", async ({ page }) => {
  const delayedPath = "src/application/orders/create-order.ts";
  let releaseRequest = (): void => undefined;
  const requestMayContinue = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let markRequestStarted = (): void => undefined;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  await page.route("**/api/pull-requests/*/document?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== delayedPath) {
      await route.continue();
      return;
    }
    markRequestStarted();
    await requestMayContinue;
    await route.continue();
  });

  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await openWalkthroughFromSidebar(page, primaryWalkthrough);
    await page
      .locator(".walkthrough-markdown .walkthrough-inline-reference")
      .filter({ hasText: "CreateOrderHandler.execute" })
      .click({ modifiers: ["Meta"] });
    await requestStarted;

    await page
      .locator(".walkthrough-markdown .walkthrough-inline-reference")
      .filter({ hasText: "POST /orders" })
      .click();
    await expect(
      page
        .locator('.document-pane[data-pane="left"]')
        .getByRole("tab", { name: "src/http/routes/orders.ts" }),
    ).toHaveAttribute("aria-selected", "true");

    releaseRequest();
    await expect(
      page.locator('.document-pane[data-pane="right"]').getByRole("tab", { name: delayedPath }),
    ).toHaveAttribute("aria-selected", "true");
  } finally {
    releaseRequest();
  }
});

test("does not let a delayed Walkthrough reference replace navigation that returned to its prior state", async ({
  page,
}) => {
  const delayedPath = "src/application/orders/create-order.ts";
  let releaseRequest = (): void => undefined;
  const requestMayContinue = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let markRequestStarted = (): void => undefined;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  await page.route("**/api/pull-requests/*/document?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== delayedPath) {
      await route.continue();
      return;
    }
    markRequestStarted();
    await requestMayContinue;
    await route.continue();
  });

  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await openWalkthroughFromSidebar(page, primaryWalkthrough);
    await page
      .locator(".walkthrough-markdown .walkthrough-inline-reference")
      .filter({ hasText: "CreateOrderHandler.execute" })
      .click({ modifiers: ["Meta"] });
    await requestStarted;

    await page
      .locator(".file-tree")
      .getByRole("button", { name: "src/fixture.ts", exact: true })
      .click({ modifiers: ["Meta"] });
    const rightPane = page.locator('.document-pane[data-pane="right"]');
    await expect(rightPane.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await rightPane.getByRole("button", { name: "src/fixture.tsを閉じる" }).click();
    await expect(rightPane).toHaveCount(0);

    const delayedResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname.endsWith("/document") && url.searchParams.get("path") === delayedPath;
    });
    releaseRequest();
    await delayedResponse;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(rightPane).toHaveCount(0);
    await expect(page.getByRole("tab", { name: delayedPath })).toHaveCount(0);
  } finally {
    releaseRequest();
  }
});

test("moves document tabs between at most two panes and previews repository Markdown", async ({
  page,
  request,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);

  const sidebarStackLabels = await page.locator(".sidebar-stack-toggle").allTextContents();
  expect(sidebarStackLabels.map((label) => label.replace(/\s+/g, "").replace(/\d+$/, ""))).toEqual([
    "エクスプローラー",
    "コメント",
  ]);
  await expect(page.getByRole("navigation", { name: "レビュー文書" })).toBeVisible();

  await openWalkthroughFromSidebar(page, primaryWalkthrough);
  const leftPane = page.locator('.document-pane[data-pane="left"]');
  await expect(leftPane.getByRole("heading", { name: "注文作成フローの全体像" })).toBeVisible();
  const leftScrollTop = await leftPane.evaluate((element) => {
    element.scrollTop = Math.min(320, element.scrollHeight - element.clientHeight);
    return element.scrollTop;
  });
  expect(leftScrollTop).toBeGreaterThan(0);
  await page.getByRole("button", { name: "左ペインの操作" }).click();
  await page.getByRole("menuitem", { name: "選択中のタブを右ペインへ移動" }).click();
  await expect(
    page.locator('.document-pane[data-pane="right"]').getByRole("tab", {
      name: primaryWalkthrough,
    }),
  ).toBeVisible();

  const rightPane = page.locator('.document-pane[data-pane="right"]');
  await expect.poll(() => rightPane.evaluate((element) => element.scrollTop)).toBe(leftScrollTop);
  await rightPane
    .locator(".walkthrough-inline-reference")
    .filter({ hasText: "POST /orders" })
    .click({ modifiers: ["Meta"] });
  await expect(rightPane.getByRole("tab", { name: "src/http/routes/orders.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(rightPane.getByRole("tab", { name: primaryWalkthrough })).toBeVisible();
  await expect(rightPane.locator("diffs-container")).toHaveAttribute(
    "data-search-target-line",
    "10",
  );

  await page
    .locator('.document-pane[data-pane="right"]')
    .getByRole("tab", { name: primaryWalkthrough })
    .dragTo(page.locator('.document-tabs-shell[data-pane="left"]'));
  await expect(
    page.locator('.document-pane[data-pane="left"]').getByRole("tab", {
      name: primaryWalkthrough,
    }),
  ).toBeVisible();

  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await page.locator(".file-tree").getByRole("button", { name: "README.md", exact: true }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Orders service", exact: true })).toBeVisible();
  await expect(page.getByText("Rendered Markdown", { exact: true })).toBeVisible();
  const previewBodyFontSize = await page
    .locator(".markdown-preview > .markdown-comment-surface > article")
    .evaluate((element) => getComputedStyle(element).fontSize);
  await expect(page.locator(".markdown-preview pre code")).toHaveCSS(
    "font-size",
    previewBodyFontSize,
  );
  await expect(
    page.locator(".markdown-preview p code").filter({ hasText: "FOR UPDATE SKIP LOCKED" }),
  ).toHaveCSS("font-size", previewBodyFontSize);
  const repositorySoftBreak = page.locator(".markdown-preview p").filter({
    hasText:
      /This repository line uses a soft break\.\s*It stays inline when rendered as a Markdown file\./,
  });
  await expect(repositorySoftBreak).toHaveCount(1);
  await expect(repositorySoftBreak.locator("br")).toHaveCount(0);
  const previewSourceLine = page
    .locator('.markdown-preview [data-rvw-source-start-line="6"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "This repository line uses a soft break." });
  await expect(previewSourceLine).toHaveCount(1);
  await selectMappedText(previewSourceLine, true);
  await expect(page.getByRole("button", { name: "L6へコメント", exact: true })).toBeVisible();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(page.getByRole("button", { name: "L6へコメント", exact: true })).toHaveCount(0);
  await selectMappedText(previewSourceLine, true);
  await page.getByRole("button", { name: "L6へコメント", exact: true }).click();
  const previewComposer = page.locator(".markdown-preview .markdown-selection-composer-slot");
  const previewSurface = page.locator(".markdown-preview .markdown-comment-surface");
  const [previewComposerBox, previewSurfaceBox] = await Promise.all([
    previewComposer.boundingBox(),
    previewSurface.boundingBox(),
  ]);
  expect(previewComposerBox).not.toBeNull();
  expect(previewSurfaceBox).not.toBeNull();
  const previewSourceLineBox = await previewSourceLine.boundingBox();
  expect(previewSourceLineBox).not.toBeNull();
  expect(previewComposerBox!.y).toBeGreaterThanOrEqual(
    previewSourceLineBox!.y + previewSourceLineBox!.height,
  );
  expect(previewComposerBox!.x).toBeGreaterThanOrEqual(previewSurfaceBox!.x + 11);
  expect(previewComposerBox!.x + previewComposerBox!.width).toBeLessThanOrEqual(
    previewSurfaceBox!.x + previewSurfaceBox!.width - 11,
  );
  await page
    .getByRole("textbox", { name: "README.md · L6へコメント" })
    .pressSequentially("PreviewからREADMEの説明へコメントしました。");
  await page.getByRole("textbox", { name: "README.md · L6へコメント" }).press("Control+Enter");
  const previewComment = page.locator(".markdown-inline-comments").filter({
    hasText: "PreviewからREADMEの説明へコメントしました。",
  });
  await expect(previewComment).toBeVisible();
  await expect(previewComment.getByText("L6", { exact: true })).toBeVisible();
  const readinessTable = page.locator(".markdown-preview").getByRole("table");
  await expect(readinessTable.getByRole("cell").first()).toHaveCSS("user-select", "text");
  await expect(readinessTable.getByRole("columnheader", { name: "Check" })).toBeVisible();
  await expect(readinessTable.getByRole("cell", { name: "Pending" })).toBeVisible();
  const wrappingTableCell = readinessTable.getByRole("cell", {
    name: /This intentionally long note verifies/,
  });
  const wrappingTableCellBox = await wrappingTableCell.boundingBox();
  expect(wrappingTableCellBox).not.toBeNull();
  expect(wrappingTableCellBox!.width).toBeLessThan(520);
  expect(wrappingTableCellBox!.height).toBeGreaterThan(55);
  const tableSourceLine = page
    .locator('.markdown-preview [data-rvw-source-start-line="34"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "Deployment review" });
  expect((await dragNativeText(page, tableSourceLine)).trim()).toBe("Deployment review");
  await page.getByRole("button", { name: "L34へコメント", exact: true }).click();
  await page
    .getByRole("textbox", { name: "README.md · L34へコメント" })
    .pressSequentially("表の確認状況についてコメントしました。");
  await page.getByRole("textbox", { name: "README.md · L34へコメント" }).press("Control+Enter");
  const tableComment = page.locator(".markdown-inline-comments").filter({
    hasText: "表の確認状況についてコメントしました。",
  });
  await expect(tableComment).toBeVisible();
  await expect(tableComment.getByText("L34", { exact: true })).toBeVisible();
  await expect(readinessTable.getByRole("cell", { name: "Pending" })).toBeVisible();

  const codeSourceLine = page
    .locator('.markdown-preview pre [data-rvw-source-start-line="25"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "npm test" });
  await expect(codeSourceLine).toHaveCount(1);
  await selectMappedText(codeSourceLine);
  await page.getByRole("button", { name: "L25へコメント", exact: true }).click();
  const codeComposer = page.getByRole("textbox", { name: "README.md · L25へコメント" });
  await codeComposer.pressSequentially("コード行へのコメント");
  await expect(codeComposer).toHaveValue("コード行へのコメント");
  await page
    .locator(".markdown-preview .inline-comment-composer")
    .getByRole("button", { name: "キャンセル" })
    .click();

  const taskItems = page.locator(".markdown-preview .task-list-item");
  await expect(taskItems).toHaveCount(2);
  await expect(taskItems.nth(0)).toContainText("Unit tests");
  await expect(taskItems.nth(0).locator('input[type="checkbox"]')).toBeChecked();
  await expect(taskItems.nth(1).locator('input[type="checkbox"]')).not.toBeChecked();
  await expect(taskItems.nth(0).locator('input[type="checkbox"]')).toBeDisabled();
  await expect(taskItems.nth(1).locator('input[type="checkbox"]')).toBeDisabled();
  const taskSourceLine = page
    .locator('.markdown-preview [data-rvw-source-start-line="36"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "Unit tests" });
  await expect(taskSourceLine).toHaveCount(1);
  await selectMappedText(taskSourceLine);
  await expect(page.getByRole("button", { name: "L36へコメント", exact: true })).toBeVisible();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  const operationalDetails = page.locator(".markdown-preview details").filter({
    hasText: "Operational details",
  });
  await expect(operationalDetails).not.toHaveAttribute("open", "");
  await expect(operationalDetails.getByText(/Payment reconciliation/)).toBeHidden();
  await operationalDetails.getByText("Operational details", { exact: true }).click();
  await expect(operationalDetails).toHaveAttribute("open", "");
  await expect(operationalDetails.getByText(/Payment reconciliation/)).toBeVisible();
  const detailsSourceLine = operationalDetails
    .locator('[data-rvw-source-start-line="42"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "Payment reconciliation" });
  await selectMappedText(detailsSourceLine);
  await page.getByRole("button", { name: "L42へコメント", exact: true }).click();
  await page
    .getByRole("textbox", { name: "README.md · L42へコメント" })
    .pressSequentially("折りたたみ内の説明へコメントしました。");
  await page.getByRole("textbox", { name: "README.md · L42へコメント" }).press("Control+Enter");
  const detailsComment = page.locator(".markdown-inline-comments").filter({
    hasText: "折りたたみ内の説明へコメントしました。",
  });
  await expect(detailsComment).toBeVisible();
  await operationalDetails.getByText("Operational details", { exact: true }).click();
  await expect(operationalDetails).not.toHaveAttribute("open", "");
  await expect(operationalDetails.getByText(/Payment reconciliation/)).toBeHidden();
  await expect(detailsComment).toBeHidden();
  await openCommentsSidebar(page);
  await expect(
    page.locator(".comment-list-item").filter({
      hasText: "折りたたみ内の説明へコメントしました。",
    }),
  ).toBeVisible();
  await operationalDetails.getByText("Operational details", { exact: true }).click();
  await expect(operationalDetails).toHaveAttribute("open", "");
  await expect(detailsComment).toBeVisible();
  await expect(page.locator(".markdown-preview script")).toHaveCount(0);
  expect(await page.evaluate(() => "__rvwUnsafeMarkdownExecuted" in window)).toBe(false);
  await expect(page.getByText("Request lifecycle", { exact: true })).toBeVisible();
  await expect(page.locator("#request-lifecycle")).toHaveText("Request lifecycle");
  await page.getByRole("link", { name: "the request lifecycle", exact: true }).click();
  await expect(page).toHaveURL(/#request-lifecycle$/);
  const lifecycleImage = page.getByRole("img", { name: "Order lifecycle" });
  await expect(lifecycleImage).toHaveAttribute("src", /\/markdown-asset\?/);
  await expect
    .poll(() => lifecycleImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect(
    page.getByRole("img", { name: "画像: External telemetry（自動読み込み停止）" }),
  ).toBeVisible();
  await expect(page.locator('img[src*="/api/test/external-image"]')).toHaveCount(0);
  await expect
    .poll(async () => {
      const response = await request.get("/api/test/external-image-count");
      const body = (await response.json()) as { count: number };
      return body.count;
    })
    .toBe(0);

  const lastMarkdownLine = page
    .locator('.markdown-preview [data-rvw-source-start-line="52"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "See" });
  await selectMappedText(lastMarkdownLine);
  await page.getByRole("button", { name: "L52へコメント", exact: true }).click();
  const lastLineComposer = page.locator(".markdown-preview .markdown-selection-composer-slot");
  const [lastLineComposerBox, lastLineSurfaceBox, lastLinePaneBox] = await Promise.all([
    lastLineComposer.boundingBox(),
    page.locator(".markdown-preview .markdown-comment-surface").boundingBox(),
    page.locator('.document-pane[data-pane="left"]').boundingBox(),
  ]);
  expect(lastLineComposerBox).not.toBeNull();
  expect(lastLineSurfaceBox).not.toBeNull();
  expect(lastLinePaneBox).not.toBeNull();
  expect(lastLineComposerBox!.y + lastLineComposerBox!.height).toBeLessThanOrEqual(
    lastLineSurfaceBox!.y + lastLineSurfaceBox!.height,
  );
  expect(lastLineComposerBox!.y + lastLineComposerBox!.height).toBeLessThanOrEqual(
    lastLinePaneBox!.y + lastLinePaneBox!.height + 1,
  );
  await page
    .getByRole("textbox", { name: "README.md · L52へコメント" })
    .fill("最終行コメントの表示確認");
  await page
    .locator(".markdown-preview .inline-comment-composer")
    .getByRole("button", { name: "キャンセル" })
    .click();
  await expect(lastLineComposer).toHaveCount(0);

  const reviewScope = page.getByRole("region", { name: "レビュー範囲", exact: true });
  const displayDiffButton = reviewScope.getByRole("button", { name: "変更", exact: true });
  const commitPicker = reviewScope.getByRole("button", { name: /^対象commit:/ });
  const initialCommitSelection = await commitPicker.getAttribute("aria-label");
  expect(initialCommitSelection).not.toBeNull();
  await displayDiffButton.click();
  await expect(displayDiffButton).toHaveAttribute("aria-pressed", "true");

  const repositoryLink = page.getByRole("link", { name: "the order workflow", exact: true });
  await expect(repositoryLink).toHaveAttribute("href", "docs/order-workflow.md");
  await expect(repositoryLink).not.toHaveAttribute("target", "_blank");
  await repositoryLink.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "docs/order-workflow.md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(commitPicker).toHaveAttribute("aria-label", initialCommitSelection!);
  await expect(displayDiffButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("参照元commit · 全文表示", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Order workflow", exact: true })).toBeVisible();
  await expect(page.getByText("参照元commit · 全文表示", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "README.md" }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page
    .getByRole("link", { name: "the order workflow", exact: true })
    .click({ modifiers: ["Meta"] });
  await expect(
    page
      .locator('.document-pane[data-pane="right"]')
      .getByRole("tab", { name: "docs/order-workflow.md" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(commitPicker).toHaveAttribute("aria-label", initialCommitSelection!);
  await expect(displayDiffButton).toHaveAttribute("aria-pressed", "true");

  const rightMarkdownPane = page.locator('.document-pane[data-pane="right"]');
  await page
    .locator(".file-tree")
    .getByRole("button", { name: "README.md", exact: true })
    .click({ modifiers: ["Meta"] });
  await rightMarkdownPane.getByRole("button", { name: "Preview", exact: true }).click();
  await rightMarkdownPane.getByRole("link", { name: "the order workflow", exact: true }).click();
  await expect(
    page
      .locator('.document-pane[data-pane="left"]')
      .getByRole("tab", { name: "docs/order-workflow.md" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(rightMarkdownPane.getByRole("tab", { name: "README.md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(commitPicker).toHaveAttribute("aria-label", initialCommitSelection!);
  await expect(displayDiffButton).toHaveAttribute("aria-pressed", "true");
});

test("keeps native Markdown pointer selection stable across headings, tables, and code", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await page.locator(".file-tree").getByRole("button", { name: "README.md", exact: true }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();

  const mappedLeaf = (line: number, text: RegExp) =>
    page
      .locator(
        `.markdown-preview [data-rvw-source-start-line="${line}"][data-rvw-source-leaf="true"]`,
      )
      .filter({ hasText: text });
  const clearSelection = async () => {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect(page.locator(".markdown-selection-comment-action")).toHaveCount(0);
  };

  const localDevelopment = mappedLeaf(21, /^Local development$/);
  await localDevelopment.dblclick();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""))
    .toMatch(/^(Local|development)$/);
  await expect(page.getByRole("button", { name: "L21へコメント", exact: true })).toBeVisible();
  await clearSelection();

  const ready = mappedLeaf(33, /^Ready$/);
  await ready.dblclick();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""))
    .toBe("Ready");
  await expect(page.getByRole("button", { name: "L33へコメント", exact: true })).toBeVisible();
  await clearSelection();

  const codeLine = mappedLeaf(25, /^npm test$/);
  expect((await dragNativeText(page, codeLine)).trim()).toBe("npm test");
  await expect(page.getByRole("button", { name: "L25へコメント", exact: true })).toBeVisible();
  await clearSelection();

  expect((await dragNativeText(page, ready)).trim()).toBe("Ready");
  await expect(page.getByRole("button", { name: "L33へコメント", exact: true })).toBeVisible();
  await clearSelection();

  const firstLifecycleItem = mappedLeaf(15, /^Authenticate the actor/);
  const multiLineSelection = await dragNativeText(page, firstLifecycleItem, localDevelopment);
  expect(multiLineSelection).toContain("Authenticate the actor");
  expect(multiLineSelection).toContain("Local development");
  expect(multiLineSelection).not.toContain("npm install");
  await expect(page.getByRole("button", { name: "L15–21へコメント", exact: true })).toBeVisible();
});

test("keeps walkthrough Markdown selection stable on the first interaction", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openWalkthroughFromSidebar(page, markdownShowcase);

  const mappedLeaf = (line: number, text: RegExp) =>
    page
      .locator(
        `.walkthrough-markdown [data-rvw-source-start-line="${line}"][data-rvw-source-leaf="true"]`,
      )
      .filter({ hasText: text });
  const clearSelection = async () => {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect(page.locator(".markdown-selection-comment-action")).toHaveCount(0);
  };

  const summaryHeading = mappedLeaf(7, /^レビューサマリー$/);
  await summaryHeading.dblclick();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""))
    .toMatch(/^(レビュー|サマリー|レビューサマリー)$/);
  await expect(page.getByRole("button", { name: "L7へコメント", exact: true })).toBeVisible();
  await clearSelection();

  const codeLine = mappedLeaf(58, /await orders\.insert/);
  expect((await dragNativeText(page, codeLine)).trim()).toBe("await orders.insert(order, tx);");
  await expect(page.getByRole("button", { name: "L58へコメント", exact: true })).toBeVisible();
});

test("renders a class diagram with code-bound classes", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openWalkthroughFromSidebar(page, "テストマップ：各層で何を保証しているか");

  await expect(page.locator(".walkthrough-diagram svg")).toBeVisible();
  await expect(page.locator(".walkthrough-diagram-node--linked")).toHaveCount(5);
  const orderClass = page.getByRole("button", { name: "Order.placeをコードで開く" });
  await expect(orderClass).toBeVisible();
  await expect(orderClass).toHaveCSS("cursor", "pointer");
  await expect(orderClass.locator("path, polygon, circle, rect").first()).toHaveCSS(
    "stroke-width",
    "1.6px",
  );
  await orderClass.click();
  await expect(page.locator('.document-pane[data-pane="left"] diffs-container')).toHaveAttribute(
    "data-search-target-line",
    "21",
  );
  await page
    .locator('.document-pane[data-pane="left"]')
    .getByRole("tab", { name: "テストマップ：各層で何を保証しているか" })
    .click();
  const reopenedOrderClass = page.getByRole("button", { name: "Order.placeをコードで開く" });
  await expect(reopenedOrderClass).toBeVisible();
  await reopenedOrderClass.dispatchEvent("pointerdown", { metaKey: true });
  await expect(page.locator('.document-pane[data-pane="right"] diffs-container')).toHaveAttribute(
    "data-search-target-line",
    "21",
  );
});

test("renders the Markdown walkthrough showcase and keeps every expression commentable", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openWalkthroughFromSidebar(page, markdownShowcase);

  await expect(page.getByRole("tab", { name: markdownShowcase })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("heading", { name: "Markdownレビュー・ショーケース" })).toBeVisible();
  await expect(
    page.locator(".walkthrough-inline-reference").filter({ hasText: "コード参照" }),
  ).toBeVisible();
  const walkthroughBodyFontSize = await page
    .locator(".walkthrough-markdown")
    .evaluate((element) => getComputedStyle(element).fontSize);
  await expect(
    page.locator(".walkthrough-markdown p code").filter({ hasText: "inline code" }),
  ).toHaveCSS("font-size", walkthroughBodyFontSize);
  await expect(page.locator(".walkthrough-markdown pre code").first()).toHaveCSS(
    "font-size",
    walkthroughBodyFontSize,
  );
  const summaryTable = page.locator(".walkthrough-markdown").getByRole("table");
  await expect(summaryTable.getByRole("columnheader", { name: "観点" })).toBeVisible();
  await expect(summaryTable.getByRole("cell", { name: "⚠️ Review" })).toBeVisible();

  const taskItems = page.locator(".walkthrough-markdown .task-list-item");
  await expect(taskItems).toHaveCount(4);
  await expect(taskItems.nth(0).locator('input[type="checkbox"]')).toBeChecked();
  await expect(taskItems.nth(2).locator('input[type="checkbox"]')).not.toBeChecked();

  const details = page.locator(".walkthrough-markdown details");
  const detailsSummary = details.locator("summary");
  await expect(details).not.toHaveAttribute("open", "");
  await detailsSummary.focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await page.keyboard.press("Space");
  await expect(details).not.toHaveAttribute("open", "");
  await detailsSummary.click();
  await expect(details).toHaveAttribute("open", "");
  await expect(details.getByText(/折りたたみの中にある文章も/)).toBeVisible();

  const tableSourceLine = page
    .locator('.walkthrough-markdown [data-rvw-source-start-line="11"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "HTTP境界" });
  await selectMappedText(tableSourceLine);
  await expect(page.getByRole("button", { name: "L11へコメント", exact: true })).toBeVisible();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  const detailsSourceLine = details
    .locator('[data-rvw-source-start-line="25"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "折りたたみの中にある文章も" });
  await selectMappedText(detailsSourceLine);
  await page.getByRole("button", { name: "L25へコメント", exact: true }).click();
  await page.getByRole("textbox", { name: "L25へコメント" }).fill("details内の探索コメントです。");
  await page.getByRole("textbox", { name: "L25へコメント" }).press("Control+Enter");
  await detailsSummary.click();
  await expect(details).not.toHaveAttribute("open", "");
  await openCommentsSidebar(page);
  const detailsSidebarComment = page.locator(".comment-list-item").filter({
    hasText: "details内の探索コメントです。",
  });
  await detailsSidebarComment.getByRole("button", { name: "コメント対象を開く" }).click();
  await expect(details).toHaveAttribute("open", "");
  await expect(detailsSourceLine).toBeVisible();

  await expect(page.locator(".walkthrough-diagram svg")).toBeVisible();
  await expect(page.locator(".walkthrough-diagram-node--linked")).toHaveCount(6);
  await page.getByRole("button", { name: "図全体へコメント" }).click();
  const activeDocumentPane = page.locator(".document-pane.active");
  const diagramComposer = page.locator(".walkthrough-diagram-comment-composer");
  const diagramDraft = page.locator(".walkthrough-diagram-comment-composer textarea");
  await expect(diagramDraft).toBeVisible();
  await diagramDraft.evaluate((element) => {
    (window as unknown as { rvwDiagramDraft?: Element }).rvwDiagramDraft = element;
  });
  await diagramDraft.press("a");
  await expect(diagramDraft).toHaveValue("a");
  await expect
    .poll(
      async () =>
        await diagramDraft.evaluate(
          (element) =>
            (window as unknown as { rvwDiagramDraft?: Element }).rvwDiagramDraft === element,
        ),
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        await diagramDraft.evaluate((element) => {
          const textarea = element as HTMLTextAreaElement;
          return [textarea.selectionStart, textarea.selectionEnd];
        }),
    )
    .toEqual([1, 1]);
  await diagramDraft.pressSequentially("iueo");
  await expect(diagramDraft).toHaveValue("aiueo");
  await expect
    .poll(async () => {
      const [composerBox, paneBox] = await Promise.all([
        diagramComposer.boundingBox(),
        activeDocumentPane.boundingBox(),
      ]);
      return composerBox && paneBox
        ? composerBox.y + composerBox.height <= paneBox.y + paneBox.height + 1
        : false;
    })
    .toBe(true);
  const scrollTopBeforeThemeChange = await activeDocumentPane.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  await page.getByRole("button", { name: "その他の操作", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "ダークモード", exact: true }).click();
  await expect
    .poll(async () => await activeDocumentPane.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(scrollTopBeforeThemeChange - 200);
  await expect(diagramDraft).toHaveValue("aiueo");
  expect(
    await diagramDraft.evaluate(
      (element) => (window as unknown as { rvwDiagramDraft?: Element }).rvwDiagramDraft === element,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "その他の操作", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "システム", exact: true }).click();
  await diagramDraft.fill("キャンセルするMermaidコメント");
  await page
    .locator(".walkthrough-diagram-comment-composer")
    .getByRole("button", { name: "キャンセル" })
    .click();
  await expect(page.locator(".walkthrough-diagram-comment-composer")).toHaveCount(0);

  await expect(page.locator(".walkthrough-markdown pre code")).toHaveCount(2);
  await expect(page.locator(".walkthrough-markdown hr")).toBeVisible();
});

test("keeps Markdown comment menus reachable across narrow viewports", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openWalkthroughFromSidebar(page, markdownShowcase);

  const line = page
    .locator('.walkthrough-markdown [data-rvw-source-start-line="5"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "このウォークスルーは" });
  await selectMappedText(line);
  await page.getByRole("button", { name: "L5へコメント", exact: true }).click();
  await page.getByRole("textbox", { name: "L5へコメント" }).fill("狭い画面でmenuを確認します。");
  await page.getByRole("textbox", { name: "L5へコメント" }).press("Control+Enter");

  const thread = page.locator(".walkthrough-markdown .comment-thread").filter({
    hasText: "狭い画面でmenuを確認します。",
  });
  const commentId = await thread.getAttribute("data-comment-id");
  expect(commentId).not.toBeNull();
  const stableThread = page.locator(`.walkthrough-markdown [data-comment-id="${commentId}"]`);
  await stableThread.locator(".comment-thread-toggle").click();

  for (const width of [1024, 850, 700, 560, 420, 320]) {
    await page.setViewportSize({ width, height: 720 });
    await stableThread.evaluate((element) =>
      element.scrollIntoView({ block: "center", inline: "nearest" }),
    );
    await stableThread.getByRole("button", { name: "コメントのその他の操作" }).click();
    const menu = page.getByRole("menu", { name: "コメントのその他の操作" });
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(8);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width - 8 + 1);
    expect(box!.y).toBeGreaterThanOrEqual(8);
    expect(box!.y + box!.height).toBeLessThanOrEqual(720 - 8 + 1);
    await menu.getByRole("menuitem", { name: "参照をコピー" }).press("Escape");
  }
});

test("normalizes mixed Markdown selections and ignores comment UI text", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openWalkthroughFromSidebar(page, markdownShowcase);
  await expect(page.locator(".walkthrough-diagram-shell svg")).toHaveCount(2);

  const selectBetween = async (
    startSelector: string,
    endSelector: string,
    backwards = false,
  ): Promise<void> => {
    await page
      .locator(startSelector)
      .first()
      .evaluate(
        (start, options) => {
          const end = document.querySelector(options.endSelector);
          if (!end) throw new Error(`Missing selection end: ${options.endSelector}`);
          const startText = start.firstChild;
          const endText = end.firstChild;
          if (!startText || !endText) throw new Error("Selection endpoints have no text node.");
          const selection = window.getSelection();
          selection?.removeAllRanges();
          if (options.backwards) {
            selection?.setBaseAndExtent(endText, endText.textContent?.length ?? 0, startText, 0);
          } else {
            selection?.setBaseAndExtent(startText, 0, endText, endText.textContent?.length ?? 0);
          }
          end.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        },
        { endSelector, backwards },
      );
  };

  await selectBetween(
    '[data-rvw-source-start-line="11"][data-rvw-source-leaf="true"]',
    '[data-rvw-source-start-line="13"][data-rvw-source-leaf="true"]',
  );
  await expect(page.getByRole("button", { name: "L11–13へコメント" })).toBeVisible();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(page.locator(".markdown-selection-comment-action")).toHaveCount(0);

  await selectBetween(
    '[data-rvw-source-start-line="57"][data-rvw-source-leaf="true"]',
    '[data-rvw-source-start-line="60"][data-rvw-source-leaf="true"]',
    true,
  );
  await expect(page.getByRole("button", { name: "L57–60へコメント" })).toBeVisible();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  const details = page.locator(".walkthrough-markdown details");
  await details.locator("summary").click();
  await selectBetween(
    '[data-rvw-source-start-line="23"][data-rvw-source-leaf="true"]',
    '[data-rvw-source-start-line="25"][data-rvw-source-leaf="true"]',
  );
  await expect(page.getByRole("button", { name: "L23–25へコメント" })).toBeVisible();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  const taskLine = page
    .locator('.walkthrough-markdown [data-rvw-source-start-line="17"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "public API" });
  await selectMappedText(taskLine);
  await page.getByRole("button", { name: "L17へコメント" }).click();
  await page.getByRole("textbox", { name: "L17へコメント" }).fill("既存コメントの本文です。");
  await page.getByRole("textbox", { name: "L17へコメント" }).press("Control+Enter");
  const commentBody = page
    .locator(".walkthrough-markdown .comment-thread")
    .getByText("既存コメントの本文です。", { exact: true });
  await commentBody.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await expect(page.locator(".markdown-selection-comment-action")).toHaveCount(0);

  await taskLine.evaluate((start) => {
    const end = document.querySelector(".walkthrough-markdown .comment-post p");
    if (!end || !start.firstChild || !end.firstChild) throw new Error("Missing mixed endpoints.");
    const selection = window.getSelection();
    selection?.setBaseAndExtent(
      start.firstChild,
      0,
      end.firstChild,
      end.firstChild.textContent?.length ?? 0,
    );
    end.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await expect(page.locator(".markdown-selection-comment-action")).toHaveCount(0);
});

test("resizes the sidebar and two reading panes with pointer drag", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);

  const sidebar = page.locator(".sidebar");
  const sidebarHandle = page.getByRole("separator", { name: "サイドバーの幅を変更" });
  const sidebarBefore = await sidebar.boundingBox();
  const sidebarHandleBox = await sidebarHandle.boundingBox();
  expect(sidebarBefore).not.toBeNull();
  expect(sidebarHandleBox).not.toBeNull();
  await expect(sidebarHandle).toHaveCSS("border-left-width", "0px");
  await expect(sidebarHandle).toHaveCSS("border-right-width", "0px");
  expect(await sidebarHandle.evaluate((handle) => getComputedStyle(handle, "::after").width)).toBe(
    "2px",
  );
  await page.mouse.move(
    sidebarHandleBox!.x + sidebarHandleBox!.width / 2,
    sidebarHandleBox!.y + 120,
  );
  await page.mouse.down();
  await page.mouse.move(sidebarHandleBox!.x + 96, sidebarHandleBox!.y + 120, { steps: 5 });
  await page.mouse.up();
  const sidebarAfter = await sidebar.boundingBox();
  expect(sidebarAfter!.width).toBeGreaterThan(sidebarBefore!.width + 70);

  await openWalkthroughFromSidebar(page, primaryWalkthrough);
  const handlerReference = page
    .locator(".walkthrough-markdown .walkthrough-inline-reference")
    .filter({ hasText: "CreateOrderHandler.execute" });
  await handlerReference.click({ modifiers: ["Meta"] });

  const leftPane = page.locator('.document-pane[data-pane="left"]');
  const rightPane = page.locator('.document-pane[data-pane="right"]');
  await expect(rightPane.locator("diffs-container")).toBeVisible();
  const paneHandle = page.getByRole("separator", { name: "左右ペインの幅を変更" });
  const leftBefore = await leftPane.boundingBox();
  const rightBefore = await rightPane.boundingBox();
  const paneHandleBox = await paneHandle.boundingBox();
  expect(leftBefore).not.toBeNull();
  expect(rightBefore).not.toBeNull();
  expect(paneHandleBox).not.toBeNull();
  await page.mouse.move(paneHandleBox!.x + paneHandleBox!.width / 2, paneHandleBox!.y + 140);
  await page.mouse.down();
  await page.mouse.move(paneHandleBox!.x + 90, paneHandleBox!.y + 140, { steps: 5 });
  await page.mouse.up();
  const leftAfter = await leftPane.boundingBox();
  const rightAfter = await rightPane.boundingBox();
  expect(leftAfter!.width).toBeGreaterThan(leftBefore!.width + 60);
  expect(rightAfter!.width).toBeLessThan(rightBefore!.width - 60);
});

test("keeps narrow sidebar separator values aligned with its rendered width", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto(`/?pullRequestId=${pullRequestId}`);

  const sidebar = page.locator(".sidebar");
  const separator = page.getByRole("separator", { name: "サイドバーの幅を変更" });
  await expect(separator).toHaveAttribute("aria-valuenow", "330");
  await expect(separator).toHaveAttribute("aria-valuemax", "560");

  await page.setViewportSize({ width: 800, height: 700 });
  await expect(separator).toHaveAttribute("aria-valuenow", "280");
  await expect(separator).toHaveAttribute("aria-valuemax", "280");
  const before = await sidebar.boundingBox();
  expect(before).not.toBeNull();
  await separator.press("ArrowLeft");
  const after = await sidebar.boundingBox();
  expect(after).not.toBeNull();
  expect(after!.width).toBeLessThan(before!.width - 10);
  await expect(separator).toHaveAttribute("aria-valuenow", "264");
});

test("keeps readable minimum widths on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 319, height: 777 });
  await page.goto(`/?pullRequestId=${pullRequestId}`);

  const workspace = page.locator(".workspace");
  const singlePaneLayout = await workspace.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    mainWidth: element.querySelector(".main-view")!.getBoundingClientRect().width,
  }));
  expect(singlePaneLayout.mainWidth).toBeGreaterThanOrEqual(500);
  expect(singlePaneLayout.scrollWidth).toBeGreaterThan(singlePaneLayout.clientWidth);

  await openWalkthroughFromSidebar(page, primaryWalkthrough);
  await page
    .locator(".walkthrough-markdown .walkthrough-inline-reference")
    .filter({ hasText: "CreateOrderHandler.execute" })
    .click({ modifiers: ["Meta"] });
  await expect(page.locator('.document-pane[data-pane="right"]')).toBeVisible();
  const paneWidths = await page
    .locator(".document-pane")
    .evaluateAll((panes) => panes.map((pane) => pane.getBoundingClientRect().width));
  expect(paneWidths).toHaveLength(2);
  expect(paneWidths.every((width) => width >= 280)).toBe(true);
  const twoPaneScrollOwnership = await workspace.evaluate((element) => {
    const main = element.querySelector<HTMLElement>(".main-view.two-pane")!;
    return {
      workspaceClientWidth: element.clientWidth,
      workspaceScrollWidth: element.scrollWidth,
      mainClientWidth: main.clientWidth,
      mainScrollWidth: main.scrollWidth,
    };
  });
  expect(twoPaneScrollOwnership.workspaceScrollWidth).toBeGreaterThan(
    twoPaneScrollOwnership.workspaceClientWidth,
  );
  expect(twoPaneScrollOwnership.mainScrollWidth).toBe(twoPaneScrollOwnership.mainClientWidth);
});

test("refreshes an open walkthrough in place after an agent update", async ({ page }) => {
  const walkthroughId = "70000000-0000-4000-8000-000000000002";
  const originalTitle = "障害とretry：どこまで自動回復できるか";
  const updatedTitle = "障害とretry：レビュー反映版";
  const updatedReferenceLabel = "Idempotency envelope（補足済み）";
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openWalkthroughFromSidebar(page, originalTitle);
  await expect(page.getByRole("tab", { name: originalTitle })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const response = await page.request.post(`/api/fixture/walkthroughs/${walkthroughId}/update`, {
    data: {
      title: updatedTitle,
      referenceLabel: updatedReferenceLabel,
      body: [
        "# 利用者フィードバックを反映した障害説明",
        "",
        "再試行の責務を [Idempotency envelope（補足済み）](rvw-ref:idempotency) から説明し直しました。",
      ].join("\n"),
    },
  });
  expect(response.ok()).toBe(true);

  await expect(page.getByRole("tab", { name: updatedTitle })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: originalTitle })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "利用者フィードバックを反映した障害説明" }),
  ).toBeVisible();
  await expect(
    page.locator(".walkthrough-inline-reference").filter({ hasText: updatedReferenceLabel }),
  ).toBeVisible();
  await expect(page.locator(".document-tabs").getByRole("tab")).toHaveCount(2);
});

test("comments on the walkthrough as a whole", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openWalkthroughFromSidebar(page, primaryWalkthrough);

  await page.getByRole("button", { name: "ウォークスルー全体へコメント" }).click();
  await page
    .getByRole("textbox", { name: "ウォークスルー全体へコメント" })
    .fill("outboxの責務境界をもう少し説明してほしいです。");
  await page.getByRole("button", { name: "コメント", exact: true }).click();

  const walkthroughPane = page.locator('.document-pane[data-pane="left"]');
  await expect(
    walkthroughPane.getByText("outboxの責務境界をもう少し説明してほしいです。"),
  ).toBeVisible();
  await expect(walkthroughPane.getByText("ウォークスルー全体", { exact: true })).toBeVisible();
  await openCommentsSidebar(page);
  const sidebarComment = page
    .locator(".comment-list-item")
    .filter({ hasText: "outboxの責務境界をもう少し説明してほしいです。" });
  await expect(sidebarComment).toBeVisible();
  await expect(
    sidebarComment.getByText(`${primaryWalkthrough} · ウォークスルー全体`, { exact: true }),
  ).toBeVisible();
  const openTarget = sidebarComment.getByRole("button", { name: "コメント対象を開く" });
  await expect(openTarget).toBeVisible();
  const wholeCommentThread = walkthroughPane
    .locator(".walkthrough-comment-area .comment-thread")
    .filter({ hasText: "outboxの責務境界をもう少し説明してほしいです。" });
  await walkthroughPane
    .locator(".walkthrough-markdown")
    .evaluate((element) => element.scrollIntoView({ block: "end" }));
  await expect(wholeCommentThread).not.toBeInViewport();
  await openTarget.click();
  await expect(wholeCommentThread).toBeInViewport();
});

test("comments on selected walkthrough lines and marks them Outdated after replacement", async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openWalkthroughFromSidebar(page, primaryWalkthrough);

  const explanationLine = page
    .locator('.walkthrough-markdown [data-rvw-source-start-line="5"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "この変更は" });
  await expect(explanationLine).toHaveCount(1);
  await explanationLine.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "L5へコメント", exact: true }).click();
  await page
    .getByRole("textbox", { name: "L5へコメント" })
    .fill("この責務の説明をもう少し具体化してください。");
  await page.getByRole("textbox", { name: "L5へコメント" }).press("Control+Enter");

  const inlineLineComment = page.locator(".walkthrough-markdown .markdown-inline-comments").filter({
    hasText: "この責務の説明をもう少し具体化してください。",
  });
  await expect(inlineLineComment).toBeVisible();
  await expect(inlineLineComment.getByText("L5", { exact: true })).toBeVisible();
  await expect(explanationLine).not.toHaveClass(/rvw-markdown-commented/);
  await inlineLineComment.locator(".comment-thread").hover();
  await expect(explanationLine).toHaveClass(/rvw-markdown-commented/);
  await page.getByRole("heading", { name: "注文作成フローの全体像" }).hover();
  await expect(explanationLine).not.toHaveClass(/rvw-markdown-commented/);

  const inlineCommentId = await inlineLineComment
    .locator(".comment-thread")
    .getAttribute("data-comment-id");
  expect(inlineCommentId).not.toBeNull();
  const stableInlineComment = page.locator(
    `.walkthrough-markdown [data-comment-id="${inlineCommentId}"]`,
  );
  await stableInlineComment.locator(".comment-thread-toggle").click();
  await expect(stableInlineComment).toHaveClass(/is-collapsed/);
  const collapsedBoxBeforeCopy = await stableInlineComment.boundingBox();
  await stableInlineComment.getByRole("button", { name: "コメントのその他の操作" }).click();
  await stableInlineComment.getByRole("menuitem", { name: "参照をコピー" }).click();
  await expect(stableInlineComment.getByRole("status")).toHaveText("参照をコピーしました");
  await expect(stableInlineComment).toHaveClass(/is-collapsed/);
  const collapsedBoxAfterCopy = await stableInlineComment.boundingBox();
  expect(collapsedBoxAfterCopy?.height).toBe(collapsedBoxBeforeCopy?.height);
  await stableInlineComment.evaluate((element) => element.scrollIntoView({ block: "end" }));
  await stableInlineComment.getByRole("button", { name: "コメントのその他の操作" }).click();
  await stableInlineComment.getByRole("menuitem", { name: "編集" }).click();
  await expect
    .poll(async () => {
      const [threadBox, paneBox] = await Promise.all([
        stableInlineComment.boundingBox(),
        page.locator('.document-pane[data-pane="left"]').boundingBox(),
      ]);
      return threadBox && paneBox
        ? threadBox.y + threadBox.height <= paneBox.y + paneBox.height + 1
        : false;
    })
    .toBe(true);
  await stableInlineComment.getByRole("button", { name: "キャンセル" }).click();
  await stableInlineComment.getByPlaceholder("返信を入力").fill("下端から追加した返信です。");
  await stableInlineComment.getByPlaceholder("返信を入力").press("Control+Enter");
  await expect(
    stableInlineComment.getByText("下端から追加した返信です。", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const [threadBox, paneBox] = await Promise.all([
        stableInlineComment.boundingBox(),
        page.locator('.document-pane[data-pane="left"]').boundingBox(),
      ]);
      return threadBox && paneBox
        ? threadBox.y + threadBox.height <= paneBox.y + paneBox.height + 1
        : false;
    })
    .toBe(true);

  await page.getByRole("button", { name: "図全体へコメント", exact: true }).first().click();
  const diagramComposer = page.locator(".walkthrough-diagram-shell .inline-comment-composer--line");
  await expect(diagramComposer).toBeVisible();
  await expect(diagramComposer.getByRole("textbox")).toHaveAccessibleName(/L\d+–\d+へコメント/);
  await diagramComposer.getByRole("textbox").fill("この図全体の境界を確認してください。");
  await diagramComposer.getByRole("textbox").press("Control+Enter");
  await page.getByRole("heading", { name: "注文作成フローの全体像" }).hover();
  await expect(page.locator(".walkthrough-diagram-shell.has-comment")).toHaveCount(0);
  const diagramComment = page.locator(".markdown-inline-comments .comment-thread").filter({
    hasText: "この図全体の境界を確認してください。",
  });
  await diagramComment.hover();
  await expect(page.locator(".walkthrough-diagram-shell.has-comment")).toBeVisible();
  await page.getByRole("heading", { name: "注文作成フローの全体像" }).hover();
  await expect(page.locator(".walkthrough-diagram-shell.has-comment")).toHaveCount(0);

  const walkthroughPane = page.locator('.document-pane[data-pane="left"]');
  await walkthroughPane.evaluate((pane) => {
    pane.scrollTop = 0;
  });
  await openCommentsSidebar(page);
  const sidebarDiagramComment = page.locator(".comment-list-item").filter({
    hasText: "この図全体の境界を確認してください。",
  });
  await sidebarDiagramComment.getByRole("button", { name: "コメント対象を開く" }).click();
  await expect(page.locator(".walkthrough-diagram-shell.has-comment")).toBeVisible();
  await expect
    .poll(async () => {
      const [diagramBox, paneBox] = await Promise.all([
        page.locator(".walkthrough-diagram-shell").first().boundingBox(),
        walkthroughPane.boundingBox(),
      ]);
      if (!diagramBox || !paneBox) return false;
      return (
        diagramBox.y < paneBox.y + paneBox.height && diagramBox.y + diagramBox.height > paneBox.y
      );
    })
    .toBe(true);

  const updatedTitle = `${primaryWalkthrough}（更新後）`;
  const response = await request.post(
    "/api/fixture/walkthroughs/70000000-0000-4000-8000-000000000001/update",
    {
      data: {
        title: updatedTitle,
        body: "# 更新後の説明\n\n責務境界を全面的に書き換えました。",
        referenceLabel: "Updated route",
      },
    },
  );
  expect(response.ok()).toBe(true);

  await expect(page.getByRole("tab", { name: updatedTitle })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const sidebarLineComment = page.locator(".comment-list-item").filter({
    hasText: "この責務の説明をもう少し具体化してください。",
  });
  await expect(sidebarLineComment.locator(".badge--outdated")).toBeVisible();
  await expect(
    sidebarLineComment.getByText("コメント作成時の選択範囲", { exact: true }),
  ).toBeVisible();
  await expect(
    sidebarLineComment.getByText("この変更は、注文作成を単なる HTTP handler", { exact: false }),
  ).toBeVisible();
  await sidebarLineComment.getByRole("button", { name: "コメント対象を開く" }).click();
  await expect(
    page.locator(`.document-pane[data-pane="left"] [data-comment-id="${inlineCommentId}"]`),
  ).toBeInViewport();
});

test("deletes an unnecessary walkthrough and its whole-document feedback after confirmation", async ({
  page,
}) => {
  const title = "認証・認可境界：actorが注文に到達するまで";
  const feedback = "この説明は別のウォークスルーへ統合済みです。";
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openWalkthroughFromSidebar(page, title);

  await page.getByRole("button", { name: "ウォークスルー全体へコメント" }).click();
  await page.getByRole("textbox", { name: "ウォークスルー全体へコメント" }).fill(feedback);
  await page.getByRole("button", { name: "コメント", exact: true }).click();
  await expect(page.locator(".document-pane.active").getByText(feedback)).toBeVisible();

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("紐づくコメント 1件と投稿 1件も削除されます。");
    void dialog.accept();
  });
  await page.getByRole("button", { name: "ウォークスルーを削除" }).click();

  await expect(page.getByRole("tab", { name: title })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "ウォークスルー 4", exact: true })).toBeVisible();
  await expect(page.getByText(feedback)).toHaveCount(0);
});

test("removes both pane copies when a walkthrough is deleted externally", async ({
  page,
  request,
}) => {
  const walkthroughId = "70000000-0000-4000-8000-000000000004";
  const title = "テストマップ：各層で何を保証しているか";
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const leftPane = page.locator('.document-pane[data-pane="left"]');
  await leftPane.getByRole("button", { name: /Pull Request\.md.*を閉じる/ }).click();
  await openWalkthroughFromSidebar(page, title);
  const walkthroughButton = page
    .getByRole("navigation", { name: "レビュー文書" })
    .getByRole("button", { name: title, exact: true });
  await walkthroughButton.click({ modifiers: ["Meta"] });

  const rightPane = page.locator('.document-pane[data-pane="right"]');
  await expect(leftPane.getByRole("tab", { name: title })).toBeVisible();
  await expect(rightPane.getByRole("tab", { name: title })).toBeVisible();

  const response = await request.delete(
    `/api/pull-requests/${pullRequestId}/walkthroughs/${walkthroughId}`,
    { data: {} },
  );
  expect(response.ok()).toBe(true);
  await expect(page.getByRole("tab", { name: title })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Fixture review" })).toBeVisible();
});

test("opens a comment reference to the same file in the right pane", async ({ page, request }) => {
  const viewResponse = await request.get(`/api/pull-requests/${pullRequestId}`);
  expect(viewResponse.ok()).toBe(true);
  const { headOid } = (await viewResponse.json()) as { headOid: string };
  const createResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: headOid,
        path: "src/fixture.ts",
        startLine: 1,
        endLine: 1,
      },
      body: "Inspect [another range in this file](rvw-ref:same-file).",
      relatedCommitOid: headOid,
      references: [
        {
          id: "same-file",
          label: "Same file range",
          path: "src/fixture.ts",
          startLine: 2,
          endLine: 2,
          description: "A second reading position in the same file",
        },
      ],
      authorLabel: "Codex · Same file",
    },
  });
  expect(createResponse.ok()).toBe(true);
  const { comment } = (await createResponse.json()) as { comment: { id: string } };

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page
    .locator(".file-tree")
    .getByRole("button", { name: "src/fixture.ts", exact: true })
    .click();

  const leftPane = page.locator('.document-pane[data-pane="left"]');
  await openCommentsSidebar(page);
  const sidebarThread = page.locator(".comment-list-item").filter({
    hasText: "another range in this file",
  });
  const openTarget = sidebarThread.getByRole("button", { name: "コメント対象を開く" });
  await openTarget.click();
  await expect(leftPane.locator("diffs-container")).toHaveAttribute("data-search-target-line", "1");

  await openTarget.click({ modifiers: ["Meta"] });
  const rightPane = page.locator('.document-pane[data-pane="right"]');
  await expect(rightPane.locator("diffs-container")).toHaveAttribute(
    "data-search-target-line",
    "1",
  );
  await expect(leftPane.locator("diffs-container")).toHaveAttribute("data-search-target-line", "1");

  const inlineThread = leftPane.locator(`[data-comment-id="${comment.id}"]`);
  await inlineThread
    .getByRole("button", { name: /another range in this file/ })
    .click({ modifiers: ["Meta"] });

  await expect(leftPane.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(rightPane.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(rightPane.locator("diffs-container")).toHaveAttribute(
    "data-search-target-line",
    "2",
  );
  await expect(leftPane.locator("diffs-container")).toHaveAttribute("data-search-target-line", "1");
});

test("renders safe context-bound Markdown in sidebar and inline comment posts", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const viewResponse = await request.get(`/api/pull-requests/${pullRequestId}`);
  expect(viewResponse.ok()).toBe(true);
  const view = (await viewResponse.json()) as { headOid: string };
  const alternateSourceOid = view.headOid === "c".repeat(40) ? "b".repeat(40) : "c".repeat(40);
  const primaryWalkthroughId = "70000000-0000-4000-8000-000000000001";
  const body = [
    "## Agent Markdown finding",
    "first line",
    "second line",
    "",
    "- [x] Repository evidence checked",
    "",
    "| Evidence | Result |",
    "| --- | --- |",
    "| Fixture | Needs attention |",
    "",
    "Run `pnpm check` before posting the result.",
    "",
    "```text",
    "pnpm check",
    "```",
    "",
    "Open [the fixture source](src/fixture.ts).",
    "[Walkthrough-only reference](rvw-ref:comment-reference)",
    "Inspect [the typed fixture](rvw-ref:typed-fixture).",
    "",
    "![Order lifecycle](docs/order-lifecycle.svg)",
    "![External evidence](https://example.invalid/comment.png)",
    "",
    "<script>window.__rvwUnsafeCommentExecuted = true;</script>",
    "",
    "```mermaid",
    "flowchart LR",
    "  Request --> Review",
    "```",
  ].join("\n");
  const createResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: view.headOid,
        path: "README.md",
        startLine: 5,
        endLine: 5,
      },
      body,
      relatedCommitOid: view.headOid,
      references: [
        {
          id: "typed-fixture",
          label: "Fixture implementation",
          path: "src/fixture.ts",
          startLine: 1,
          endLine: 2,
          description: "The implementation discussed by this post",
        },
      ],
      authorLabel: "Codex · Markdown",
    },
  });
  expect(createResponse.ok()).toBe(true);
  const created = (await createResponse.json()) as { comment: { id: string } };

  const replyResponse = await request.post(`/api/comments/${created.comment.id}/posts`, {
    data: {
      body: "Reply context\n\n![Reply related commit](docs/order-lifecycle.svg)",
      relatedCommitOid: alternateSourceOid,
      authorLabel: "Codex · Related commit",
    },
  });
  expect(replyResponse.ok()).toBe(true);

  const pullRequestContextResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: { kind: "pull-request" },
      body: "![Creation head context](docs/order-lifecycle.svg)",
      authorLabel: "Codex · Creation head",
    },
  });
  expect(pullRequestContextResponse.ok()).toBe(true);
  const pullRequestContext = (await pullRequestContextResponse.json()) as {
    comment: { id: string };
  };

  const walkthroughContextResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: { kind: "walkthrough", walkthroughId: primaryWalkthroughId },
      body: "![Walkthrough source context](docs/order-lifecycle.svg)",
      authorLabel: "Codex · Walkthrough source",
    },
  });
  expect(walkthroughContextResponse.ok()).toBe(true);
  const walkthroughContext = (await walkthroughContextResponse.json()) as {
    comment: { id: string };
  };

  await page.route(`**/api/pull-requests/${pullRequestId}/walkthroughs`, async (route) => {
    const response = await route.fetch();
    const responseBody = (await response.json()) as {
      walkthroughs: Array<{ id: string; sourceOid: string }>;
    };
    responseBody.walkthroughs = responseBody.walkthroughs.map((walkthrough) =>
      walkthrough.id === primaryWalkthroughId
        ? { ...walkthrough, sourceOid: alternateSourceOid }
        : walkthrough,
    );
    await route.fulfill({ response, json: responseBody });
  });

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openCommentsSidebar(page);
  const sidebarThread = page.locator(`.comment-sidebar [data-comment-id="${created.comment.id}"]`);
  await sidebarThread.scrollIntoViewIfNeeded();
  const sidebarMarkdown = sidebarThread.locator(".comment-markdown").first();
  await expect(
    sidebarMarkdown.getByRole("heading", { name: "Agent Markdown finding" }),
  ).toBeVisible();
  const commentBodyFontSize = await sidebarMarkdown.evaluate(
    (element) => getComputedStyle(element).fontSize,
  );
  await expect(sidebarMarkdown.locator("p code").filter({ hasText: "pnpm check" })).toHaveCSS(
    "font-size",
    commentBodyFontSize,
  );
  await expect(sidebarMarkdown.locator("pre code")).toHaveCSS("font-size", commentBodyFontSize);
  await expect(sidebarMarkdown.getByRole("checkbox")).toBeChecked();
  await expect(sidebarMarkdown.getByRole("table")).toBeVisible();
  await expect(
    sidebarMarkdown.getByText("Walkthrough-only reference", { exact: true }),
  ).toBeVisible();
  await expect(
    sidebarMarkdown.getByRole("link", { name: "Walkthrough-only reference" }),
  ).toHaveCount(0);
  const typedReference = sidebarMarkdown.getByRole("button", { name: /the typed fixture/ });
  await expect(typedReference).toHaveAttribute("title", "src/fixture.ts:L1–2");
  await expect(sidebarMarkdown.locator("[data-rvw-source-start-line]")).toHaveCount(0);
  await expect(sidebarMarkdown.locator("[data-rvw-composer-anchor]")).toHaveCount(0);
  await expect(
    sidebarMarkdown.locator("p").filter({ hasText: "first line" }).locator("br"),
  ).toHaveCount(1);
  await expect(sidebarMarkdown.locator('img[alt="Order lifecycle"]')).toHaveAttribute(
    "src",
    new RegExp(
      `/api/pull-requests/${pullRequestId}/markdown-asset\\?sourceOid=${view.headOid}&path=docs%2Forder-lifecycle.svg`,
    ),
  );
  await expect(sidebarThread.locator('img[alt="Reply related commit"]')).toHaveAttribute(
    "src",
    new RegExp(
      `/api/pull-requests/${pullRequestId}/markdown-asset\\?sourceOid=${alternateSourceOid}&path=docs%2Forder-lifecycle.svg`,
    ),
  );
  await expect(
    page.locator(
      `.comment-sidebar [data-comment-id="${pullRequestContext.comment.id}"] img[alt="Creation head context"]`,
    ),
  ).toHaveAttribute(
    "src",
    new RegExp(
      `/api/pull-requests/${pullRequestId}/markdown-asset\\?sourceOid=${view.headOid}&path=docs%2Forder-lifecycle.svg`,
    ),
  );
  await expect(
    page.locator(
      `.comment-sidebar [data-comment-id="${walkthroughContext.comment.id}"] img[alt="Walkthrough source context"]`,
    ),
  ).toHaveAttribute(
    "src",
    new RegExp(
      `/api/pull-requests/${pullRequestId}/markdown-asset\\?sourceOid=${alternateSourceOid}&path=docs%2Forder-lifecycle.svg`,
    ),
  );
  await expect(
    sidebarMarkdown.getByRole("img", {
      name: "画像: External evidence（自動読み込み停止）",
    }),
  ).toBeVisible();
  await expect(sidebarMarkdown.locator("script")).toHaveCount(0);
  expect(await page.evaluate(() => "__rvwUnsafeCommentExecuted" in window)).toBe(false);
  const sidebarDiagram = sidebarMarkdown.locator(".comment-mermaid-shell");
  await sidebarDiagram.scrollIntoViewIfNeeded();
  await expect(sidebarDiagram.locator("svg")).toBeVisible();
  await expect(sidebarDiagram.locator("[data-walkthrough-reference-id]")).toHaveCount(0);

  const commitPicker = page.getByRole("button", { name: /^対象commit:/ });
  const initialCommitSelection = await commitPicker.getAttribute("aria-label");
  await typedReference.click();
  await expect(page.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator('diffs-container[data-search-target-line="1"]')).toBeVisible();
  await expect(
    page.locator('diffs-container [data-line="1"][data-selected-line="first"]'),
  ).toBeVisible();
  await expect(
    page.locator('diffs-container [data-line="2"][data-selected-line="last"]'),
  ).toBeVisible();
  await expect(commitPicker).toHaveAttribute("aria-label", initialCommitSelection!);

  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await page.locator(".file-tree").getByRole("button", { name: "README.md", exact: true }).click();
  const inlineThread = page.locator(
    `.markdown-inline-comments [data-comment-id="${created.comment.id}"]`,
  );
  await expect(inlineThread).toBeVisible();
  await expect(inlineThread.getByRole("heading", { name: "Agent Markdown finding" })).toBeVisible();

  await sidebarThread.getByRole("link", { name: "the fixture source" }).click();
  await expect(page.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await sidebarThread
    .locator(".comment-thread-header")
    .getByRole("button", { name: "コメントのその他の操作" })
    .click();
  await page
    .getByRole("menu", { name: "コメントのその他の操作" })
    .getByRole("menuitem", { name: "編集" })
    .click();
  await expect(sidebarThread.getByRole("textbox", { name: "コメントを編集" })).toHaveValue(body);
  await sidebarThread.getByRole("button", { name: "キャンセル" }).click();
});

test("removes Mermaid temporary output when a Markdown comment diagram is invalid", async ({
  page,
  request,
}) => {
  const createResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: { kind: "pull-request" },
      body: ["Invalid diagram", "", "```mermaid", "flowchart LR", "  Request -->", "```"].join(
        "\n",
      ),
      authorLabel: "Codex · Invalid Mermaid",
    },
  });
  expect(createResponse.ok()).toBe(true);
  const created = (await createResponse.json()) as { comment: { id: string } };

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openCommentsSidebar(page);
  const thread = page.locator(`.comment-sidebar [data-comment-id="${created.comment.id}"]`);
  await thread.scrollIntoViewIfNeeded();
  await expect(thread.locator(".comment-mermaid-error")).toBeVisible();
  await expect(page.locator('body > [id^="drvwComment"], body > [id^="irvwComment"]')).toHaveCount(
    0,
  );
});
