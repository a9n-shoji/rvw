import { expect, test, type Page } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const mermaidMarkdown = (title: string, diagram: string): string =>
  [`# ${title}`, "", "```mermaid", "flowchart LR", `  ${diagram}`, "```", ""].join("\n");

async function openCommentsSidebar(page: Page): Promise<void> {
  const toggle = page.locator(".sidebar-stack--comments > .sidebar-stack-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

test("renders Mermaid diagrams and navigates from a comment reference to an internal source line", async ({
  page,
  request,
}) => {
  const viewResponse = await request.get(`/api/pull-requests/${pullRequestId}`);
  expect(viewResponse.ok()).toBe(true);
  const { headOid } = (await viewResponse.json()) as { headOid: string };
  const createResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: { kind: "pull-request" },
      body: "Inspect [the Mermaid source line](rvw-ref:mermaid-source-line).",
      relatedCommitOid: headOid,
      references: [
        {
          id: "mermaid-source-line",
          label: "Mermaid source line",
          path: "README.md",
          startLine: 5,
          endLine: 5,
        },
      ],
      authorLabel: "Codex · Mermaid preview",
    },
  });
  expect(createResponse.ok()).toBe(true);
  const { comment } = (await createResponse.json()) as { comment: { id: string } };

  await page.route(`**/api/pull-requests/${pullRequestId}/document?*`, async (route) => {
    const url = new URL(route.request().url());
    const kind = url.searchParams.get("kind");
    const path = url.searchParams.get("path");
    if (kind === "pull-request-markdown") {
      const text = mermaidMarkdown("Pull request diagram", "Review --> Merge");
      await route.fulfill({
        json: {
          ok: true,
          document: {
            ref: { kind, pullRequestId },
            availability: "available",
            text,
            byteLength: Buffer.byteLength(text),
            entryKind: "virtual",
            normalizedLineEndings: false,
            oid: null,
          },
        },
      });
      return;
    }
    if (kind === "repository-file" && path === "README.md") {
      const sourceOid = url.searchParams.get("sourceOid") ?? "c".repeat(40);
      const text = mermaidMarkdown("Repository diagram", "Request --> Persist");
      await route.fulfill({
        json: {
          ok: true,
          document: {
            ref: { kind, pullRequestId, sourceOid, path },
            availability: "available",
            text,
            byteLength: Buffer.byteLength(text),
            entryKind: "file",
            normalizedLineEndings: false,
            oid: "f".repeat(40),
          },
        },
      });
      return;
    }
    await route.continue();
  });

  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    const preview = page.locator(".markdown-preview");
    const pullRequestDiagram = preview.locator(".markdown-mermaid-shell");
    await expect(
      pullRequestDiagram.getByRole("img", { name: "Mermaid diagram" }).locator("svg"),
    ).toBeVisible();
    await expect(pullRequestDiagram).toHaveAttribute("data-rvw-source-start-line", "3");
    await expect(preview.locator("pre code.language-mermaid")).toHaveCount(0);

    await page.evaluate(() => {
      const originalScrollIntoView = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollIntoView",
      )?.value as Element["scrollIntoView"] | undefined;
      if (!originalScrollIntoView) throw new Error("Expected scrollIntoView to be available.");
      Element.prototype.scrollIntoView = function (...args) {
        if (this instanceof HTMLElement && this.classList.contains("markdown-mermaid-shell")) {
          document.documentElement.dataset.rvwTestMermaidNavigationTarget = `${this.dataset.rvwSourceStartLine}:${this.dataset.rvwSourceEndLine}`;
        }
        return Reflect.apply(originalScrollIntoView, this, args);
      };
    });
    await openCommentsSidebar(page);
    const thread = page.locator(".comment-list-item").filter({
      hasText: "the Mermaid source line",
    });
    await thread.getByRole("button", { name: "the Mermaid source line" }).click();

    await expect(page.getByRole("heading", { name: "Repository diagram" })).toBeVisible();
    const repositoryDiagram = preview.locator(".markdown-mermaid-shell");
    await expect(
      repositoryDiagram.getByRole("img", { name: "Mermaid diagram" }).locator("svg"),
    ).toBeVisible();
    await expect(repositoryDiagram).toHaveAttribute("data-rvw-source-end-line", "6");
    await expect(preview.locator('[data-rvw-source-start-line="5"]')).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute(
      "data-rvw-test-mermaid-navigation-target",
      "3:6",
    );
    await expect(repositoryDiagram).toHaveClass(/is-source-highlighted/);
    await expect(preview.locator("pre code.language-mermaid")).toHaveCount(0);
  } finally {
    const deleteResponse = await request.delete(`/api/comments/${comment.id}`, { data: {} });
    expect(deleteResponse.ok()).toBe(true);
  }
});

test("reviews a Mermaid block in the expanded workspace without losing diagram context", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const viewResponse = await request.get(`/api/pull-requests/${pullRequestId}`);
  expect(viewResponse.ok()).toBe(true);
  const { headOid } = (await viewResponse.json()) as { headOid: string };
  const existingResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: headOid,
        path: "README.md",
        startLine: 3,
        endLine: 7,
      },
      body: [
        "Existing diagram review with [fixture implementation](rvw-ref:fixture-source) and [single-line target](rvw-ref:single-line).",
        "Repository link: [fixture repository file](src/fixture.ts).",
        "",
        "```mermaid",
        "flowchart LR",
        "  Comment --> Reply",
        "```",
      ].join("\n"),
      relatedCommitOid: headOid,
      references: [
        {
          id: "fixture-source",
          label: "Fixture implementation",
          path: "src/fixture.ts",
          startLine: 1,
          endLine: 2,
        },
        {
          id: "single-line",
          label: "Single-line target",
          path: "src/single-line.ts",
          startLine: 42,
          endLine: null,
        },
      ],
      authorLabel: "Codex · Expanded Mermaid",
    },
  });
  expect(existingResponse.ok()).toBe(true);
  const existing = (await existingResponse.json()) as { comment: { id: string } };
  let createdCommentId: string | null = null;

  const expandedMarkdown = mermaidMarkdown(
    "Expanded review diagram",
    [
      "Request --> Parse --> Validate --> Authorize --> Persist --> Publish",
      "Publish --> Notify --> Audit --> Archive --> Report --> Complete",
    ].join("\n  "),
  );
  await page.route(`**/api/pull-requests/${pullRequestId}/document?*`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("kind") !== "repository-file") {
      await route.continue();
      return;
    }
    const path = url.searchParams.get("path");
    if (path === "src/single-line.ts") {
      const text = Array.from({ length: 50 }, (_, index) =>
        index === 41 ? "const referencedLine = 42;" : `// context ${index + 1}`,
      ).join("\n");
      const sourceOid = url.searchParams.get("sourceOid") ?? headOid;
      await route.fulfill({
        json: {
          ok: true,
          document: {
            ref: { kind: "repository-file", pullRequestId, sourceOid, path },
            availability: "available",
            text,
            byteLength: Buffer.byteLength(text),
            entryKind: "file",
            normalizedLineEndings: false,
            oid: "f".repeat(40),
          },
        },
      });
      return;
    }
    if (path !== "README.md") {
      await route.continue();
      return;
    }
    const sourceOid = url.searchParams.get("sourceOid") ?? headOid;
    await route.fulfill({
      json: {
        ok: true,
        document: {
          ref: { kind: "repository-file", pullRequestId, sourceOid, path },
          availability: "available",
          text: expandedMarkdown,
          byteLength: Buffer.byteLength(expandedMarkdown),
          entryKind: "file",
          normalizedLineEndings: false,
          oid: "e".repeat(40),
        },
      },
    });
  });
  await page.route(`**/api/comments/${existing.comment.id}/placement?*`, async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        placement: { outdated: false, range: { startLine: 3, endLine: 7 }, path: "README.md" },
      },
    });
  });

  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
    await page
      .locator(".file-tree")
      .getByRole("button", { name: "README.md", exact: true })
      .click();
    const preview = page.locator(".markdown-preview");
    const inlineDiagram = preview.locator(".markdown-mermaid-shell");
    await expect(inlineDiagram.locator("svg")).toBeVisible();
    await expect(
      inlineDiagram.getByRole("button", { name: "Mermaid diagramを拡大" }),
    ).toBeVisible();

    await inlineDiagram.getByRole("button", { name: "Mermaid diagramを拡大" }).click();
    let dialog = page.getByRole("dialog", { name: "Mermaid diagram" });
    await expect(dialog).toBeVisible();
    const expandedSvg = dialog
      .getByRole("img", { name: "Expanded Mermaid diagram" })
      .locator("svg");
    await expect(expandedSvg).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Fit" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const commentsToggle = dialog.getByRole("button", { name: /Comments/ });
    await expect(commentsToggle).toHaveAttribute("aria-pressed", "false");
    await expect(dialog.getByRole("complementary", { name: "Diagram review" })).toHaveCount(0);
    await commentsToggle.click();
    await expect(dialog.getByText("Existing diagram review", { exact: false })).toBeVisible();

    const reviewRail = dialog.getByRole("complementary", { name: "Diagram review" });
    const railResizeHandle = dialog.getByRole("separator", {
      name: "Comments railの幅を変更",
    });
    const railWidthBeforeDrag = await reviewRail.evaluate(
      (rail) => rail.getBoundingClientRect().width,
    );
    const resizeHandleBounds = await railResizeHandle.boundingBox();
    expect(resizeHandleBounds).not.toBeNull();
    await page.mouse.move(
      resizeHandleBounds!.x + resizeHandleBounds!.width / 2,
      resizeHandleBounds!.y + resizeHandleBounds!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      resizeHandleBounds!.x - 80,
      resizeHandleBounds!.y + resizeHandleBounds!.height / 2,
      { steps: 4 },
    );
    await page.mouse.up();
    await expect
      .poll(async () => reviewRail.evaluate((rail) => rail.getBoundingClientRect().width))
      .toBeGreaterThan(railWidthBeforeDrag + 50);
    const railWidthAfterDrag = await reviewRail.evaluate(
      (rail) => rail.getBoundingClientRect().width,
    );
    await railResizeHandle.press("ArrowRight");
    await expect
      .poll(async () => reviewRail.evaluate((rail) => rail.getBoundingClientRect().width))
      .toBeLessThan(railWidthAfterDrag);

    const originalViewport = page.viewportSize();
    expect(originalViewport).not.toBeNull();
    for (let count = 0; count < 24; count += 1) await railResizeHandle.press("ArrowLeft");
    await page.setViewportSize({ width: 900, height: originalViewport!.height });
    const workspace = dialog.locator(".mermaid-expanded-workspace");
    await expect
      .poll(async () => {
        const workspaceWidth = await workspace.evaluate(
          (element) => element.getBoundingClientRect().width,
        );
        const currentRailWidth = await reviewRail.evaluate(
          (rail) => rail.getBoundingClientRect().width,
        );
        return workspaceWidth - currentRailWidth;
      })
      .toBeGreaterThanOrEqual(365);
    const constrainedRailWidth = await reviewRail.evaluate(
      (rail) => rail.getBoundingClientRect().width,
    );
    await railResizeHandle.press("ArrowLeft");
    await expect
      .poll(async () => reviewRail.evaluate((rail) => rail.getBoundingClientRect().width))
      .toBeLessThanOrEqual(constrainedRailWidth + 1);
    await page.setViewportSize(originalViewport!);

    const fitWidth = await expandedSvg.evaluate((svg) => svg.getBoundingClientRect().width);
    await dialog.getByRole("button", { name: "Zoom in" }).click();
    await expect
      .poll(async () => expandedSvg.evaluate((svg) => svg.getBoundingClientRect().width))
      .toBeGreaterThan(fitWidth);
    await dialog.getByRole("button", { name: "Zoom out" }).click();
    await dialog.getByRole("button", { name: "Fit" }).click();
    await expect(dialog.getByRole("button", { name: "Fit" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const zoomIn = dialog.getByRole("button", { name: "Zoom in" });
    for (let count = 0; count < 8 && !(await zoomIn.isDisabled()); count += 1) {
      await zoomIn.click();
    }
    await expect
      .poll(async () =>
        dialog
          .getByRole("region", { name: "Mermaid diagram canvas" })
          .evaluate(
            (canvas) =>
              canvas.scrollWidth > canvas.clientWidth || canvas.scrollHeight > canvas.clientHeight,
          ),
      )
      .toBe(true);
    await dialog.getByRole("button", { name: "Fit" }).click();

    await commentsToggle.click();
    await expect(dialog.getByRole("complementary", { name: "Diagram review" })).toHaveCount(0);
    await commentsToggle.click();
    await expect(dialog.getByRole("complementary", { name: "Diagram review" })).toBeVisible();

    const replyDraft = dialog.getByPlaceholder("返信を入力");
    await replyDraft.fill("Draft survives reference peek");
    await dialog.getByRole("button", { name: /fixture implementation/i }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("src/fixture.ts", { exact: true })).toBeVisible();
    await expect(dialog.getByText("L1–L2", { exact: true })).toBeVisible();
    const sourceExcerpt = dialog.getByLabel(/src\/fixture\.ts L1–L2 のソース抜粋/);
    await expect(sourceExcerpt).toContainText("fixture");
    await expect(sourceExcerpt).toHaveAttribute("data-syntax-highlighted", "true");
    await expect
      .poll(() => sourceExcerpt.locator(".mermaid-reference-code-line span[style]").count())
      .toBeGreaterThan(0);
    const highlightedLineSpacing = await sourceExcerpt
      .locator(".mermaid-reference-code-line")
      .evaluateAll((lines) => {
        const first = lines[0]?.getBoundingClientRect();
        const second = lines[1]?.getBoundingClientRect();
        return first && second ? { height: first.height, step: second.top - first.top } : null;
      });
    expect(highlightedLineSpacing).not.toBeNull();
    expect(highlightedLineSpacing!.step).toBeLessThan(highlightedLineSpacing!.height * 1.25);
    await page.keyboard.press("Escape");
    await expect(
      dialog
        .getByRole("complementary", { name: "Diagram review" })
        .getByText("Comments", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByPlaceholder("返信を入力")).toHaveValue(
      "Draft survives reference peek",
    );
    await dialog.getByRole("button", { name: /single-line target/i }).click();
    await expect(dialog.getByText("src/single-line.ts", { exact: true })).toBeVisible();
    await expect(dialog.getByText("L42", { exact: true })).toBeVisible();
    const singleLineExcerpt = dialog.getByLabel(/src\/single-line\.ts L42 のソース抜粋/);
    await expect(singleLineExcerpt.locator('[data-line="42"]')).toContainText(
      "const referencedLine = 42;",
    );
    await page.keyboard.press("Escape");
    await dialog.getByPlaceholder("返信を入力").press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder("返信を入力")).toHaveValue("");

    await dialog.getByRole("button", { name: "Comment on diagram" }).click();
    const preservedDiagramDraft = dialog.getByRole("textbox", { name: "Comment on diagram" });
    await preservedDiagramDraft.fill("Diagram draft survives reference peek");
    await dialog.getByRole("button", { name: /fixture implementation/i }).click();
    await dialog.getByRole("button", { name: "← Comments" }).click();
    await expect(dialog.getByRole("textbox", { name: "Comment on diagram" })).toHaveValue(
      "Diagram draft survives reference peek",
    );
    await dialog.getByRole("textbox", { name: "Comment on diagram" }).press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Comment on diagram" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await inlineDiagram.getByRole("button", { name: "Mermaid diagramを拡大" }).click();
    dialog = page.getByRole("dialog", { name: "Mermaid diagram" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Comments/ }).click();

    await dialog.getByRole("button", { name: /fixture implementation/i }).click();
    await expect(dialog.getByRole("button", { name: "← Comments" })).toBeVisible();
    await dialog.getByRole("button", { name: "← Comments" }).click();
    await dialog.getByRole("button", { name: /fixture implementation/i }).click();
    await dialog.getByRole("button", { name: "Open in review" }).click();
    await expect(page.getByRole("dialog", { name: "Mermaid diagram" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await page
      .locator(".file-tree")
      .getByRole("button", { name: "README.md", exact: true })
      .click();
    await inlineDiagram.getByRole("button", { name: "Mermaid diagramを拡大" }).click();
    dialog = page.getByRole("dialog", { name: "Mermaid diagram" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Comments/ }).click();
    await dialog.getByPlaceholder("返信を入力").fill("Expanded reply");
    await dialog.getByRole("button", { name: /から返信を送信/ }).click();
    await expect(dialog.getByText("Expanded reply", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: "Comment on diagram" }).click();
    await dialog
      .getByRole("textbox", { name: "Comment on diagram" })
      .fill("Expanded diagram finding");
    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/comments") && response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "コメント", exact: true }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.ok()).toBe(true);
    const created = (await createResponse.json()) as { comment: { id: string } };
    createdCommentId = created.comment.id;
    await expect(
      dialog
        .locator(`[data-comment-id="${createdCommentId}"]`)
        .getByText("Expanded diagram finding", { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Expanded Mermaid viewを閉じる" }).click();
    await expect(
      preview
        .locator(`[data-comment-id="${createdCommentId}"]`)
        .getByText("Expanded diagram finding", { exact: true }),
    ).toBeVisible();

    await openCommentsSidebar(page);
    const sidebarThread = page.locator(
      `.comment-sidebar [data-comment-id="${existing.comment.id}"]`,
    );
    await sidebarThread.scrollIntoViewIfNeeded();
    const commentDiagram = sidebarThread.locator(".comment-mermaid-shell");
    await expect(
      commentDiagram.getByRole("img", { name: "Mermaid diagram" }).locator("svg"),
    ).toBeVisible();
    await expect(
      commentDiagram.getByRole("button", { name: "Mermaid diagramを拡大" }),
    ).toBeVisible();
    await commentDiagram.getByRole("button", { name: "Mermaid diagramを拡大" }).click();
    await expect(page.getByRole("dialog", { name: "Mermaid diagram" })).toBeVisible();
    await expect(
      page
        .getByRole("dialog", { name: "Mermaid diagram" })
        .getByRole("img", { name: "Expanded Mermaid diagram" }),
    ).toBeVisible();
    const commentDialog = page.getByRole("dialog", { name: "Mermaid diagram" });
    await commentDialog.getByRole("button", { name: /Comments/ }).click();
    const repositoryLink = commentDialog.getByRole("link", {
      name: "fixture repository file",
    });
    await expect(repositoryLink).toBeVisible();
    await repositoryLink.click();
    await expect(commentDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Mermaid diagram" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  } finally {
    if (createdCommentId) {
      expect((await request.delete(`/api/comments/${createdCommentId}`, { data: {} })).ok()).toBe(
        true,
      );
    }
    expect((await request.delete(`/api/comments/${existing.comment.id}`, { data: {} })).ok()).toBe(
      true,
    );
  }
});
