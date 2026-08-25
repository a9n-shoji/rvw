import { expect, test } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const mermaidMarkdown = (title: string, diagram: string): string =>
  [`# ${title}`, "", "```mermaid", "flowchart LR", `  ${diagram}`, "```", ""].join("\n");

test("renders Mermaid diagrams in pull request and repository Markdown previews", async ({
  page,
}) => {
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

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const preview = page.locator(".markdown-preview");
  const pullRequestDiagram = preview.locator(".markdown-mermaid-shell");
  await expect(pullRequestDiagram.locator("svg")).toBeVisible();
  await expect(pullRequestDiagram).toHaveAttribute("data-rvw-source-start-line", "3");
  await expect(preview.locator("pre code.language-mermaid")).toHaveCount(0);

  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await page.locator(".file-tree").getByRole("button", { name: "README.md", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Repository diagram" })).toBeVisible();
  const repositoryDiagram = preview.locator(".markdown-mermaid-shell");
  await expect(repositoryDiagram.locator("svg")).toBeVisible();
  await expect(repositoryDiagram).toHaveAttribute("data-rvw-source-end-line", "6");
  await expect(preview.locator("pre code.language-mermaid")).toHaveCount(0);
});
