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
    await expect(pullRequestDiagram.locator("svg")).toBeVisible();
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
    await expect(repositoryDiagram.locator("svg")).toBeVisible();
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
