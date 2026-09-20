import { expect, test } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";

for (const mode of ["全文", "変更"] as const) {
  test(`preserves a new line comment while an external comment arrives in ${mode}`, async ({
    page,
    request,
  }) => {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
    await page
      .getByRole("region", { name: "レビュー範囲", exact: true })
      .getByRole("button", { name: mode, exact: true })
      .click();
    const diff = page.locator("diffs-container");
    await diff.locator('[data-column-number="1"]').first().hover();
    await diff.locator("[data-utility-button]").first().click();
    const draft = page.locator(".inline-comment-composer--line textarea");
    await draft.fill("書きかけのコメント\n続き");
    const view = (await (await request.get(`/api/pull-requests/${pullRequestId}`)).json()) as {
      headOid: string;
    };
    const response = await request.post("/api/comments", {
      data: {
        pullRequestId,
        target: {
          kind: "document",
          documentKind: "repository-file",
          sourceOid: view.headOid,
          path: "src/fixture.ts",
          startLine: 1,
          endLine: 1,
        },
        body: `External comment ${mode}`,
        authorLabel: "Codex",
      },
    });
    expect(response.ok()).toBe(true);
    const { comment } = (await response.json()) as { comment: { id: string } };
    try {
      await expect(diff.getByText(`External comment ${mode}`, { exact: true })).toBeVisible();
      await expect(draft).toHaveValue("書きかけのコメント\n続き");
      await expect(draft).toBeFocused();
    } finally {
      await request.delete(`/api/comments/${comment.id}`, { data: {} });
    }
  });
}

for (const view of ["Preview", "Source", "Walkthrough"] as const) {
  for (const action of ["reply", "edit"] as const) {
    test(`preserves ${action} draft during an external reply in ${view}`, async ({
      page,
      request,
    }) => {
      const response = await request.post("/api/comments", {
        data: {
          pullRequestId,
          target:
            view === "Walkthrough"
              ? {
                  kind: "walkthrough",
                  walkthroughId: "70000000-0000-4000-8000-000000000001",
                  startLine: 3,
                  endLine: 3,
                }
              : {
                  kind: "document",
                  documentKind: "pull-request-markdown",
                  startLine: 3,
                  endLine: 3,
                },
          body: "Original comment",
          authorLabel: "You",
        },
      });
      expect(response.ok()).toBe(true);
      const { comment } = (await response.json()) as { comment: { id: string } };
      try {
        await page.goto(`/?pullRequestId=${pullRequestId}`);
        if (view === "Walkthrough") {
          await page.getByRole("button", { name: /^ウォークスルー \d+$/ }).click();
          await page
            .getByRole("navigation", { name: "レビュー文書" })
            .getByRole("button", {
              name: "注文作成フロー：HTTPからtransactional outboxまで",
              exact: true,
            })
            .click();
        } else {
          await page.getByRole("button", { name: view, exact: true }).click();
        }
        const thread = page.locator(`.comment-thread--inline[data-comment-id="${comment.id}"]`);
        await expect(thread).toBeVisible();
        if (action === "edit") {
          await thread.getByRole("button", { name: "コメントのその他の操作", exact: true }).click();
          await thread.getByRole("menuitem", { name: "編集", exact: true }).click();
        }
        const draft = thread.locator(
          action === "edit"
            ? ".comment-edit-composer textarea"
            : ".comment-reply-composer textarea",
        );
        await draft.fill("入力中の文章\n続き");
        const originalInput = await draft.elementHandle();
        const reply = await request.post(`/api/comments/${comment.id}/posts`, {
          data: { body: "External reply", authorLabel: "Codex", relatedCommitOid: null },
        });
        expect(reply.ok()).toBe(true);
        await expect(thread.getByText("External reply", { exact: true })).toBeVisible();
        await expect(draft).toHaveValue("入力中の文章\n続き");
        await expect(draft).toBeFocused();
        expect(await originalInput?.evaluate((element) => element.isConnected)).toBe(true);
        await draft.press("End");
        await draft.pressSequentially("を追記");
        await expect(draft).toHaveValue("入力中の文章\n続きを追記");
        if (action === "edit") {
          await thread.getByRole("button", { name: "保存", exact: true }).click();
          await expect(thread.getByText("入力中の文章", { exact: false })).toContainText(
            "続きを追記",
          );
          await expect(draft).toHaveCount(0);
        }
      } finally {
        await request.delete(`/api/comments/${comment.id}`, { data: {} });
      }
    });
  }
}
