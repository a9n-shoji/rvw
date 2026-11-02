import { expect, test } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const permissionLabel = "この依頼に伴う変更を許可";

test("hides submitted permissions even while editing, including after reload", async ({
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
    await expect(root).toHaveCount(0);
    await thread.getByRole("button", { name: "コメントのその他の操作" }).click();
    await thread.getByRole("menuitem", { name: "編集", exact: true }).click();
    await expect(root).toHaveCount(0);
    await thread
      .getByRole("textbox", { name: "コメントを編集", exact: true })
      .fill("Updated question");
    await thread.getByRole("button", { name: "保存", exact: true }).click();
    await expect(root).toHaveCount(0);
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
    ).toHaveCount(0);
    await expect(thread.getByRole("checkbox", { name: permissionLabel }).last()).not.toBeChecked();
    await page.reload();
    const commentsToggle = page.getByRole("button", { name: /^コメント \d+$/ });
    await expect(commentsToggle).toBeVisible();
    if ((await commentsToggle.getAttribute("aria-expanded")) !== "true")
      await commentsToggle.click();
    await expect(root).toHaveCount(0);
    await expect(
      thread.locator(".comment-post").last().getByRole("checkbox", { name: permissionLabel }),
    ).toHaveCount(0);
    await thread.getByRole("button", { name: "コメントのその他の操作" }).click();
    await thread.getByRole("menuitem", { name: "編集", exact: true }).click();
    await expect(root).toHaveCount(0);
    await thread.getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(root).toHaveCount(0);
    await thread.getByRole("button", { name: "1件目の返信のその他の操作" }).click();
    await thread.getByRole("menuitem", { name: "編集", exact: true }).click();
    await expect(
      thread.locator(".comment-post").last().getByRole("checkbox", { name: permissionLabel }),
    ).toHaveCount(0);
    await thread.getByRole("button", { name: "保存", exact: true }).click();
    await expect(thread.locator(".comment-post").getByRole("checkbox")).toHaveCount(0);
    await expect(thread.getByRole("button", { name: "解決", exact: true })).toBeVisible();
  } finally {
    await request.delete(`/api/comments/${comment.id}`, { data: {} });
  }
});
