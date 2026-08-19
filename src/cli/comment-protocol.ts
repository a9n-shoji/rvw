import type {
  CommentListContext,
  CommentReviewContext,
  CommentWatchEventContext,
} from "../application/rvw-service.js";
import type { CommentTarget, PullRequest } from "../domain/models.js";
import { MAX_COMMENT_LIST_BODY_PREVIEW_BYTES } from "../shared/constants.js";
import {
  commentGetOutputSchema,
  commentListOutputSchema,
  type CommentGetOutput,
  type CommentListOptions,
  type CommentListOutput,
} from "./schemas.js";

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return { value: result, truncated: true };
}

function formatPullRequest(
  pullRequest: PullRequest,
  options: { includeBody?: boolean } = {},
): CommentGetOutput["pullRequest"] {
  const headRepository =
    pullRequest.latestHeadRepositoryOwner && pullRequest.latestHeadRepositoryName
      ? {
          owner: pullRequest.latestHeadRepositoryOwner,
          name: pullRequest.latestHeadRepositoryName,
          url: `https://github.com/${pullRequest.latestHeadRepositoryOwner}/${pullRequest.latestHeadRepositoryName}`,
        }
      : null;
  return {
    url: pullRequest.url,
    owner: pullRequest.owner,
    repository: pullRequest.repository,
    number: pullRequest.number,
    authorLogin: pullRequest.latestAuthorLogin,
    headRepository,
    title: pullRequest.latestTitle,
    ...(options.includeBody ? { body: pullRequest.latestBody } : {}),
    baseRefName: pullRequest.latestBaseRefName,
    baseOid: pullRequest.latestBaseOid,
    comparisonBaseOid: pullRequest.latestComparisonBaseOid,
    headRefName: pullRequest.latestHeadRefName,
    headOid: pullRequest.latestHeadOid,
    githubUpdatedAt: pullRequest.githubUpdatedAt,
    fetchedAt: pullRequest.fetchedAt,
    localRepositoryPath: pullRequest.localRepositoryPath,
  };
}

function formatListTarget(
  target: CommentTarget,
): CommentListOutput["comments"][number]["comment"]["target"] {
  if (target.kind === "pull-request") return target;
  if (target.kind === "walkthrough") {
    return {
      kind: target.kind,
      walkthroughId: target.walkthroughId,
      walkthroughTitle: target.walkthroughTitle,
      startLine: target.startLine,
      endLine: target.endLine,
    };
  }
  if (target.documentKind === "pull-request-markdown") {
    return {
      kind: target.kind,
      documentKind: target.documentKind,
      startLine: target.startLine,
      endLine: target.endLine,
    };
  }
  return {
    kind: target.kind,
    documentKind: target.documentKind,
    path: target.path,
    startLine: target.startLine,
    endLine: target.endLine,
  };
}

export function formatCommentGetOutput(
  result: CommentReviewContext,
  options: { includePrBody?: boolean } = {},
): CommentGetOutput {
  return commentGetOutputSchema.parse({
    ok: true,
    pullRequest: formatPullRequest(result.pullRequest, {
      includeBody: options.includePrBody ?? false,
    }),
    comment: {
      ...result.comment,
      resolved: result.comment.resolvedAt !== null,
    },
    latestHeadOid: result.pullRequest.latestHeadOid,
    latestPlacement: result.latestPlacement,
    exactSource: result.exactSource,
    walkthrough: result.walkthrough,
    githubState: {
      liveCheckedAt: result.githubState.liveCheckedAt,
      staleAgainstGitHub: result.githubState.staleAgainstGitHub,
      live: result.githubState.live
        ? {
            authorLogin: result.githubState.live.authorLogin,
            headRepository:
              result.githubState.live.headRepositoryOwner &&
              result.githubState.live.headRepositoryName
                ? {
                    owner: result.githubState.live.headRepositoryOwner,
                    name: result.githubState.live.headRepositoryName,
                    url: `https://github.com/${result.githubState.live.headRepositoryOwner}/${result.githubState.live.headRepositoryName}`,
                  }
                : null,
            title: result.githubState.live.title,
            ...(options.includePrBody ? { body: result.githubState.live.body } : {}),
            baseRefName: result.githubState.live.baseRefName,
            baseOid: result.githubState.live.baseOid,
            headRefName: result.githubState.live.headRefName,
            headOid: result.githubState.live.headOid,
            githubUpdatedAt: result.githubState.live.updatedAt,
          }
        : null,
    },
  });
}

export function formatCommentWatchEvent(item: CommentWatchEventContext) {
  return {
    cursor: item.cursor,
    event: item.event,
  };
}

export function formatCommentListOutput(
  result: CommentListContext,
  state: CommentListOptions["state"],
): CommentListOutput {
  return commentListOutputSchema.parse({
    ok: true,
    pullRequest: formatPullRequest(result.pullRequest),
    state,
    page: result.page,
    comments: result.comments.map(({ comment, rootPost, postCount, latestPlacement }) => {
      const preview = truncateUtf8(rootPost.body, MAX_COMMENT_LIST_BODY_PREVIEW_BYTES);
      return {
        comment: {
          ref: comment.ref,
          resolved: comment.resolvedAt !== null,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          target: formatListTarget(comment.target),
          postCount,
          rootPost: {
            body: preview.value,
            bodyTruncated: preview.truncated,
            authorLabel: rootPost.authorLabel,
            relatedCommitOid: rootPost.relatedCommitOid,
            createdAt: rootPost.createdAt,
            updatedAt: rootPost.updatedAt,
          },
        },
        latestPlacement,
      };
    }),
  });
}
