import { expect, test } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";

test("reviews a line across commits, preserves the tabbed UI, and resolves it", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(60_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await expect(page.getByRole("heading", { name: "Fixture review" })).toBeVisible();
  await expect(page).toHaveTitle(/^rvw: Fixture review(?: updated)?$/);
  const pullRequestLink = page.getByRole("link", { name: "Fixture review" });
  await expect(pullRequestLink).toHaveAttribute(
    "href",
    "https://github.com/acme/review-repo/pull/7",
  );
  await expect(pullRequestLink).toHaveAttribute("target", "_blank");
  const viewportLayout = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar");
    const mainView = document.querySelector(".main-view");
    const appShell = document.querySelector(".app-shell");
    const topbar = document.querySelector(".topbar");
    const workspace = document.querySelector(".workspace");
    return {
      bodyClientHeight: document.body.clientHeight,
      bodyScrollHeight: document.body.scrollHeight,
      bodyOverflow: getComputedStyle(document.body).overflow,
      sidebarOverflowY: sidebar ? getComputedStyle(sidebar).overflowY : null,
      mainViewOverflowY: mainView ? getComputedStyle(mainView).overflowY : null,
      appHeight: appShell?.getBoundingClientRect().height ?? 0,
      viewportHeight: window.innerHeight,
      topbarHeight: topbar?.getBoundingClientRect().height ?? 0,
      workspaceTop: workspace?.getBoundingClientRect().top ?? 0,
    };
  });
  expect(viewportLayout.bodyScrollHeight).toBe(viewportLayout.bodyClientHeight);
  expect(viewportLayout.bodyOverflow).toBe("hidden");
  expect(viewportLayout.sidebarOverflowY).toBe("hidden");
  expect(viewportLayout.mainViewOverflowY).toBe("auto");
  expect(viewportLayout.appHeight).toBeLessThanOrEqual(viewportLayout.viewportHeight);
  expect(viewportLayout.topbarHeight).toBe(68);
  expect(viewportLayout.workspaceTop).toBe(68);
  const browserCloseGuard = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    const dispatchAllowed = window.dispatchEvent(event);
    return { dispatchAllowed, defaultPrevented: event.defaultPrevented };
  });
  expect(browserCloseGuard).toEqual({ dispatchAllowed: true, defaultPrevented: false });
  await expect(page.getByText("Pull Request.md", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  const reviewScope = page.getByRole("region", { name: "レビュー範囲", exact: true });
  const displayFullButton = reviewScope.getByRole("button", { name: "全文", exact: true });
  const displayDiffButton = reviewScope.getByRole("button", { name: "変更", exact: true });
  const stackedButton = reviewScope.getByRole("button", { name: "stacked", exact: true });
  const splitButton = reviewScope.getByRole("button", { name: "split", exact: true });
  const diffStyleModes = reviewScope.locator(".diff-style-modes");
  await expect(stackedButton).toBeVisible();
  await expect(stackedButton).toBeDisabled();
  await expect(splitButton).toBeDisabled();
  const commitPicker = reviewScope.getByRole("button", { name: /^対象commit:/ });
  const commitDialog = page.getByRole("dialog", { name: "対象commitを選択" });
  const selectCommitOnly = async (name: RegExp): Promise<void> => {
    await commitPicker.click();
    await commitDialog.getByRole("option", { name }).click();
  };
  const selectCommitRangeByDrag = async (startName: RegExp, endName: RegExp): Promise<void> => {
    await commitPicker.click();
    const start = commitDialog.getByRole("option", { name: startName });
    const end = commitDialog.getByRole("option", { name: endName });
    const startBox = await start.boundingBox();
    const endBox = await end.boundingBox();
    expect(startBox).not.toBeNull();
    expect(endBox).not.toBeNull();
    await page.mouse.move(startBox!.x + startBox!.width / 2, startBox!.y + startBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(endBox!.x + endBox!.width / 2, endBox!.y + endBox!.height / 2, {
      steps: 6,
    });
    await page.mouse.up();
  };
  const actionsMenuButton = page.getByRole("button", { name: "その他の操作", exact: true });
  await actionsMenuButton.click();
  let actionsMenu = page.getByRole("menu");
  let hideWhitespaceMenuItem = actionsMenu.getByRole("menuitemcheckbox", {
    name: "Hide Whitespace",
    exact: true,
  });
  await expect(hideWhitespaceMenuItem).toBeDisabled();
  await expect(actionsMenu.getByRole("menuitemradio", { name: "システム" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await actionsMenu.getByRole("menuitemradio", { name: "ダークモード" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(13, 17, 23)");
  await expect(page.locator(".topbar")).toHaveCSS("background-color", "rgb(1, 4, 9)");
  const darkDiffColors = await page
    .locator("diffs-container")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        color: style.color,
      };
    });
  expect(darkDiffColors).toEqual({
    background: "rgb(13, 17, 23)",
    color: "rgb(240, 246, 252)",
  });
  await expect
    .poll(async () => await page.evaluate(() => window.localStorage.getItem("rvw.theme")))
    .toBe("dark");
  await actionsMenuButton.click();
  actionsMenu = page.getByRole("menu");
  await actionsMenu.getByRole("menuitemradio", { name: "ライトモード" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(246, 248, 250)");
  await expect(page.locator(".topbar")).toHaveCSS("background-color", "rgb(36, 41, 47)");
  await expect(page.locator("diffs-container").first()).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect
    .poll(
      async () =>
        await page.locator(".document-tab.active").evaluate((element) => ({
          header: getComputedStyle(document.querySelector(".topbar")!).backgroundColor,
          tabAccent: getComputedStyle(element, "::before").backgroundColor,
        })),
    )
    .toEqual({ header: "rgb(36, 41, 47)", tabAccent: "rgb(9, 105, 218)" });
  await actionsMenuButton.click();
  actionsMenu = page.getByRole("menu");
  await actionsMenu.getByRole("menuitemradio", { name: "システム" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
  await expect(page.locator(".topbar").getByRole("region", { name: "レビュー範囲" })).toBeVisible();
  const codeStack = page.getByRole("button", { name: "エクスプローラー", exact: true });
  const commentsStack = page.getByRole("button", { name: "コメント 0", exact: true });
  await expect(codeStack).toHaveAttribute("aria-expanded", "true");
  await expect(commentsStack).toHaveAttribute("aria-expanded", "false");
  await codeStack.click();
  await expect(codeStack).toHaveAttribute("aria-expanded", "false");
  await expect(commentsStack).toHaveAttribute("aria-expanded", "false");
  await codeStack.click();
  const fileNameSearchInput = page.getByPlaceholder("ファイル名を検索");
  await expect(fileNameSearchInput).toHaveCSS("height", "34px");
  await expect(fileNameSearchInput).toHaveCSS("font-size", "12px");
  const showUnchangedFiles = page.getByRole("checkbox", {
    name: "変更のないファイルも表示",
  });
  await expect(showUnchangedFiles).not.toBeChecked();
  const fileControlRects = await Promise.all(
    [
      page.locator(".review-tree-items"),
      fileNameSearchInput,
      page.locator(".file-scope-checkbox"),
      page.locator(".file-tree"),
    ].map((locator) =>
      locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      }),
    ),
  );
  const reviewToSearchGap = fileControlRects[1]!.top - fileControlRects[0]!.bottom;
  expect(reviewToSearchGap).toBeGreaterThanOrEqual(6);
  expect(reviewToSearchGap).toBeLessThanOrEqual(10);
  const groupedFileControlGaps = [
    fileControlRects[2]!.top - fileControlRects[1]!.bottom,
    fileControlRects[3]!.top - fileControlRects[2]!.bottom,
  ];
  expect(groupedFileControlGaps.every((gap) => gap >= 2 && gap <= 4)).toBe(true);
  await expect(page.locator(".file-tree-summary")).toHaveCSS("padding-top", "0px");
  await expect(page.locator(".file-tree-summary")).toHaveCSS("padding-bottom", "0px");
  await expect(page.getByRole("button", { name: "全ファイル", exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole("button", { name: "src/fixture.ts" })
      .locator('[data-file-icon="lang-typescript-duo"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "src/fixture.ts" }).locator('[data-change-kind="modified"]'),
  ).toBeVisible();
  const fixtureTreeFile = page.getByRole("button", { name: "src/fixture.ts", exact: true });
  await expect(fixtureTreeFile.locator('[data-file-icon="lang-typescript-duo"]')).toBeVisible();
  const pullRequestShortcut = page.getByRole("button", {
    name: "Pull Request.md",
    exact: true,
  });
  await expect(pullRequestShortcut.locator('[data-file-icon="lang-markdown"]')).toBeVisible();
  expect(
    await pullRequestShortcut.evaluate(
      (element) => element.parentElement?.classList.contains("review-tree-items") ?? false,
    ),
  ).toBe(true);
  const walkthroughShortcut = page.getByRole("button", {
    name: "ウォークスルー 6",
    exact: true,
  });
  await walkthroughShortcut.click();
  await expect(page.locator(".review-tree-walkthrough-list .review-tree-walkthrough")).toHaveCount(
    6,
  );
  await page.keyboard.press("Escape");
  await fixtureTreeFile.click();
  await commitPicker.click();
  await expect(
    commitDialog.getByRole("option", { name: /Trim fixture input.*最新/ }),
  ).toBeVisible();
  await expect(page).toHaveTitle("rvw: Fixture review updated");
  await expect(commitPicker).toHaveAccessibleName(/2 commits.*PR全体/);
  await expect(commitDialog.getByRole("option", { selected: true })).toHaveCount(2);
  await expect(commitDialog.locator(".commit-range-option-meta time")).toHaveCount(2);
  await expect(commitDialog.locator(".commit-range-option-meta time").first()).toHaveAttribute(
    "datetime",
    /^2026-08-08T/,
  );
  await expect(commitDialog.getByRole("option", { name: /Add fixture function/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    commitDialog.getByRole("option", { name: /Trim fixture input.*最新/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(commitDialog.getByText("クリックで1件・ドラッグで連続範囲を選択")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(commitPicker.locator(".commit-selection-badge")).toHaveText("PR全体");
  await expect(commitPicker.locator(".commit-selection-badge")).toHaveCSS(
    "background-color",
    "rgb(31, 111, 235)",
  );
  await selectCommitOnly(/Add fixture function/);
  await expect(commitPicker).toHaveAccessibleName(/Add fixture function/);
  await expect(commitPicker.locator(".commit-selection-badge")).toHaveCount(0);
  await commitPicker.click();
  await commitDialog.getByRole("button", { name: "最新だけ", exact: true }).click();
  await expect(commitPicker).toHaveAccessibleName(/最新/);
  await expect(commitPicker.locator(".commit-selection-badge")).toHaveText("最新");
  await commitPicker.click();
  await commitDialog.getByRole("button", { name: "PR全体", exact: true }).click();
  await expect(commitPicker).toHaveAccessibleName(/2 commits.*PR全体/);
  await expect(commitPicker.locator(".commit-selection-badge")).toHaveText("PR全体");
  await expect(
    page.getByRole("tab", { name: "src/fixture.ts" }).locator('[data-change-kind="modified"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "src/fixture.tsを閉じる" }).click();

  await page.getByRole("button", { name: "src/new.ts", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "src/new.ts" }).locator('[data-change-kind="added"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "src/new.tsを閉じる" }).click();

  await page.getByRole("button", { name: "src/removed.ts", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "src/removed.ts" }).locator('[data-change-kind="deleted"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "src/removed.tsを閉じる" }).click();

  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  const srcFolder = page.getByRole("button", { name: "src フォルダ" });
  await expect(srcFolder).toHaveAttribute("aria-expanded", "false");
  await expect(srcFolder.locator('[data-file-icon="folder-duo"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "src/fixture.ts" })).toBeHidden();

  await page.getByRole("button", { name: "ファイルツリーをすべて展開" }).click();
  await expect(srcFolder).toHaveAttribute("aria-expanded", "true");
  await expect(srcFolder.locator('[data-file-icon="folder-open-duo"]')).toBeVisible();
  await expect(
    page.getByRole("button", { name: "src/fixture.ts" }).locator('[data-change-kind="modified"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "src/new.ts" }).locator('[data-change-kind="added"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "src/removed.ts" }).locator('[data-change-kind="deleted"]'),
  ).toBeVisible();
  const firstFileTopBeforeWalkthroughs = await page
    .getByRole("button", { name: "src/fixture.ts", exact: true })
    .evaluate((element) => element.getBoundingClientRect().top);
  await walkthroughShortcut.click();
  await expect(page.locator(".review-tree-walkthrough-list")).toBeVisible();
  const firstFileTopWithWalkthroughs = await page
    .getByRole("button", { name: "src/fixture.ts", exact: true })
    .evaluate((element) => element.getBoundingClientRect().top);
  expect(firstFileTopWithWalkthroughs).toBeGreaterThan(firstFileTopBeforeWalkthroughs);
  await page.keyboard.press("Escape");
  const firstFileTopAfterWalkthroughs = await page
    .getByRole("button", { name: "src/fixture.ts", exact: true })
    .evaluate((element) => element.getBoundingClientRect().top);
  expect(firstFileTopAfterWalkthroughs).toBeCloseTo(firstFileTopBeforeWalkthroughs, 1);
  await page.getByRole("button", { name: "ファイルツリーをすべて折りたたむ" }).click();
  await expect(srcFolder.locator('[data-file-icon="folder-duo"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "src/fixture.ts" })).toBeHidden();
  await page.getByRole("button", { name: "src フォルダ" }).click();
  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  await expect(page.getByText("src/fixture.ts", { exact: true }).first()).toBeVisible();
  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).uncheck();
  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await expect(srcFolder).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "docs フォルダ" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".document-tabs").getByRole("tab")).toHaveCount(2);
  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  await expect(page.locator(".document-tabs").getByRole("tab")).toHaveCount(2);
  await expect(displayFullButton).toBeVisible();
  await selectCommitOnly(/Add fixture function/);
  const reviewControlLayout = async () => {
    const styleBox = await diffStyleModes.boundingBox();
    const menuBox = await actionsMenuButton.boundingBox();
    expect(styleBox).not.toBeNull();
    expect(menuBox).not.toBeNull();
    return {
      menuX: menuBox!.x,
      styleWidth: styleBox!.width,
      styleX: styleBox!.x,
    };
  };
  await displayFullButton.click();
  await expect(displayFullButton).toHaveAttribute("aria-pressed", "true");
  await expect(stackedButton).toBeEnabled();
  await expect(splitButton).toBeEnabled();
  const fullLayout = await reviewControlLayout();
  await actionsMenuButton.click();
  actionsMenu = page.getByRole("menu");
  hideWhitespaceMenuItem = actionsMenu.getByRole("menuitemcheckbox", {
    name: "Hide Whitespace",
    exact: true,
  });
  await expect(hideWhitespaceMenuItem).toBeDisabled();
  await actionsMenuButton.click();
  await splitButton.click();
  await expect(displayDiffButton).toHaveAttribute("aria-pressed", "true");
  await expect(splitButton).toHaveAttribute("aria-pressed", "true");
  expect(await reviewControlLayout()).toEqual(fullLayout);
  await displayFullButton.click();
  await expect(displayFullButton).toHaveAttribute("aria-pressed", "true");
  await expect(stackedButton).toBeEnabled();
  await stackedButton.click();
  await expect(displayDiffButton).toHaveAttribute("aria-pressed", "true");
  await expect(stackedButton).toHaveAttribute("aria-pressed", "true");
  expect(await reviewControlLayout()).toEqual(fullLayout);
  const diff = page.locator("diffs-container");
  const changedDiffLines = diff.locator('[data-line-type^="change-"]');
  await expect(diff.locator("[data-diffs-header]")).toBeVisible();
  expect(await changedDiffLines.count()).toBeGreaterThan(0);
  await actionsMenuButton.click();
  actionsMenu = page.getByRole("menu");
  hideWhitespaceMenuItem = actionsMenu.getByRole("menuitemcheckbox", {
    name: "Hide Whitespace",
    exact: true,
  });
  await expect(hideWhitespaceMenuItem).toBeEnabled();
  await hideWhitespaceMenuItem.click();
  await expect(hideWhitespaceMenuItem).toHaveAttribute("aria-checked", "true");
  await actionsMenuButton.click();
  await expect(changedDiffLines).toHaveCount(0);
  const whitespaceEmptyState = page.locator(".diff-whitespace-empty");
  await expect(whitespaceEmptyState).toContainText("空白差分をすべて非表示にしています。");
  await expect(whitespaceEmptyState).toContainText("…」メニューで Hide Whitespace を解除");
  await actionsMenuButton.click();
  hideWhitespaceMenuItem = page
    .getByRole("menu")
    .getByRole("menuitemcheckbox", { name: "Hide Whitespace", exact: true });
  await hideWhitespaceMenuItem.click();
  await expect(hideWhitespaceMenuItem).toHaveAttribute("aria-checked", "false");
  await actionsMenuButton.click();
  await expect(whitespaceEmptyState).toBeHidden();
  await expect.poll(async () => await changedDiffLines.count()).toBeGreaterThan(0);
  await commitPicker.click();
  await commitDialog.getByRole("button", { name: "PR全体", exact: true }).click();
  await expect(commitPicker).toHaveAccessibleName(/2 commits.*PR全体/);
  await expect(diff.locator("[data-deletions-count]")).toBeVisible();
  await expect(diff.locator("[data-additions-count]")).toBeVisible();
  const renderedDiffColors = () =>
    diff.evaluate((element) => {
      const root = element.shadowRoot!;
      const background = (selector: string) => {
        const target = root.querySelector<HTMLElement>(selector);
        return target ? getComputedStyle(target).backgroundColor : null;
      };
      const color = (selector: string) => {
        const target = root.querySelector<HTMLElement>(selector);
        return target ? getComputedStyle(target).color : null;
      };
      const colorFor = (target: HTMLElement) => getComputedStyle(target).color;
      const emphasisTextColors = (selector: string) => {
        const emphasis = root.querySelector<HTMLElement>(selector);
        if (!emphasis) return null;
        const tokens = [...emphasis.querySelectorAll<HTMLElement>("span")];
        return [
          ...new Set((tokens.length > 0 ? tokens : [emphasis]).map((token) => colorFor(token))),
        ];
      };
      return {
        background: getComputedStyle(element).backgroundColor,
        additionLine: background('[data-line][data-line-type="change-addition"]'),
        additionNumber: background('[data-column-number][data-line-type="change-addition"]'),
        additionNumberText: color('[data-column-number][data-line-type="change-addition"]'),
        additionWord: background('[data-line-type="change-addition"] [data-diff-span]'),
        additionWordText: emphasisTextColors('[data-line-type="change-addition"] [data-diff-span]'),
        deletionLine: background('[data-line][data-line-type="change-deletion"]'),
        deletionNumber: background('[data-column-number][data-line-type="change-deletion"]'),
        deletionNumberText: color('[data-column-number][data-line-type="change-deletion"]'),
        deletionWord: background('[data-line-type="change-deletion"] [data-diff-span]'),
        deletionWordText: emphasisTextColors('[data-line-type="change-deletion"] [data-diff-span]'),
      };
    });
  await actionsMenuButton.click();
  actionsMenu = page.getByRole("menu");
  await actionsMenu.getByRole("menuitemradio", { name: "ライトモード" }).click();
  await expect.poll(renderedDiffColors).toEqual({
    background: "rgb(255, 255, 255)",
    additionLine: "rgb(218, 251, 225)",
    additionNumber: "rgb(172, 238, 187)",
    additionNumberText: "rgb(31, 35, 40)",
    additionWord: "rgb(172, 238, 187)",
    additionWordText: ["rgb(31, 35, 40)"],
    deletionLine: "rgb(255, 235, 233)",
    deletionNumber: "rgb(255, 206, 203)",
    deletionNumberText: "rgb(31, 35, 40)",
    deletionWord: "rgb(255, 206, 203)",
    deletionWordText: ["rgb(31, 35, 40)"],
  });
  await actionsMenuButton.click();
  actionsMenu = page.getByRole("menu");
  await actionsMenu.getByRole("menuitemradio", { name: "ダークモード" }).click();
  await expect.poll(renderedDiffColors).toEqual({
    background: "rgb(13, 17, 23)",
    additionLine: "rgba(46, 160, 67, 0.15)",
    additionNumber: "rgba(63, 185, 80, 0.3)",
    additionNumberText: "rgb(240, 246, 252)",
    additionWord: "rgba(46, 160, 67, 0.4)",
    additionWordText: ["rgb(240, 246, 252)"],
    deletionLine: "rgba(248, 81, 73, 0.1)",
    deletionNumber: "rgba(248, 81, 73, 0.3)",
    deletionNumberText: "rgb(240, 246, 252)",
    deletionWord: "rgba(248, 81, 73, 0.4)",
    deletionWordText: ["rgb(240, 246, 252)"],
  });
  await actionsMenuButton.click();
  actionsMenu = page.getByRole("menu");
  await actionsMenu.getByRole("menuitemradio", { name: "システム" }).click();
  await expect(
    diff
      .locator('[slot="header-metadata"]')
      .getByRole("button", { name: "ファイル全体へコメント" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  await expect(reviewScope.getByRole("button", { name: "変更", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(stackedButton).toBeDisabled();
  await expect(splitButton).toBeDisabled();
  await expect(page.getByText("差分なし · 全文表示")).toBeVisible();
  await expect(page.getByText("Repository documentation updated.")).toBeVisible();

  await fixtureTreeFile.click({ modifiers: ["Meta"] });
  const rightPane = page.locator('.document-pane[data-pane="right"]');
  await expect(rightPane.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page
    .locator('.document-pane[data-pane="left"]')
    .getByRole("tab", { name: "README.md" })
    .click();
  await expect(stackedButton).toBeEnabled();
  await expect(splitButton).toBeEnabled();
  await splitButton.click();
  await expect(splitButton).toHaveAttribute("aria-pressed", "true");
  await expect(rightPane.locator("diffs-container")).toBeVisible();
  await stackedButton.click();
  await expect(stackedButton).toHaveAttribute("aria-pressed", "true");
  await rightPane.getByRole("button", { name: "src/fixture.tsを閉じる" }).click();
  await expect(stackedButton).toBeDisabled();
  await expect(splitButton).toBeDisabled();

  await page.getByRole("button", { name: "README.mdを閉じる" }).click();
  await expect(page.getByRole("tab", { name: "README.md" })).toHaveCount(0);
  await fixtureTreeFile.click();
  await expect(page.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(reviewScope.getByRole("button", { name: "変更", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(stackedButton).toBeEnabled();
  await expect(splitButton).toBeEnabled();
  await page.getByRole("tab", { name: "Pull Request.md" }).click();
  await expect(reviewScope.getByRole("button", { name: "変更", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(reviewScope.getByRole("button", { name: "変更", exact: true })).toBeEnabled();
  await expect(page.getByText("差分なし · 全文表示")).toBeVisible();
  await page.getByRole("tab", { name: "src/fixture.ts" }).click();
  await expect(reviewScope.getByRole("button", { name: "変更", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await reviewScope.getByRole("button", { name: "全文", exact: true }).click();
  await expect(reviewScope.getByRole("button", { name: "全文", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await expect(page.locator(".composer")).toHaveCount(0);
  await expect(page.locator(".viewer-toolbar")).toHaveCount(0);
  await expect(diff.locator("[data-diffs-header]")).toBeVisible();
  const firstLineNumber = diff.locator('[data-column-number="1"]').first();
  const secondLineNumber = diff.locator('[data-column-number="2"]').first();
  const gutterCommentButton = diff.locator("[data-utility-button]").first();

  await firstLineNumber.hover();
  await expect(gutterCommentButton).toBeVisible();
  const firstCodeLine = diff.locator("[data-line]").first();
  await firstLineNumber.hover();
  const gutterButtonBox = await gutterCommentButton.boundingBox();
  const firstCodeLineBox = await firstCodeLine.boundingBox();
  const firstCodeLinePadding = await firstCodeLine.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).paddingLeft),
  );
  expect(gutterButtonBox).not.toBeNull();
  expect(firstCodeLineBox).not.toBeNull();
  expect(
    firstCodeLineBox!.x + firstCodeLinePadding - (gutterButtonBox!.x + gutterButtonBox!.width),
  ).toBeGreaterThanOrEqual(4);
  const lineComposer = page.locator(".inline-comment-composer--line");
  await page.mouse.move(
    gutterButtonBox!.x + gutterButtonBox!.width / 2,
    gutterButtonBox!.y + gutterButtonBox!.height / 2,
  );
  await page.mouse.down();
  await expect(lineComposer).toHaveCount(0);
  await page.mouse.up();
  await expect(lineComposer).toBeVisible();
  await expect(
    lineComposer.getByRole("textbox", { name: "src/fixture.ts · L1へコメント" }),
  ).toBeVisible();
  await lineComposer
    .getByRole("textbox", { name: "src/fixture.ts · L1へコメント" })
    .fill("Escapeで破棄するコメント");
  await lineComposer
    .getByRole("textbox", { name: "src/fixture.ts · L1へコメント" })
    .press("Escape");
  await expect(lineComposer).toHaveCount(0);

  await firstLineNumber.hover();
  const dragButtonBox = await gutterCommentButton.boundingBox();
  const secondLineBox = await secondLineNumber.boundingBox();
  expect(dragButtonBox).not.toBeNull();
  expect(secondLineBox).not.toBeNull();
  await page.mouse.move(
    dragButtonBox!.x + dragButtonBox!.width / 2,
    dragButtonBox!.y + dragButtonBox!.height / 2,
  );
  await page.mouse.down();
  await expect(lineComposer).toHaveCount(0);
  await page.mouse.move(
    secondLineBox!.x + secondLineBox!.width / 2,
    secondLineBox!.y + secondLineBox!.height / 2,
  );
  await expect(diff.locator("[data-line][data-selected-line]")).toHaveCount(2);
  await expect(lineComposer).toHaveCount(0);
  await page.mouse.up();

  await expect(lineComposer).toBeVisible();
  await lineComposer
    .getByRole("textbox", { name: "src/fixture.ts · L1–2へコメント" })
    .fill("関数の契約を確認してください。");
  const originalViewport = page.viewportSize();
  expect(originalViewport).not.toBeNull();
  await page.setViewportSize({ width: originalViewport!.width, height: 360 });
  const documentPane = page.locator('.document-pane[data-pane="left"]');
  const anchoredScrollTop = await documentPane.evaluate((element) => {
    element.scrollTop = Math.min(160, element.scrollHeight - element.clientHeight);
    return element.scrollTop;
  });
  expect(anchoredScrollTop).toBeGreaterThan(0);
  const visibleDiffAnchor = async () =>
    await diff.evaluate((element) => {
      const pane = element.closest<HTMLElement>(".document-pane")!;
      const viewportTop = pane
        .querySelector(".document-tabs-shell")!
        .getBoundingClientRect().bottom;
      const lines = [...element.shadowRoot!.querySelectorAll<HTMLElement>("[data-line]")]
        .map((line) => ({ line, rect: line.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > viewportTop)
        .sort((left, right) => left.rect.top - right.rect.top);
      return {
        line: lines[0]?.line.dataset.line ?? null,
        topOffset: (lines[0]?.rect.top ?? viewportTop) - viewportTop,
      };
    });
  const anchorBeforeSubmit = await visibleDiffAnchor();
  expect(anchorBeforeSubmit.line).not.toBeNull();
  await diff.evaluate((element) => {
    const observed = element as HTMLElement & {
      rvwAnnotationObserver?: MutationObserver;
      rvwMinimumAnnotationCount?: number;
    };
    observed.rvwMinimumAnnotationCount = element.querySelectorAll('[slot^="annotation-"]').length;
    observed.rvwAnnotationObserver = new MutationObserver(() => {
      observed.rvwMinimumAnnotationCount = Math.min(
        observed.rvwMinimumAnnotationCount ?? Number.POSITIVE_INFINITY,
        element.querySelectorAll('[slot^="annotation-"]').length,
      );
    });
    observed.rvwAnnotationObserver.observe(element, { childList: true });
  });
  await page.keyboard.press("Control+Enter");
  const createdInlineLineThread = page.locator(".comment-thread--inline").filter({
    hasText: "関数の契約を確認してください。",
  });
  await expect(createdInlineLineThread).toBeVisible();
  const commentsWithOneUnresolved = page.getByRole("button", {
    name: "コメント 1",
    exact: true,
  });
  await expect(commentsWithOneUnresolved).toHaveAttribute("aria-expanded", "false");
  await commentsWithOneUnresolved.click();
  await expect(commentsWithOneUnresolved).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const anchorAfterSubmit = await visibleDiffAnchor();
  expect(anchorAfterSubmit.line).toBe(anchorBeforeSubmit.line);
  expect(Math.abs(anchorAfterSubmit.topOffset - anchorBeforeSubmit.topOffset)).toBeLessThanOrEqual(
    1,
  );
  const minimumAnnotationCount = await diff.evaluate((element) => {
    const observed = element as HTMLElement & {
      rvwAnnotationObserver?: MutationObserver;
      rvwMinimumAnnotationCount?: number;
    };
    observed.rvwAnnotationObserver?.disconnect();
    return observed.rvwMinimumAnnotationCount;
  });
  expect(minimumAnnotationCount).toBeGreaterThan(0);
  await page.setViewportSize(originalViewport!);
  const lineCommentId = await createdInlineLineThread.getAttribute("data-comment-id");
  expect(lineCommentId).toBeTruthy();
  const inlineLineThread = page.locator(
    `.comment-thread--inline[data-comment-id="${lineCommentId}"]`,
  );
  await expect(inlineLineThread.locator(".comment-thread-target")).toHaveText("L1–2");
  await expect
    .poll(async () => {
      const secondRenderedLineBox = await diff.locator("[data-line]").nth(1).boundingBox();
      const threadBox = await inlineLineThread.boundingBox();
      if (!secondRenderedLineBox || !threadBox) return false;
      return threadBox.y >= secondRenderedLineBox.y + secondRenderedLineBox.height - 1;
    })
    .toBe(true);
  await expect(inlineLineThread.locator(".comment-thread-meta")).toHaveCount(0);
  await expect(
    inlineLineThread.locator(".comment-thread-badges").getByText("未解決", { exact: true }),
  ).toHaveCount(0);
  const inlineHeader = inlineLineThread.locator(".comment-thread-header");
  await expect
    .poll(async () => (await inlineHeader.boundingBox())?.height ?? Number.POSITIVE_INFINITY)
    .toBeLessThanOrEqual(40);
  await expect
    .poll(async () => (await inlineLineThread.boundingBox())?.width ?? Number.POSITIVE_INFINITY)
    .toBeLessThanOrEqual(736);
  await expect(inlineLineThread.getByPlaceholder("返信を入力")).toBeVisible();
  await expect(
    inlineLineThread.getByRole("button", { name: /コード内から返信を送信$/ }),
  ).toBeVisible();
  await inlineLineThread.getByPlaceholder("返信を入力").fill("Diffから確認済みです。");
  await inlineLineThread.getByPlaceholder("返信を入力").press("Control+Enter");
  await expect(inlineLineThread.getByText("Diffから確認済みです。", { exact: true })).toBeVisible();

  await inlineLineThread.getByRole("button", { name: "1件目の返信のその他の操作" }).click();
  await inlineLineThread.getByRole("menuitem", { name: "編集" }).click();
  await inlineLineThread
    .getByRole("textbox", { name: "返信を編集" })
    .fill("Diffから編集済みです。");
  await inlineLineThread.getByRole("textbox", { name: "返信を編集" }).press("Control+Enter");
  await expect(inlineLineThread.getByText("Diffから編集済みです。", { exact: true })).toBeVisible();

  const secondReplyResponse = await request.post(`/api/comments/${lineCommentId}/posts`, {
    data: {
      body: "削除する返信です。",
      authorLabel: "You",
      relatedCommitOid: null,
    },
  });
  expect(secondReplyResponse.ok()).toBe(true);
  await expect(inlineLineThread.getByText("削除する返信です。", { exact: true })).toBeVisible();
  await inlineLineThread.getByRole("button", { name: "2件目の返信のその他の操作" }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await inlineLineThread.getByRole("menuitem", { name: "削除" }).click();
  await expect(inlineLineThread.getByText("削除する返信です。", { exact: true })).toHaveCount(0);

  await inlineLineThread.getByRole("button", { name: "解決", exact: true }).click();
  await expect(inlineLineThread.getByText("解決済み", { exact: true })).toBeVisible();
  await expect(inlineLineThread).toHaveClass(/is-collapsed/);
  await expect(inlineLineThread.getByPlaceholder("返信を入力")).toHaveCount(0);
  await inlineLineThread.locator(".comment-thread-toggle").click();
  await inlineLineThread.getByRole("button", { name: "再度開く", exact: true }).click();
  await expect(inlineLineThread).toHaveClass(/is-expanded/);
  await expect(
    inlineLineThread.locator(".comment-thread-badges").getByText("未解決", { exact: true }),
  ).toHaveCount(0);
  await inlineLineThread.locator(".comment-thread-toggle").click();
  await expect(inlineLineThread).toHaveClass(/is-collapsed/);
  await page.getByRole("tab", { name: "Pull Request.md" }).click();
  await page.getByRole("tab", { name: "src/fixture.ts" }).click();
  await expect(inlineLineThread).toHaveClass(/is-collapsed/);
  await inlineLineThread.locator(".comment-thread-toggle").click();

  await page.getByRole("button", { name: "ファイル全体へコメント" }).click();
  const fileComposer = page.locator(".inline-comment-composer--file");
  await expect(fileComposer).toBeVisible();
  await fileComposer
    .getByRole("textbox", { name: "ファイル全体へコメント" })
    .fill("ファイル全体のコメントです。");
  await fileComposer.getByRole("textbox", { name: "ファイル全体へコメント" }).press("Meta+Enter");

  const prBodyCommentResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "document",
        documentKind: "pull-request-markdown",
        sourceDocumentHash: "fixture-before-body-only-refresh",
        quotedText: "This is always the latest PR body.",
        startLine: 3,
        endLine: 3,
      },
      body: "PR本文の古い記述です。",
      authorLabel: "You",
    },
  });
  expect(prBodyCommentResponse.ok()).toBe(true);
  const prBodyCommentCard = page.locator(".comment-list-item").filter({
    hasText: "PR本文の古い記述です。",
  });
  await expect(prBodyCommentCard).toBeVisible();
  await page.getByRole("tab", { name: "Pull Request.md" }).click();
  await expect(
    diff.getByRole("code").getByText("This is always the latest PR body.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".comment-thread--inline").filter({ hasText: "PR本文の古い記述です。" }),
  ).toBeVisible();
  await expect(page.getByText("コメント作成時の選択範囲", { exact: true })).toHaveCount(0);

  await actionsMenuButton.click();
  actionsMenu = page.getByRole("menu");
  await expect(actionsMenu.getByRole("menuitem", { name: "GitHubと同期" })).toBeVisible();
  await expect(
    actionsMenu.getByRole("menuitem", { name: "ローカル状態を削除して再構築" }),
  ).toBeVisible();
  await actionsMenu.getByRole("menuitem", { name: "GitHubと同期" }).click();
  await expect(page.getByRole("status")).toContainText("GitHubと同期しました");
  await expect(page.getByRole("status")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByRole("heading", { name: "Fixture review updated" })).toBeVisible();
  await commitPicker.click();
  await expect(commitDialog.getByRole("option", { name: /Add fixture function/ })).toBeVisible();
  await expect(commitDialog.getByRole("option", { name: /Trim fixture input/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(diff.getByText("The PR body was rewritten.")).toBeVisible();
  await expect(diff.getByText("Final note.")).toBeVisible();
  await expect(diff.getByText("This is always the latest PR body.")).toHaveCount(0);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const pullRequestSoftBreak = page.locator(".markdown-preview p").filter({
    hasText: /The PR body was rewritten\.\s*Additional review details\./,
  });
  await expect(pullRequestSoftBreak).toHaveCount(1);
  await expect(pullRequestSoftBreak.locator("br")).toHaveCount(1);
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(
    page.locator(".comment-thread--inline").filter({ hasText: "PR本文の古い記述です。" }),
  ).toHaveCount(0);
  await expect(prBodyCommentCard.locator(".badge--outdated")).toBeVisible();
  await expect(
    prBodyCommentCard.getByText("コメント作成時の選択範囲", { exact: true }),
  ).toBeVisible();
  await expect(prBodyCommentCard.locator(".comment-source-quote pre")).toHaveText(
    "This is always the latest PR body.",
  );

  await selectCommitOnly(/Add fixture function/);
  await expect(commitPicker).toHaveAccessibleName(/Add fixture function/);
  await expect(diff.getByText("The PR body was rewritten.")).toBeVisible();
  await selectCommitOnly(/Trim fixture input/);
  await expect(commitPicker).toHaveAccessibleName(/Trim fixture input.*最新/);
  await page.getByRole("tab", { name: "src/fixture.ts" }).click();
  await expect(page.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".document-tabs").getByRole("tab")).toHaveCount(2);

  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).uncheck();
  await expect(page.getByRole("button", { name: "README.md", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "src/new.ts", exact: true })).toHaveCount(0);
  await selectCommitRangeByDrag(/Add fixture function/, /Trim fixture input/);
  await expect(commitPicker).toHaveAccessibleName(/2 commits.*PR全体/);
  await commitPicker.click();
  const selectedRangeOptions = commitDialog.getByRole("option", { selected: true });
  await expect(selectedRangeOptions).toHaveCount(2);
  await expect(commitDialog.getByRole("option", { name: /Add fixture function/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(commitDialog.getByRole("option", { name: /Trim fixture input/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "src/new.ts", exact: true })).toBeVisible();
  await reviewScope.getByRole("button", { name: "変更", exact: true }).click();
  await page.getByRole("tab", { name: "Pull Request.md" }).click();
  await expect(page.getByText("差分なし · 全文表示")).toBeVisible();
  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  await expect(reviewScope.getByRole("button", { name: "変更", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.locator(".comment-list-item").getByText("関数の契約を確認してください。", { exact: true }),
  ).toBeVisible();

  await expect(page.getByRole("button", { name: "コメント 3", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const sidebarLineThread = page.locator(".comment-list-item").filter({
    hasText: "関数の契約を確認してください。",
  });
  await expect(page.locator(".comment-sidebar-detail")).toHaveCount(0);
  await expect(sidebarLineThread.locator(".comment-thread-meta")).toContainText("最終更新");
  await expect(
    sidebarLineThread.getByRole("button", { name: /サイドバーから返信を送信$/ }),
  ).toBeVisible();
  await expect(
    sidebarLineThread.getByText("Diffから編集済みです。", { exact: true }),
  ).toBeVisible();
  await sidebarLineThread.getByPlaceholder("返信を入力").fill("サイドバーから追記しました。");
  await sidebarLineThread.getByPlaceholder("返信を入力").press("Meta+Enter");
  await expect(
    sidebarLineThread.getByText("サイドバーから追記しました。", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".comment-list-item").getByRole("checkbox")).toHaveCount(3);
  await page.getByRole("button", { name: "＋ PR全体" }).click();
  const prCommentComposer = page.getByPlaceholder("Pull Request全体へのコメント");
  await expect(prCommentComposer).toBeFocused();
  await prCommentComposer.fill("破棄するPR全体コメント");
  await prCommentComposer.press("Escape");
  await expect(prCommentComposer).toHaveCount(0);
  await page.getByRole("button", { name: "＋ PR全体" }).click();
  await expect(prCommentComposer).toBeFocused();
  await expect(prCommentComposer).toHaveValue("");
  await prCommentComposer.press("Escape");
  const selectAllBox = await page.getByLabel("すべて選択").boundingBox();
  const prCommentButtonBox = await page.getByRole("button", { name: "＋ PR全体" }).boundingBox();
  expect(selectAllBox).not.toBeNull();
  expect(prCommentButtonBox).not.toBeNull();
  expect(selectAllBox!.x).toBeLessThan(prCommentButtonBox!.x);
  const sidebarLineCheckbox = sidebarLineThread.getByRole("checkbox");
  const sidebarLineBox = await sidebarLineThread.boundingBox();
  const checkboxHitAreaBox = await sidebarLineThread
    .locator(".comment-select-toggle")
    .boundingBox();
  expect(sidebarLineBox).not.toBeNull();
  expect(checkboxHitAreaBox).not.toBeNull();
  expect(sidebarLineBox!.height).toBeGreaterThan(checkboxHitAreaBox!.height + 10);
  await page.mouse.click(
    checkboxHitAreaBox!.x + checkboxHitAreaBox!.width / 2,
    checkboxHitAreaBox!.y + checkboxHitAreaBox!.height + 8,
  );
  await expect(sidebarLineCheckbox).not.toBeChecked();
  await sidebarLineThread.locator(".comment-thread-header").click();
  await expect(sidebarLineCheckbox).toBeChecked();
  await expect(page.getByRole("button", { name: "選択した1件の参照をコピー" })).toBeVisible();
  await sidebarLineThread.locator(".comment-thread-header").click();
  await expect(sidebarLineCheckbox).not.toBeChecked();
  await page.getByLabel("すべて選択").check();
  await expect(page.getByRole("button", { name: "選択した3件の参照をコピー" })).toBeVisible();
  await page.getByLabel("すべて選択").uncheck();
  await expect(page.getByRole("button", { name: /選択した.*件の参照をコピー/ })).toHaveCount(0);

  await selectCommitOnly(/Add fixture function/);
  await expect(commitPicker).toHaveAccessibleName(/Add fixture function/);
  const commentNavigationCommitSelection = await commitPicker.getAttribute("aria-label");
  expect(commentNavigationCommitSelection).not.toBeNull();
  await expect(displayDiffButton).toHaveAttribute("aria-pressed", "true");
  await sidebarLineThread.getByRole("button", { name: "コメント対象を開く" }).click();
  await expect(page.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(commitPicker).toHaveAttribute("aria-label", commentNavigationCommitSelection!);
  await expect(displayDiffButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/参照元 c{8} ≠ 対象 b{8} · 全文表示/, { exact: true })).toBeVisible();
  await expect(diff.getByText("return value.trim();", { exact: true })).toBeVisible();
  await expect(diff.getByText("return value;", { exact: true })).toHaveCount(0);
  await expect(page.locator(".document-tabs").getByRole("tab")).toHaveCount(2);
  await sidebarLineThread.getByRole("button", { name: "コメントのその他の操作" }).click();
  await sidebarLineThread.getByRole("menuitem", { name: "参照をコピー" }).click();
  await expect
    .poll(async () => await page.evaluate(() => navigator.clipboard.readText()))
    .toContain("rvw://comment/");
  await sidebarLineThread.getByRole("button", { name: "解決", exact: true }).click();
  await expect(sidebarLineThread).toHaveCount(0);
  await page.getByRole("button", { name: "解決済み 1", exact: true }).click();
  const resolvedLineThread = page.locator(".comment-list-item").filter({
    hasText: "関数の契約を確認してください。",
  });
  await expect(resolvedLineThread.getByText("解決済み", { exact: true })).toBeVisible();
  await expect(
    resolvedLineThread.getByText("Diffから編集済みです。", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "未解決 2", exact: true }).click();
  const deletableFileThread = page.locator(".comment-list-item").filter({
    hasText: "ファイル全体のコメントです。",
  });
  await deletableFileThread
    .getByPlaceholder("返信を入力")
    .fill("スレッドと同時に削除する返信です。");
  await deletableFileThread.getByPlaceholder("返信を入力").press("Meta+Enter");
  await expect(
    deletableFileThread.getByText("スレッドと同時に削除する返信です。", { exact: true }),
  ).toBeVisible();
  await deletableFileThread.getByRole("button", { name: "コメントのその他の操作" }).click();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("返信1件もすべて削除されます。");
    void dialog.accept();
  });
  await deletableFileThread.getByRole("menuitem", { name: "削除", exact: true }).click();
  await expect(deletableFileThread).toHaveCount(0);
  await expect(page.getByRole("button", { name: "コメント 1", exact: true })).toBeVisible();
});

test("keeps a comment on the current PR body placed with its saved hash and quote", async ({
  request,
}) => {
  const createResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "document",
        documentKind: "pull-request-markdown",
        startLine: 3,
        endLine: 4,
      },
      body: "Current PR body comment",
      authorLabel: "You",
    },
  });
  expect(createResponse.ok()).toBe(true);
  const created = (await createResponse.json()) as {
    comment: {
      id: string;
      target: { sourceDocumentHash: string; quotedText: string };
    };
  };
  expect(created.comment.target.sourceDocumentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(created.comment.target.quotedText).toBe(
    "The PR body was rewritten.\nAdditional review details.",
  );

  const placementResponse = await request.get(
    `/api/comments/${created.comment.id}/placement?kind=commit&pullRequestId=${pullRequestId}&oid=${"c".repeat(40)}`,
  );
  expect(placementResponse.ok()).toBe(true);
  await expect(placementResponse.json()).resolves.toMatchObject({
    placement: {
      outdated: false,
      range: { startLine: 3, endLine: 4 },
      path: "Pull Request.md",
    },
  });

  const deleteResponse = await request.delete(`/api/comments/${created.comment.id}`, { data: {} });
  expect(deleteResponse.ok()).toBe(true);
});

test("keeps PR body preview comments interactive and stacks collapsed source menus without layout shifts", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1000, height: 420 });
  for (let index = 0; index < 2; index += 1) {
    const refreshResponse = await request.post(`/api/pull-requests/${pullRequestId}/refresh`, {
      data: {},
    });
    expect(refreshResponse.ok()).toBe(true);
  }
  const createUpperResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "document",
        documentKind: "pull-request-markdown",
        startLine: 3,
        endLine: 3,
      },
      body: "Upper menu layout regression",
      authorLabel: "You",
    },
  });
  expect(createUpperResponse.ok()).toBe(true);
  const upper = (await createUpperResponse.json()) as { comment: { id: string } };
  const createLowerResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "document",
        documentKind: "pull-request-markdown",
        startLine: 6,
        endLine: 6,
      },
      body: "Preview interaction regression",
      authorLabel: "You",
    },
  });
  expect(createLowerResponse.ok()).toBe(true);
  const lower = (await createLowerResponse.json()) as { comment: { id: string } };

  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const previewThread = page.locator(
      `.markdown-inline-comments .comment-thread[data-comment-id="${lower.comment.id}"]`,
    );
    await expect(previewThread).toBeVisible();

    const reply = previewThread.getByRole("textbox", { name: "Pull Request.md · L6へ返信" });
    const replyElement = await reply.elementHandle();
    expect(replyElement).not.toBeNull();
    await reply.hover();
    expect(await replyElement.evaluate((element) => element.isConnected)).toBe(true);
    await reply.click();
    await reply.pressSequentially("Previewから返信できます");
    await expect(reply).toHaveValue("Previewから返信できます");
    const externalReplyResponse = await request.post(`/api/comments/${upper.comment.id}/posts`, {
      data: {
        body: "別コメントへのAgent返信",
        authorLabel: "Agent",
        relatedCommitOid: null,
      },
    });
    expect(externalReplyResponse.ok()).toBe(true);
    const upperPreviewThread = page.locator(
      `.markdown-inline-comments .comment-thread[data-comment-id="${upper.comment.id}"]`,
    );
    await expect(
      upperPreviewThread.getByText("別コメントへのAgent返信", { exact: true }),
    ).toBeVisible();
    await expect(reply).toHaveValue("Previewから返信できます");
    await expect(reply).toBeFocused();
    await reply.fill("");

    await page.getByRole("button", { name: "Source", exact: true }).click();
    const upperSourceThread = page.locator(
      `diffs-container .comment-thread--inline[data-comment-id="${upper.comment.id}"]`,
    );
    const lowerSourceThread = page.locator(
      `diffs-container .comment-thread--inline[data-comment-id="${lower.comment.id}"]`,
    );
    await expect(upperSourceThread).toBeVisible();
    await expect(lowerSourceThread).toBeVisible();
    await upperSourceThread
      .getByRole("button", { name: "Pull Request.md · L3のコメントを折りたたむ" })
      .click();
    await lowerSourceThread
      .getByRole("button", { name: "Pull Request.md · L6のコメントを折りたたむ" })
      .click();
    const lowerTopBeforeMenu = await lowerSourceThread.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    const menuLayering = async (
      menuCommentId: string,
      otherCommentId: string,
    ): Promise<{ overlaps: boolean; menuIsOnTop: boolean } | null> =>
      await page.evaluate(
        ({ menuCommentId, otherCommentId }) => {
          const menuThread = document.querySelector<HTMLElement>(
            `diffs-container .comment-thread--inline[data-comment-id="${menuCommentId}"]`,
          );
          const otherThread = document.querySelector<HTMLElement>(
            `diffs-container .comment-thread--inline[data-comment-id="${otherCommentId}"]`,
          );
          const menu = menuThread?.querySelector<HTMLElement>(".comment-more-menu");
          if (!menu || !otherThread) return null;
          const menuRect = menu.getBoundingClientRect();
          const otherRect = otherThread.getBoundingClientRect();
          const left = Math.max(menuRect.left, otherRect.left);
          const right = Math.min(menuRect.right, otherRect.right);
          const top = Math.max(menuRect.top, otherRect.top);
          const bottom = Math.min(menuRect.bottom, otherRect.bottom);
          const overlaps = left < right && top < bottom;
          if (!overlaps) return { overlaps, menuIsOnTop: false };
          const topElement = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
          return { overlaps, menuIsOnTop: Boolean(topElement && menu.contains(topElement)) };
        },
        { menuCommentId, otherCommentId },
      );
    const upperMenuButton = upperSourceThread.getByRole("button", {
      name: "コメントのその他の操作",
    });
    await upperMenuButton.click();
    const upperMenu = upperSourceThread.getByRole("menu", {
      name: "コメントのその他の操作",
    });
    await expect(upperMenu).toBeVisible();
    await expect(upperMenu.getByRole("menuitem", { name: "参照をコピー" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(upperMenu.getByRole("menuitem", { name: "編集" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(upperMenu.getByRole("menuitem", { name: "参照をコピー" })).toBeFocused();
    const lowerTopWithMenu = await lowerSourceThread.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    expect(lowerTopWithMenu).toBeCloseTo(lowerTopBeforeMenu, 3);
    await expect(menuLayering(upper.comment.id, lower.comment.id)).resolves.toEqual({
      overlaps: true,
      menuIsOnTop: true,
    });

    await page.keyboard.press("Escape");
    await expect(upperMenu).toBeHidden();
    await expect(upperMenuButton).toBeFocused();
    await lowerSourceThread.getByRole("button", { name: "コメントのその他の操作" }).click();
    const lowerMenu = lowerSourceThread.getByRole("menu", {
      name: "コメントのその他の操作",
    });
    await expect(lowerMenu).toBeVisible();
    await expect(lowerMenu).toHaveClass(/opens-upward/);
    await expect(menuLayering(lower.comment.id, upper.comment.id)).resolves.toEqual({
      overlaps: true,
      menuIsOnTop: true,
    });

    const bounds = await page.evaluate((commentId) => {
      const thread = document.querySelector<HTMLElement>(
        `diffs-container .comment-thread--inline[data-comment-id="${commentId}"]`,
      );
      const menu = thread?.querySelector<HTMLElement>(".comment-more-menu");
      const file = thread?.closest<HTMLElement>("diffs-container");
      if (!menu || !file) return null;
      const menuRect = menu.getBoundingClientRect();
      const fileRect = file.getBoundingClientRect();
      return { menuTop: menuRect.top, menuBottom: menuRect.bottom, fileBottom: fileRect.bottom };
    }, lower.comment.id);
    expect(bounds).not.toBeNull();
    expect(bounds!.menuTop).toBeGreaterThan(0);
    expect(bounds!.menuBottom).toBeLessThanOrEqual(bounds!.fileBottom);
  } finally {
    for (const commentId of [upper.comment.id, lower.comment.id]) {
      const deleteResponse = await request.delete(`/api/comments/${commentId}`, { data: {} });
      expect(deleteResponse.ok()).toBe(true);
    }
  }
});

test("restores the shared theme after browser storage is cleared", async ({ page, request }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await expect(
    page.locator(".topbar").getByRole("heading", { name: /Fixture review/ }),
  ).toBeVisible();

  const actionsMenuButton = page.getByRole("button", { name: "その他の操作", exact: true });
  await actionsMenuButton.click();
  await page.getByRole("menu").getByRole("menuitemradio", { name: "ダークモード" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect
    .poll(async () => {
      const response = await request.get("/api/preferences/theme");
      const body = (await response.json()) as { themePreference: string };
      return body.themePreference;
    })
    .toBe("dark");

  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.locator(".topbar").getByRole("heading", { name: /Fixture review/ }),
  ).toBeVisible();

  await actionsMenuButton.click();
  await page.getByRole("menu").getByRole("menuitemradio", { name: "システム" }).click();
  await expect
    .poll(async () => {
      const response = await request.get("/api/preferences/theme");
      const body = (await response.json()) as { themePreference: string };
      return body.themePreference;
    })
    .toBe("system");
});

test("selects and copies code text with native browser selection", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  const reviewScope = page.getByRole("region", { name: "レビュー範囲", exact: true });
  await reviewScope.getByRole("button", { name: "全文", exact: true }).click();

  const diff = page.locator("diffs-container");
  const fixtureIdentifier = diff
    .locator('[data-line="1"] span')
    .filter({ hasText: /^ fixture$/ })
    .first();
  await expect(fixtureIdentifier).toBeVisible();
  await page.waitForTimeout(1_100);
  await fixtureIdentifier.dblclick();

  await expect
    .poll(async () =>
      diff.evaluate((element) => element.ownerDocument.getSelection()?.toString() ?? ""),
    )
    .toBe("fixture");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("fixture");
  await expect(page.locator(".inline-comment-composer--line")).toHaveCount(0);

  await page.waitForTimeout(1_100);
  await expect
    .poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? ""))
    .toBe("fixture");

  await reviewScope.getByRole("button", { name: "変更", exact: true }).click();
  const valueIdentifier = diff
    .locator('[data-line="1"] span')
    .filter({ hasText: /^value$/ })
    .first();
  await expect(valueIdentifier).toBeVisible();
  await page.waitForTimeout(1_100);
  await valueIdentifier.dblclick();
  await expect
    .poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? ""))
    .toBe("value");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
  await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe("value");

  await page.waitForTimeout(1_100);
  await expect
    .poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? ""))
    .toBe("value");
});

test("searches while typing, groups occurrences, and reveals a result without changing display mode", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const searchAction = page.getByRole("button", { name: "コード検索を開く", exact: true });
  await expect(searchAction).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("tab", { name: "検索", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  const reviewScope = page.getByRole("region", { name: "レビュー範囲", exact: true });
  const displayDiffButton = reviewScope.getByRole("button", { name: "変更", exact: true });
  await expect(displayDiffButton).toHaveAttribute("aria-pressed", "true");
  const diff = page.locator("diffs-container");
  await expect(
    diff.locator('[slot="header-prefix"] [data-file-icon="lang-typescript-duo"]'),
  ).toBeVisible();
  await expect(diff.locator('[data-line="13"]')).toHaveCount(0);

  const walkthroughFolder = page.getByRole("button", { name: "ウォークスルー 6", exact: true });
  await walkthroughFolder.click();
  const srcFolder = page.getByRole("button", { name: "src フォルダ", exact: true });
  await srcFolder.click();
  await expect(srcFolder).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press("Control+Shift+F");
  await expect(page.getByRole("button", { name: "ファイルツリーに戻る" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "コード検索", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const searchInput = page.getByRole("textbox", { name: "全文検索" });
  await expect(searchInput).toBeFocused();
  await searchInput.fill("fixture");

  await expect(page.getByText(/\d+件・\d+ファイル/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Pull Request.md、1件" })).toBeVisible();
  await expect(page.getByRole("button", { name: "README.md、1件" })).toBeVisible();
  await expect(page.getByRole("button", { name: "src/fixture.ts、3件" })).toBeVisible();
  const fixtureSearchGroup = page.getByRole("button", { name: "src/fixture.ts、3件" });
  await expect(fixtureSearchGroup.locator("strong")).toHaveText("fixture.ts");
  await expect(fixtureSearchGroup.locator(".search-result-directory")).toHaveText("src");
  await expect(fixtureSearchGroup.locator('[data-file-icon="lang-typescript-duo"]')).toBeVisible();
  await expect(
    page
      .getByRole("button", { name: "src/fixture.ts、3件" })
      .locator('[data-change-kind="modified"]'),
  ).toBeVisible();
  await expect(page.locator(".search-result-line mark")).toHaveCount(5);

  await fixtureSearchGroup.click();
  await expect(fixtureSearchGroup).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "ファイルツリーに戻る", exact: true }).click();
  await expect(walkthroughFolder).toHaveAttribute("aria-expanded", "true");
  await expect(srcFolder).toHaveAttribute("aria-expanded", "false");
  await searchAction.click();
  await expect(fixtureSearchGroup).toHaveAttribute("aria-expanded", "false");
  await fixtureSearchGroup.click();

  await searchInput.fill("added");
  await expect(page.getByText("1件・1ファイル", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "src/new.ts、1件" }).locator('[data-change-kind="added"]'),
  ).toBeVisible();

  await searchInput.fill("fixture");
  await expect(page.getByText("5件・3ファイル", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "検索結果をすべて折りたたむ" }).click();
  await expect(page.getByRole("button", { name: "src/fixture.ts 13行" })).toHaveCount(0);
  await page.getByRole("button", { name: "検索結果をすべて展開" }).click();

  const matchCaseButton = page.getByRole("button", { name: "大文字小文字を区別" });
  await matchCaseButton.click();
  await expect(matchCaseButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("3件・1ファイル", { exact: true })).toBeVisible();

  const wholeWordButton = page.getByRole("button", { name: "単語単位で検索" });
  await wholeWordButton.click();
  await expect(wholeWordButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("2件・1ファイル", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "src/fixture.ts 13行" }).click();
  await expect(displayDiffButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page
      .getByRole("tab", { name: "src/fixture.ts" })
      .locator('[data-file-icon="lang-typescript-duo"]'),
  ).toBeVisible();
  await expect(diff).toHaveAttribute("data-search-target-line", "13");
  await expect(diff.locator('[data-line="13"][data-editor-active-line]')).toBeVisible();
});

test("keeps every sidebar section heading visible in a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 320 });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await expect(page.getByRole("heading", { name: "Fixture review" })).toBeVisible();

  const stackToggles = page.locator(".sidebar-stack-toggle");
  await expect(stackToggles).toHaveCount(2);
  for (const label of [/^エクスプローラー$/, /^コメント \d+$/]) {
    await expect(page.getByRole("button", { name: label })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Pull Request.md", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^ウォークスルー \d+$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "エクスプローラー", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  const layout = await page.locator(".sidebar").evaluate((sidebar) => {
    const sidebarBounds = sidebar.getBoundingClientRect();
    const toggles = [...sidebar.querySelectorAll<HTMLElement>(".sidebar-stack-toggle")];
    const bodies = [...sidebar.querySelectorAll<HTMLElement>(".sidebar-stack-body:not([hidden])")];
    return {
      sidebarBottom: sidebarBounds.bottom,
      latestToggleBottom: toggles.at(-1)?.getBoundingClientRect().bottom ?? 0,
      bodyOverflow: bodies.map((body) => getComputedStyle(body).overflowY),
    };
  });
  expect(layout.latestToggleBottom).toBeLessThanOrEqual(layout.sidebarBottom + 1);
  expect(layout.bodyOverflow.length).toBeGreaterThanOrEqual(1);
  expect(layout.bodyOverflow.every((overflow) => overflow === "auto")).toBe(true);
});

test("resizes the expanded comments stack from its top edge", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await expect(page.getByRole("heading", { name: "Fixture review", exact: true })).toBeVisible();

  const commentsToggle = page.locator(".sidebar-stack--comments > .sidebar-stack-toggle");
  await commentsToggle.click();
  await expect(commentsToggle).toHaveAttribute("aria-expanded", "true");

  const codeStack = page.locator(".sidebar-stack--code");
  const commentsStack = page.locator(".sidebar-stack--comments");
  const resizeHandle = page.getByRole("separator", { name: "コメント欄の高さを変更" });
  await expect(resizeHandle).toBeVisible();
  await expect(resizeHandle).toHaveAttribute("aria-valuetext", "自動");

  await resizeHandle.click();
  await expect(resizeHandle).toHaveAttribute("aria-valuetext", "自動");

  const codeBefore = await codeStack.boundingBox();
  const commentsBefore = await commentsStack.boundingBox();
  const handleBox = await resizeHandle.boundingBox();
  expect(codeBefore).not.toBeNull();
  expect(commentsBefore).not.toBeNull();
  expect(handleBox).not.toBeNull();

  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y - 96, { steps: 5 });
  await page.mouse.up();

  const codeAfter = await codeStack.boundingBox();
  const commentsAfter = await commentsStack.boundingBox();
  expect(codeAfter).not.toBeNull();
  expect(commentsAfter).not.toBeNull();
  expect(commentsAfter!.height).toBeGreaterThan(commentsBefore!.height + 70);
  expect(codeAfter!.height).toBeLessThan(codeBefore!.height - 70);
  await expect(resizeHandle).not.toHaveAttribute("aria-valuetext", "自動");

  await resizeHandle.dblclick();
  const commentsReset = await commentsStack.boundingBox();
  expect(commentsReset).not.toBeNull();
  expect(Math.abs(commentsReset!.height - commentsBefore!.height)).toBeLessThan(3);
  await expect(resizeHandle).toHaveAttribute("aria-valuetext", "自動");

  await resizeHandle.focus();
  await resizeHandle.press("ArrowUp");
  const commentsAfterKeyboardResize = await commentsStack.boundingBox();
  expect(commentsAfterKeyboardResize).not.toBeNull();
  expect(commentsAfterKeyboardResize!.height).toBeGreaterThan(commentsReset!.height + 10);
  await expect(resizeHandle).not.toHaveAttribute("aria-valuetext", "自動");

  await page.setViewportSize({ width: 1280, height: 320 });
  await expect
    .poll(async () => {
      const sidebarBox = await page.locator(".sidebar").boundingBox();
      const commentsBox = await commentsStack.boundingBox();
      return Boolean(
        sidebarBox &&
        commentsBox &&
        commentsBox.y + commentsBox.height <= sidebarBox.y + sidebarBox.height + 1,
      );
    })
    .toBe(true);

  await resizeHandle.press("Escape");
  await expect(resizeHandle).toHaveAttribute("aria-valuetext", "自動");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect
    .poll(async () =>
      Math.abs(((await commentsStack.boundingBox())?.height ?? 0) - commentsBefore!.height),
    )
    .toBeLessThan(3);
});

test("keeps virtual review nodes compact and useful height for code navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await expect(page.getByRole("button", { name: "ウォークスルー 6" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Structure 3" })).toBeVisible();

  const stackHeights = await page.locator(".sidebar-stack").evaluateAll((stacks) =>
    stacks.map((stack) => ({
      kind: [...stack.classList].find((name) => name.startsWith("sidebar-stack--")) ?? "",
      height: Math.round(stack.getBoundingClientRect().height),
    })),
  );

  const heightByKind = new Map(stackHeights.map((stack) => [stack.kind, stack.height]));
  expect(heightByKind.get("sidebar-stack--code")).toBeGreaterThanOrEqual(260);
  const reviewNodeHeights = await page
    .locator(".review-tree-items > .review-tree-item")
    .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
  expect(reviewNodeHeights).toEqual([31, 31, 31]);
});

test("opens a fuzzy-matched file from Cmd/Ctrl+P in the left pane", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await expect(page.getByRole("button", { name: "src/new.ts", exact: true })).toBeVisible();

  await page.keyboard.press("Control+P");
  const palette = page.getByRole("dialog", { name: "ファイルを開く" });
  const input = palette.getByRole("combobox", { name: "ファイル名で検索" });
  await expect(input).toBeFocused();
  await input.fill("fxtr");
  await expect(palette.getByRole("option", { name: "src/fixture.ts" })).toBeVisible();
  await expect(input).toBeFocused();
  await input.press("Enter");
  await expect(page.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page
    .getByRole("button", { name: "src/new.ts", exact: true })
    .click({ modifiers: ["Control"] });
  const rightPane = page.getByRole("region", { name: "右のコードペイン" });
  await expect(rightPane.getByRole("tab", { name: "src/new.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.keyboard.press("Control+P");
  await input.fill("rdm");
  await input.press("Enter");
  const leftPane = page.getByRole("region", { name: "左のコードペイン" });
  await expect(leftPane.getByRole("tab", { name: "README.md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(leftPane.getByRole("tab", { name: "src/fixture.ts" })).toBeVisible();
  await expect(rightPane.getByRole("tab", { name: "src/new.ts" })).toBeVisible();

  await page.keyboard.press("Control+P");
  await input.fill("rdm");
  await palette.getByRole("option", { name: "README.md" }).click({ modifiers: ["Control"] });
  await expect(leftPane.getByRole("tab", { name: "README.md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(rightPane.getByRole("tab", { name: "README.md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("registers the browser document and releases it when the tab closes", async ({
  page,
  request,
}) => {
  const before = (await (await request.get("/api/test/viewers")).json()) as {
    activeViewers: string[];
  };
  const existingViewers = new Set(before.activeViewers);
  let viewerId = "";

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await expect
    .poll(async () => {
      const response = (await (await request.get("/api/test/viewers")).json()) as {
        activeViewers: string[];
      };
      viewerId = response.activeViewers.find((id) => !existingViewers.has(id)) ?? "";
      return viewerId;
    })
    .toMatch(/^[0-9a-f-]{36}$/i);

  await page.close();
  await expect
    .poll(async () => {
      const response = (await (await request.get("/api/test/viewers")).json()) as {
        activeViewers: string[];
        releasedViewers: string[];
      };
      return {
        active: response.activeViewers.includes(viewerId),
        released: response.releasedViewers.includes(viewerId),
      };
    })
    .toEqual({ active: false, released: true });
});

test("closes other or all tabs within the selected pane", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await page.getByRole("button", { name: "ファイルツリーをすべて展開" }).click();

  const fileTree = page.locator(".file-tree");
  await fileTree.getByRole("button", { name: "README.md", exact: true }).click();
  await fileTree.getByRole("button", { name: "src/fixture.ts", exact: true }).click();

  const leftPane = page.locator('.document-pane[data-pane="left"]');
  const rightPane = page.locator('.document-pane[data-pane="right"]');
  await expect(leftPane.getByRole("tab")).toHaveCount(3);
  await leftPane.getByRole("button", { name: "左ペインの操作" }).click();
  await leftPane.getByRole("menuitem", { name: "他のタブをすべて閉じる" }).click();
  await expect(leftPane.getByRole("tab")).toHaveCount(1);
  await expect(leftPane.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await fileTree.getByRole("button", { name: "README.md", exact: true }).click();
  await fileTree
    .getByRole("button", { name: "src/new.ts", exact: true })
    .click({ modifiers: ["Meta"] });
  await expect(rightPane.getByRole("tab", { name: "src/new.ts" })).toBeVisible();

  await leftPane.getByRole("button", { name: "左ペインの操作" }).click();
  await leftPane.getByRole("menuitem", { name: "このペインのタブをすべて閉じる" }).click();
  await expect(leftPane.getByRole("tab", { name: "src/new.ts" })).toBeVisible();
  await expect(rightPane).toHaveCount(0);

  await leftPane.getByRole("button", { name: "左ペインの操作" }).click();
  await leftPane.getByRole("menuitem", { name: "このペインのタブをすべて閉じる" }).click();
  await expect(leftPane.getByRole("tab")).toHaveCount(0);
  await expect(leftPane.getByText("左ペイン", { exact: true })).toBeVisible();
});

test("keeps a large all-files tree responsive while documents open and close", async ({ page }) => {
  test.slow();
  const entries = Array.from({ length: 5_000 }, (_, index) => {
    const packageName = `package-${String(index).padStart(4, "0")}`;
    return {
      mode: "100644",
      type: "blob",
      oid: index.toString(16).padStart(40, "0"),
      size: 32,
      path: `packages/${packageName}/src/index.ts`,
      kind: "file",
    };
  });
  await page.route("**/api/pull-requests/*/tree?*", async (route) => {
    await route.fulfill({
      json: { ok: true, virtual: "Pull Request.md", entries },
    });
  });

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await page.getByRole("button", { name: "ファイルツリーをすべて展開" }).click();

  const virtualTree = page.locator(".file-tree-virtualized");
  await expect(virtualTree).toHaveAttribute("data-virtualized", "true");
  await expect
    .poll(async () => Number(await virtualTree.getAttribute("data-file-tree-row-count")))
    .toBeGreaterThan(15_000);
  expect(await virtualTree.locator(".file-tree-row").count()).toBeLessThan(100);

  const quickOpenStartedAt = Date.now();
  await page.keyboard.press("Control+P");
  const palette = page.getByRole("dialog", { name: "ファイルを開く" });
  const input = palette.getByRole("combobox", { name: "ファイル名で検索" });
  await expect(input).toBeFocused({ timeout: 3_000 });
  expect(Date.now() - quickOpenStartedAt).toBeLessThan(3_000);
  await input.press("Escape");

  const firstFile = page.getByRole("button", {
    name: "packages/package-0000/src/index.ts",
    exact: true,
  });
  const renderDelayMs = await firstFile.evaluate(async (element) => {
    const startedAt = performance.now();
    (element as HTMLElement).click();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return performance.now() - startedAt;
  });
  expect(renderDelayMs).toBeLessThan(2_000);
  await expect(
    page.getByRole("tab", { name: "packages/package-0000/src/index.ts" }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "packages/package-0000/src/index.tsを閉じる" }).click();
  expect(await virtualTree.locator(".file-tree-row").count()).toBeLessThan(100);
});
