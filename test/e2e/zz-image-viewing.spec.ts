import { expect, test } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";

test("renders secured attachments and repository image states without text-image requests", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const directGitHubImageRequests: string[] = [];
  const createdCommentBodies = [
    "Image review comment from E2E.",
    "Deleted image old-side comment from E2E.",
    "Hybrid rename new-side comment from E2E.",
  ] as const;
  page.on("request", (browserRequest) => {
    if (browserRequest.url().startsWith("https://github.com/user-attachments/")) {
      directGitHubImageRequests.push(browserRequest.url());
    }
  });
  const externalBefore = (await (await request.get("/api/test/external-image-count")).json()) as {
    count: number;
  };
  const imageTextBefore = (await (
    await request.get("/api/test/image-text-request-count")
  ).json()) as {
    count: number;
  };
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const attachment = page.getByRole("img", { name: "Private attachment", exact: true });
  await expect(attachment).toHaveAttribute(
    "src",
    new RegExp(`/api/pull-requests/${pullRequestId}/github-attachment\\?url=`),
  );
  await expect
    .poll(() => attachment.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(1);
  await expect(
    page.getByRole("img", { name: "画像: Broken attachment（読み込み失敗）", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "画像: External PR image（自動読み込み停止）", exact: true }),
  ).toBeVisible();
  expect(directGitHubImageRequests).toEqual([]);
  const externalAfter = (await (await request.get("/api/test/external-image-count")).json()) as {
    count: number;
  };
  expect(externalAfter.count).toBe(externalBefore.count);

  const reviewScope = page.getByRole("region", { name: "レビュー範囲", exact: true });
  await page.getByRole("button", { name: "assets/modified.png", exact: true }).click();
  await reviewScope.getByRole("button", { name: "全文", exact: true }).click();
  const fullImage = page.getByRole("img", { name: "全文: assets/modified.png", exact: true });
  await expect(fullImage).toBeVisible();
  const view = (await (await request.get(`/api/pull-requests/${pullRequestId}`)).json()) as {
    comparisonBaseOid: string;
    headOid: string;
  };
  await expect(fullImage).toHaveAttribute(
    "src",
    new RegExp(`sourceOid=${view.headOid}&path=assets%2Fmodified\\.png`),
  );
  await expect
    .poll(() => fullImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(1);
  await expect(page.locator("diffs-container")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Preview", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "ファイル全体へコメント", exact: true }).click();
  let composer = page.locator(".inline-comment-composer--file");
  await composer
    .getByRole("textbox", { name: "ファイル全体へコメント" })
    .fill(createdCommentBodies[0]);
  await composer.getByRole("button", { name: "コメント", exact: true }).click();
  let inlineComment = page.locator(".repository-image-comments .comment-thread--inline").filter({
    hasText: createdCommentBodies[0],
  });
  await expect(inlineComment).toBeVisible();
  await inlineComment.getByRole("button", { name: "解決", exact: true }).click();
  await expect(inlineComment).toHaveCount(0);

  const commentsToggle = page.locator(".sidebar-stack--comments > .sidebar-stack-toggle");
  if ((await commentsToggle.getAttribute("aria-expanded")) !== "true") await commentsToggle.click();
  await page.getByRole("button", { name: /^解決済み/ }).click();
  const resolvedSidebarComment = page.locator(".comment-list-item").filter({
    hasText: createdCommentBodies[0],
  });
  await expect(resolvedSidebarComment).toBeVisible();
  await resolvedSidebarComment.getByRole("button", { name: "再度開く", exact: true }).click();
  await expect(resolvedSidebarComment).toHaveCount(0);
  await page.getByRole("button", { name: /^未解決/ }).click();
  const sidebarComment = page.locator(".comment-list-item").filter({
    hasText: createdCommentBodies[0],
  });
  await expect(sidebarComment).toBeVisible();
  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  await sidebarComment.getByRole("button", { name: "コメント対象を開く", exact: true }).click();
  await expect(page.getByRole("tab", { name: "assets/modified.png", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  inlineComment = page.locator(".repository-image-comments .comment-thread--inline").filter({
    hasText: createdCommentBodies[0],
  });
  await expect(inlineComment).toBeVisible();

  await page.getByRole("button", { name: "assets/modified.pngを閉じる", exact: true }).click();
  await page.getByRole("button", { name: "assets/modified.png", exact: true }).click();
  await reviewScope.getByRole("button", { name: "変更", exact: true }).click();
  const oldModified = page.getByRole("img", {
    name: "変更前: assets/modified.png",
    exact: true,
  });
  const newModified = page.getByRole("img", {
    name: "変更後: assets/modified.png",
    exact: true,
  });
  await expect(oldModified).toHaveAttribute(
    "src",
    new RegExp(`sourceOid=${view.comparisonBaseOid}&path=assets%2Fmodified\\.png`),
  );
  await expect(newModified).toHaveAttribute(
    "src",
    new RegExp(`sourceOid=${view.headOid}&path=assets%2Fmodified\\.png`),
  );
  await expect(page.locator(".repository-image-viewer--split .repository-image-pane")).toHaveCount(
    2,
  );

  await page.getByRole("button", { name: "assets/added.png", exact: true }).click();
  await expect(page.getByText("変更前の画像はありません。", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("img", { name: "変更後: assets/added.png", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "assets/deleted.png", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "変更前: assets/deleted.png", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("変更後の画像はありません。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ファイル全体へコメント", exact: true }).click();
  composer = page.locator(".inline-comment-composer--file");
  await composer
    .getByRole("textbox", { name: "ファイル全体へコメント" })
    .fill(createdCommentBodies[1]);
  await composer.getByRole("button", { name: "コメント", exact: true }).click();

  await page.getByRole("button", { name: "assets/new-name.png", exact: true }).click();
  const renamedViewer = page.locator(".repository-image-viewer--split");
  await expect(renamedViewer.getByText("assets/old-name.png", { exact: true })).toBeVisible();
  await expect(renamedViewer.getByText("assets/new-name.png", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "docs/hybrid.md", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "変更前: assets/hybrid.png", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("変更後は対応画像ではありません。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ファイル全体へコメント", exact: true }).click();
  composer = page.locator(".inline-comment-composer--file");
  await composer
    .getByRole("textbox", { name: "ファイル全体へコメント" })
    .fill(createdCommentBodies[2]);
  await composer.getByRole("button", { name: "コメント", exact: true }).click();

  type CommentTarget = { sourceOid?: string; path?: string };
  type FixtureComment = { id: string; target: CommentTarget; posts: Array<{ body: string }> };
  const createdComments = (await (
    await request.get(`/api/pull-requests/${pullRequestId}/comments`)
  ).json()) as { comments: FixtureComment[] };
  const oldSideComment = createdComments.comments.find((comment) =>
    comment.posts.some((post) => post.body === createdCommentBodies[1]),
  );
  expect(oldSideComment?.target).toMatchObject({
    sourceOid: view.comparisonBaseOid,
    path: "assets/deleted.png",
  });
  const newSideComment = createdComments.comments.find((comment) =>
    comment.posts.some((post) => post.body === createdCommentBodies[2]),
  );
  expect(newSideComment?.target).toMatchObject({
    sourceOid: view.headOid,
    path: "docs/hybrid.md",
  });

  await reviewScope.getByRole("button", { name: "全文", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hybrid document", exact: true })).toBeVisible();
  await expect(page.locator(".repository-image-viewer")).toHaveCount(0);

  const unchangedFiles = page.getByRole("checkbox", { name: "変更のないファイルも表示" });
  if (!(await unchangedFiles.isChecked())) await unchangedFiles.check();
  const assetsFolder = page.getByRole("button", { name: "assets フォルダ", exact: true });
  if ((await assetsFolder.getAttribute("aria-expanded")) !== "true") await assetsFolder.click();
  await page.getByRole("button", { name: "assets/too-large.png", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "5 MiBを超えるため画像を表示できません。" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "assets/unsupported.png", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "画像形式が未対応か、内容が破損しています。" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "assets/broken.png", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "画像を読み込めませんでした。" }),
  ).toBeVisible();

  const imageTextAfter = (await (
    await request.get("/api/test/image-text-request-count")
  ).json()) as {
    count: number;
  };
  expect(imageTextAfter.count).toBe(imageTextBefore.count);

  for (const comment of createdComments.comments) {
    if (comment.posts.some((post) => createdCommentBodies.some((body) => body === post.body))) {
      await request.delete(`/api/comments/${comment.id}`);
    }
  }
});
