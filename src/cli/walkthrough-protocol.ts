import type { WalkthroughListContext } from "../application/rvw-service.js";
import { formatPullRequest } from "./comment-protocol.js";
import { walkthroughListOutputSchema, type WalkthroughListOutput } from "./schemas.js";

export function formatWalkthroughListOutput(result: WalkthroughListContext): WalkthroughListOutput {
  return walkthroughListOutputSchema.parse({
    ok: true,
    pullRequest: formatPullRequest(result.pullRequest),
    walkthroughs: result.walkthroughs,
    page: result.page,
  });
}
