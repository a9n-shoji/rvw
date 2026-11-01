import { expect, test } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const permissionLabel = "この依頼に伴う変更を許可";

test("keeps permission independent for each post and reply, including after reload", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: { kind: "pull-request" },
      body: "Why is this choice necessary?",
      allowChanges: true,
    },
  });
  expect(created.ok()).toBe(true);
  const { comment } = (await created.json()) as { comment: { id: string } };
  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await page.getByRole("button", { name: /^コメント \d+$/ }).click();
    const thread = page.locator(`.comment-thread--sidebar[data-comment-id="${comment.id}"]`);
    await expect(thread).toBeVisible();
    const root = thread
      .locator(".comment-post")
      .first()
      .getByRole("checkbox", { name: permissionLabel });
    await expect(root).toBeChecked();
    // Permission can be withdrawn without editing the request or changing resolution.
    await root.click();
    await expect(root).not.toBeChecked();
    const draftPermission = thread.getByRole("checkbox", { name: permissionLabel }).last();
    await expect(draftPermission).not.toBeChecked();
    await thread
      .locator(".comment-reply-composer textarea")
      .fill("Please explain the alternative too");
    await draftPermission.check();
    await thread.getByRole("button", { name: /から返信を送信/ }).click();
    await expect(thread.locator(".comment-post")).toHaveCount(2);
    await expect(
      thread.locator(".comment-post").last().getByRole("checkbox", { name: permissionLabel }),
    ).toBeChecked();
    await expect(thread.getByRole("checkbox", { name: permissionLabel }).last()).not.toBeChecked();
    await page.reload();
    const commentsToggle = page.getByRole("button", { name: /^コメント \d+$/ });
    await expect(commentsToggle).toBeVisible();
    if ((await commentsToggle.getAttribute("aria-expanded")) !== "true")
      await commentsToggle.click();
    await expect(root).not.toBeChecked();
    await expect(
      thread.locator(".comment-post").last().getByRole("checkbox", { name: permissionLabel }),
    ).toBeChecked();
    await expect(thread.getByRole("button", { name: "解決", exact: true })).toBeVisible();
  } finally {
    await request.delete(`/api/comments/${comment.id}`, { data: {} });
  }
});
