import { describe, expect, it } from "vitest";
import { issueSyncFailureFeedback } from "../../src/web/review-sync-feedback.js";

describe("review sync feedback", () => {
  it("shows three Issue failures and summarizes the remainder", () => {
    const feedback = issueSyncFailureFeedback(
      [1, 2, 3, 4, 5].map((number) => ({
        reference: `#${number}`,
        issue: { number },
        error: { message: `failure ${number}` },
      })),
    );

    expect(feedback).toContain("Issue 5件の更新に失敗しました");
    expect(feedback).toContain("#1: failure 1");
    expect(feedback).toContain("#2: failure 2");
    expect(feedback).toContain("#3: failure 3");
    expect(feedback).toContain("ほか2件");
    expect(feedback).not.toContain("#4: failure 4");
  });
});
