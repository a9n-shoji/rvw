import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import type {
  RepositoryReviewCommentTarget,
  RepositoryReviewDocumentContent,
  RepositoryReviewDocumentRef,
  RepositoryForgetCounts,
  RepositoryResetCounts,
  RepositoryReview,
  RepositoryReviewComment,
  RepositoryReviewSearchResponse,
  RepositoryWalkthrough,
  RepositoryWalkthroughSummary,
  CachedIssueDocument,
  ChangedFile,
  CodeReference,
  CommentPlacement,
  CommentPost,
  CommentPostModifier,
  CommentPostEvent,
  CommentTarget,
  CommitSummary,
  DiffDocumentRef,
  DocumentAvailability,
  DocumentContent,
  DocumentRef,
  GitHubIssue,
  GitHubPullRequest,
  IssueDocument,
  IssueRemovalCounts,
  PullRequest,
  ResetCounts,
  ReviewComment,
  SearchResponse,
  SearchOptions,
  TreeEntry,
  DeletedRepositoryWalkthrough,
  DeletedWalkthrough,
  Walkthrough,
  WalkthroughDeleteCounts,
  WalkthroughMutationResult,
  WalkthroughReference,
  WalkthroughSummary,
} from "../domain/models.js";
import { parseCommentUri } from "../domain/comment-uri.js";
import {
  formatCommentWatchCursor,
  parseCommentWatchCursor,
} from "../domain/comment-watch-cursor.js";
import { parseWalkthroughUri } from "../domain/walkthrough-uri.js";
import { mapUnchangedLineRange, placeMutableDocumentComment } from "../domain/line-mapping.js";
import { buildPullRequestMarkdown, hashDocument, selectedLineText } from "../domain/pr-markdown.js";
import { createSourceExcerpt, type SourceExcerpt } from "../domain/source-excerpt.js";
import {
  DEFAULT_COMMENT_LIST_LIMIT,
  DEFAULT_COMMENT_WATCH_LIMIT,
  GIT_OBJECT_ID_PATTERN,
  MAX_AUTHOR_LABEL_CHARACTERS,
  MAX_COMMENT_BODY_BYTES,
  MAX_COMMENT_LIST_LIMIT,
  MAX_COMMENT_WATCH_LIMIT,
  MAX_IDEMPOTENCY_KEY_CHARACTERS,
  MAX_ISSUE_REFERENCE_CHARACTERS,
  MAX_SEARCH_QUERY_BYTES,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_STDOUT_BYTES,
  MAX_WALKTHROUGH_BODY_BYTES,
  MAX_WALKTHROUGH_ISSUES_TO_ADD,
  MAX_CODE_REFERENCE_DESCRIPTION_CHARACTERS,
  MAX_CODE_REFERENCE_LABEL_CHARACTERS,
  MAX_CODE_REFERENCE_PATH_CHARACTERS,
  MAX_CODE_REFERENCES,
  MAX_WALKTHROUGH_TITLE_CHARACTERS,
} from "../shared/constants.js";
import { findFixedStringMatches } from "../domain/search.js";
import { asRvwError, RvwError } from "../shared/errors.js";
import {
  assertFetchedIssueIdentity,
  isIssueIdentityMismatch,
} from "../shared/github-issue-identity.js";
import {
  canonicalGitHubAttachmentUrl,
  detectImageContentType,
  type ImageContentType,
} from "../shared/image-assets.js";
import {
  RvwDatabase,
  type CommentUpdateInput,
  type RepositoryReviewWriteContext,
} from "../infrastructure/db/database.js";
import {
  GitClient,
  type BlobContent,
  type RepositoryContext,
} from "../infrastructure/git/git-client.js";
import {
  parseIssueReference,
  parsePullRequestUrl,
  type GitHubPort,
} from "../infrastructure/github/github-client.js";
import {
  RepositoryReviewLifecycle,
  type RepositoryRelocationEvidenceStatus,
  type ResolvedRepositoryForget,
  type ResolvedRepositoryRelocation,
  type ResolvedRepositoryReview,
} from "./repository-review-lifecycle.js";

export interface OpenResult {
  pullRequest: PullRequest;
  fromCache: boolean;
}

export interface OpenRepositoryResult {
  repositoryReview: RepositoryReview;
  fromCache: boolean;
  selectedRemote: { name: string; url: string } | null;
}

export interface RepositoryRelocationPreview extends RepositoryRelocationEvidenceStatus {
  repositoryReview: RepositoryReview;
  previousLocation: { localRepositoryPath: string; gitCommonDir: string };
  candidateLocation: { localRepositoryPath: string; gitCommonDir: string };
  selectedRemote: { name: string; url: string };
  sourceOid: string;
  reviewChangeSequence: number;
  confirmationToken: string;
  confirmationRequired: true;
}

export interface RepositoryForgetPreview {
  repositoryReview: RepositoryReview;
  counts: RepositoryForgetCounts;
  registeredLocation: { localRepositoryPath: string; gitCommonDir: string };
  candidateLocation: { localRepositoryPath: string; gitCommonDir: string };
  selectedRemote: { name: string; url: string };
  registeredBinding: ResolvedRepositoryForget["registeredBinding"];
  refPrefix: string;
  reviewChangeSequence: number;
  confirmationToken: string;
  confirmationRequired: true;
}

export interface RepositoryReviewView {
  repositoryReview: RepositoryReview;
  issues: IssueDocument[];
  walkthroughs: RepositoryWalkthroughSummary[];
  selectedRemote?: { name: string; url: string } | null;
}

export interface RepositorySyncResult extends RepositoryReviewView {
  issueResults: Array<
    | {
        issue: IssueDocument;
        ok: true;
        skipped?: "membership-removed" | "older-response" | "newer-attempt";
      }
    | { issue: IssueDocument; ok: false; error: ReturnType<RvwError["toJSON"]> }
  >;
}

export interface PullRequestView {
  pullRequest: PullRequest;
  comparisonBaseOid: string;
  headOid: string;
  commits: CommitSummary[];
}

export type IssueSyncResult =
  | {
      reference: string;
      issue: IssueDocument;
      ok: true;
      skipped?: "membership-removed" | "older-response" | "newer-attempt";
    }
  | {
      reference: string;
      issue: IssueDocument | null;
      ok: false;
      error: ReturnType<RvwError["toJSON"]>;
    };

export interface SyncResult extends PullRequestView {
  commentUpdatesApplied: number;
  issueResults: IssueSyncResult[];
}

export interface ResetPreview {
  pullRequest: PullRequest;
  counts: ResetCounts;
  retainedRefs: string[];
  retainedRefsPreserved: true;
  reviewChangeSequence: number;
  confirmationToken: string;
  confirmationRequired: true;
}

export interface DestructiveConfirmation {
  reviewChangeSequence: number;
  confirmationToken: string;
}

export interface CommentUpdateRequest {
  commentRef: string;
  reply: string;
  resolve: boolean;
  authorLabel?: string | null;
  references?: CodeReference[] | undefined;
  idempotencyKey?: string | undefined;
}

interface CommentCreateFields {
  body: string;
  authorLabel?: string | null | undefined;
  relatedCommitOid?: string | null | undefined;
  references?: CodeReference[] | undefined;
}

export type CommentCreateRequest = CommentCreateFields &
  (
    | {
        review: { kind: "pull-request"; pullRequest: string };
        pullRequest?: undefined;
        target: PullRequestCommentTargetRequest;
      }
    | {
        review: { kind: "repository"; repository: string };
        pullRequest?: undefined;
        target: RepositoryReviewCommentTargetRequest;
      }
    | {
        review?: undefined;
        pullRequest: string;
        target: PullRequestCommentTargetRequest;
      }
  );

export interface CommentExactSource {
  sourceOid: string;
  path: string;
  availability: DocumentAvailability;
  excerpt: SourceExcerpt | null;
}

export interface CommentReviewContext {
  context: { kind: "pull-request"; pullRequestId: string; pullRequestUrl: string };
  pullRequest: PullRequest;
  comment: ReviewComment;
  latestPlacement: CommentPlacement;
  exactSource: CommentExactSource | null;
  walkthrough: Walkthrough | null;
  issue: IssueDocument | null;
  githubState: {
    liveCheckedAt: string | null;
    staleAgainstGitHub: boolean | null;
    live: GitHubPullRequest | null;
  };
}

export interface RepositoryCommentReviewContext {
  context: { kind: "repository"; repositoryReviewId: string; repository: string };
  repositoryReview: RepositoryReview;
  comment: RepositoryReviewComment;
  latestPlacement: CommentPlacement;
  exactSource: CommentExactSource | null;
  walkthrough: RepositoryWalkthrough | null;
  issue: IssueDocument | null;
  githubState: {
    liveCheckedAt: null;
    staleAgainstGitHub: null;
    live: null;
  };
}

interface RepositoryPlacementCache {
  changedFiles: Map<string, Promise<ChangedFile[]>>;
  documents: Map<string, Promise<BlobContent>>;
}

export interface CommentListItemContext {
  comment: Omit<ReviewComment, "posts">;
  rootPost: ReviewComment["posts"][number];
  postCount: number;
  latestPlacement: CommentPlacement;
}

export interface CommentListContext {
  pullRequest: PullRequest;
  comments: CommentListItemContext[];
  page: {
    offset: number;
    limit: number;
    returned: number;
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
}

export interface CommentWatchEventContext {
  cursor: string;
  event: CommentPostEvent;
}

export interface CommentWatchContext {
  databaseId: string;
  startCursor: string;
  cursor: string;
  anchoredAtCurrent: boolean;
  hasMore: boolean;
  events: CommentWatchEventContext[];
}

export interface WalkthroughContentRequest {
  sourceOid: string;
  title: string;
  body: string;
  authorLabel?: string | null;
  diagramBindings?: Record<string, string>;
  references: WalkthroughReference[];
  issuesToAdd?: string[];
}

export interface WalkthroughPublishRequest extends WalkthroughContentRequest {
  review?:
    { kind: "pull-request"; pullRequest: string } | { kind: "repository"; repository: string };
  pullRequest?: string;
}

export type WalkthroughUpdateRequest = WalkthroughContentRequest;

export interface WalkthroughDeletePreview {
  walkthrough: Walkthrough | RepositoryWalkthrough;
  counts: WalkthroughDeleteCounts;
  reviewChangeSequence: number;
  confirmationToken: string;
  confirmationRequired: true;
}

export type CommentTargetRequest =
  | { kind: "pull-request" }
  | { kind: "repository" }
  | {
      kind: "issue";
      issue: string;
      startLine?: number | null;
      endLine?: number | null;
    }
  | {
      kind: "walkthrough";
      walkthroughId: string;
      startLine?: number | null;
      endLine?: number | null;
    }
  | {
      kind: "document";
      documentKind: "pull-request-markdown";
      startLine: number | null;
      endLine: number | null;
    }
  | {
      kind: "document";
      documentKind: "repository-file";
      sourceOid: string;
      path: string;
      startLine: number | null;
      endLine: number | null;
    };

type PullRequestCommentTargetRequest = Exclude<CommentTargetRequest, { kind: "repository" }>;
type RepositoryReviewCommentTargetRequest = Exclude<
  CommentTargetRequest,
  { kind: "pull-request" } | { kind: "document"; documentKind: "pull-request-markdown" }
>;

type RepositoryCommentTarget = Extract<
  CommentTarget,
  { kind: "document"; documentKind: "repository-file" }
>;

function assertTextBody(body: string): string {
  if (body.trim().length === 0)
    throw new RvwError("INVALID_INPUT", "コメント本文は空にできません。");
  if (Buffer.byteLength(body, "utf8") > MAX_COMMENT_BODY_BYTES) {
    throw new RvwError(
      "INVALID_INPUT",
      `コメント本文は${MAX_COMMENT_BODY_BYTES} bytes以下にしてください。`,
    );
  }
  return body;
}

function assertAuthorLabel(authorLabel: string | null | undefined): void {
  if (
    authorLabel !== null &&
    authorLabel !== undefined &&
    authorLabel.length > MAX_AUTHOR_LABEL_CHARACTERS
  ) {
    throw new RvwError(
      "INVALID_INPUT",
      `authorLabelは${MAX_AUTHOR_LABEL_CHARACTERS}文字以下にしてください。`,
    );
  }
}

function destructiveConfirmationToken(input: {
  operation: string;
  reviewKind: "pull-request" | "repository";
  reviewId: string;
  reviewChangeSequence: number;
  subjectId?: string;
  counts: object;
  retainedRefs?: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: input.operation,
        reviewKind: input.reviewKind,
        reviewId: input.reviewId,
        reviewChangeSequence: input.reviewChangeSequence,
        subjectId: input.subjectId ?? null,
        counts: input.counts,
        retainedRefs: [...(input.retainedRefs ?? [])].sort(),
      }),
    )
    .digest("hex");
}

function issueRepairSnapshot(issue: GitHubIssue): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        owner: issue.owner.toLowerCase(),
        repository: issue.repository.toLowerCase(),
        number: issue.number,
        url: issue.url.toLowerCase(),
        title: issue.title,
        body: hashDocument(issue.body),
        state: issue.state,
        updatedAt: issue.updatedAt,
      }),
    )
    .digest("hex");
}

function assertDestructiveConfirmation(
  providedToken: string,
  current: DestructiveConfirmation,
): void {
  if (providedToken === current.confirmationToken) return;
  throw new RvwError(
    "DESTRUCTIVE_PREVIEW_STALE",
    "確認後にreview stateが変更されました。最新のpreviewを確認してください。",
    {
      status: 409,
      details: {
        currentReviewChangeSequence: current.reviewChangeSequence,
        currentPreview: current,
      },
    },
  );
}

function destructiveStaleErrorWithCurrentPreview(
  error: unknown,
  currentPreview: DestructiveConfirmation,
): RvwError {
  const rvwError = asRvwError(error);
  if (rvwError.code !== "DESTRUCTIVE_PREVIEW_STALE") return rvwError;
  const details =
    rvwError.details && typeof rvwError.details === "object"
      ? (rvwError.details as Record<string, unknown>)
      : {};
  return new RvwError(rvwError.code, rvwError.message, {
    cause: error,
    status: rvwError.status,
    suggestions: rvwError.suggestions,
    details: { ...details, currentPreview },
  });
}

function assertIdempotencyKey(idempotencyKey: string | undefined): void {
  if (idempotencyKey === undefined) return;
  if (idempotencyKey.length === 0 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARACTERS) {
    throw new RvwError(
      "INVALID_INPUT",
      `idempotencyKeyは1〜${MAX_IDEMPOTENCY_KEY_CHARACTERS}文字にしてください。`,
    );
  }
}

function idempotencyRequestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function assertLinePair(startLine: number | null, endLine: number | null): void {
  if ((startLine === null) !== (endLine === null)) {
    throw new RvwError("INVALID_INPUT", "行範囲は開始行と終了行を両方指定してください。");
  }
}

function placeIssueComment(
  target: Extract<CommentTarget, { kind: "issue" }>,
  issue: CachedIssueDocument | null,
  belongsToReview: boolean,
): CommentPlacement {
  const path = `#${target.issueNumber}`;
  if (
    !issue ||
    !belongsToReview ||
    (target.startLine !== null && issue.bodyHash !== target.sourceDocumentHash)
  ) {
    return { outdated: true, range: null, path };
  }
  return {
    outdated: false,
    range:
      target.startLine === null || target.endLine === null
        ? null
        : { startLine: target.startLine, endLine: target.endLine },
    path: `#${issue.number}`,
  };
}

const codeReferenceIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const walkthroughDiagramNodePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

interface MarkdownNode {
  type: string;
  url?: unknown;
  identifier?: unknown;
  lang?: unknown;
  value?: unknown;
  children?: MarkdownNode[];
}

interface WalkthroughMarkdownAnalysis {
  referenceIds: string[];
  mermaidNodeIds: Set<string>;
}

const ISSUE_FETCH_CONCURRENCY = 8;
const REPOSITORY_COMMENT_PLACEMENT_CONCURRENCY = 8;

async function mapWithConcurrency<T, Result>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => await worker()),
  );
  return results;
}

const mermaidIdentifierPattern = /[A-Za-z][A-Za-z0-9_-]{0,63}/g;
const mermaidEdgePattern = /[<|o*x]*[-.=~]{2,}[|o*x>]*/g;
const mermaidKeywords = new Set([
  "class",
  "classDef",
  "classDiagram",
  "direction",
  "end",
  "flowchart",
  "graph",
  "linkStyle",
  "style",
  "subgraph",
]);

function mermaidIdentifiers(value: string): string[] {
  return [...value.matchAll(mermaidIdentifierPattern)]
    .map(([identifier]) => identifier)
    .filter((identifier) => !mermaidKeywords.has(identifier));
}

function mermaidLineWithoutLabels(value: string): string {
  const commentIndex = value.indexOf("%%");
  const uncommented = commentIndex === -1 ? value : value.slice(0, commentIndex);
  const withoutQuotedLabels = uncommented
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ")
    .replace(/\|[^|]*\|/g, " ")
    .replace(/--\s+[^-\n]+\s+-->/g, " -->")
    .replace(/-\.\s+[^.\n]+\s+\.->/g, " -.->")
    .replace(/==\s+[^=\n]+\s+==>/g, " ==>");
  let result = "";
  const closingDelimiters: string[] = [];
  const closingFor: Record<string, string> = { "[": "]", "(": ")", "{": "}" };
  for (const character of withoutQuotedLabels) {
    const expectedClosing = closingDelimiters.at(-1);
    if (expectedClosing) {
      if (Object.hasOwn(closingFor, character)) {
        closingDelimiters.push(closingFor[character]!);
      } else if (character === expectedClosing) {
        closingDelimiters.pop();
      }
      continue;
    }
    const closing = closingFor[character];
    if (closing) {
      closingDelimiters.push(closing);
      result += " ";
      continue;
    }
    result += character;
  }
  return result;
}

function addMermaidEdgeEndpoints(line: string, nodeIds: Set<string>): void {
  const edges = [...line.matchAll(mermaidEdgePattern)];
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]!;
    const edgeStart = edge.index;
    const edgeEnd = edgeStart + edge[0].length;
    const leftStart = index === 0 ? 0 : edges[index - 1]!.index + edges[index - 1]![0].length;
    const rightEnd = index + 1 === edges.length ? line.length : edges[index + 1]!.index;
    const left = line.slice(leftStart, edgeStart);
    const right = line.slice(edgeEnd, rightEnd);
    const leftIdentifiers = mermaidIdentifiers(left);
    const rightIdentifiers = mermaidIdentifiers(right);
    const leftEndpoints = left.includes("&") ? leftIdentifiers : leftIdentifiers.slice(-1);
    const rightEndpoints = right.includes("&") ? rightIdentifiers : rightIdentifiers.slice(0, 1);
    for (const identifier of [...leftEndpoints, ...rightEndpoints]) nodeIds.add(identifier);
  }
}

function addMermaidDiagramNodes(source: string, nodeIds: Set<string>): void {
  const lines = source.split("\n");
  const header = lines
    .map((line) => mermaidLineWithoutLabels(line).trim())
    .find((line) => line.length > 0);
  const diagramType = header?.match(/^(flowchart|graph|classDiagram)\b/)?.[1];
  if (!diagramType) return;

  for (const rawLine of lines) {
    for (const statement of mermaidLineWithoutLabels(rawLine).split(";")) {
      const line = statement.trim();
      if (!line || /^(flowchart|graph|classDiagram)\b/.test(line)) continue;
      addMermaidEdgeEndpoints(line, nodeIds);
      if (diagramType === "classDiagram") {
        const declaration = line.match(/^class\s+([A-Za-z][A-Za-z0-9_-]{0,63})\b/)?.[1];
        const memberOwner = line.match(/^([A-Za-z][A-Za-z0-9_-]{0,63})\s*:/)?.[1];
        const annotationTarget = line.match(/^<<[^>]+>>\s+([A-Za-z][A-Za-z0-9_-]{0,63})\b/)?.[1];
        for (const identifier of [declaration, memberOwner, annotationTarget]) {
          if (identifier) nodeIds.add(identifier);
        }
        continue;
      }
      if (mermaidEdgePattern.test(line)) {
        mermaidEdgePattern.lastIndex = 0;
        continue;
      }
      mermaidEdgePattern.lastIndex = 0;
      const standalone = line.match(
        /^([A-Za-z][A-Za-z0-9_-]{0,63})(?:\s*(?:::[A-Za-z][A-Za-z0-9_-]*)?\s*|\s*@\s*)$/,
      )?.[1];
      if (standalone) nodeIds.add(standalone);
    }
  }
}

function analyzeReferenceMarkdown(body: string): WalkthroughMarkdownAnalysis {
  const root = fromMarkdown(body) as MarkdownNode;
  const definitions = new Map<string, string>();
  const visit = (node: MarkdownNode, callback: (candidate: MarkdownNode) => void): void => {
    callback(node);
    node.children?.forEach((child) => visit(child, callback));
  };
  visit(root, (node) => {
    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      typeof node.url === "string"
    ) {
      definitions.set(node.identifier, node.url);
    }
  });
  const urls: string[] = [];
  const mermaidNodeIds = new Set<string>();
  visit(root, (node) => {
    if (node.type === "link" && typeof node.url === "string") urls.push(node.url);
    if (node.type === "linkReference" && typeof node.identifier === "string") {
      const url = definitions.get(node.identifier);
      if (url) urls.push(url);
    }
    if (node.type === "code" && node.lang === "mermaid" && typeof node.value === "string") {
      addMermaidDiagramNodes(node.value, mermaidNodeIds);
    }
  });
  return {
    referenceIds: urls
      .filter((url) => url.startsWith("rvw-ref:"))
      .map((url) => url.slice("rvw-ref:".length)),
    mermaidNodeIds,
  };
}

function assertCodeReferencePath(filePath: string): void {
  if (
    filePath.length > MAX_CODE_REFERENCE_PATH_CHARACTERS ||
    filePath.includes("\\") ||
    path.posix.isAbsolute(filePath) ||
    path.posix.normalize(filePath) !== filePath ||
    filePath === "." ||
    filePath.startsWith("../")
  ) {
    throw new RvwError("INVALID_INPUT", `code referenceのpathが不正です: ${filePath}`);
  }
}

function directIssueReferences(body: string, owner: string, repository: string): string[] {
  const references = new Set<string>();
  const escapedOwner = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const githubIssueDestinationPattern =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/([^/?#]+)(?:[/?#].*)?$/i;
  const collectTextReferences = (value: string): void => {
    const patterns = [
      new RegExp(
        `https://github\\.com/${escapedOwner}/${escapedRepository}/issues/(\\d+)(?=$|[/?#\\s<>()\\[\\]{}.,;:!?"'\\x60])`,
        "gi",
      ),
      new RegExp(`\\b${escapedOwner}/${escapedRepository}#(\\d+)\\b`, "gi"),
      /(^|[^\w/])#(\d+)\b/gm,
    ];
    for (const [index, pattern] of patterns.entries()) {
      for (const match of value.matchAll(pattern)) {
        const number = index === 2 ? match[2] : match[1];
        if (number) references.add(`#${number}`);
      }
    }
  };
  const collectUrlReference = (value: string): boolean => {
    const match = githubIssueDestinationPattern.exec(value);
    if (!match) return false;
    const [, linkedOwner, linkedRepository, issueSegment] = match;
    if (
      linkedOwner?.toLowerCase() === owner.toLowerCase() &&
      linkedRepository?.toLowerCase() === repository.toLowerCase() &&
      issueSegment &&
      /^\d+$/.test(issueSegment)
    ) {
      references.add(`#${issueSegment}`);
    }
    return true;
  };
  const root = fromMarkdown(body) as MarkdownNode;
  const definitionUrls = new Map<string, string>();
  const collectDefinitions = (node: MarkdownNode): void => {
    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      typeof node.url === "string"
    ) {
      definitionUrls.set(node.identifier.toLowerCase(), node.url);
    }
    node.children?.forEach(collectDefinitions);
  };
  collectDefinitions(root);
  const voidHtmlElements = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  let rawHtmlDepth = 0;
  const visit = (node: MarkdownNode): void => {
    if (node.type === "html" && typeof node.value === "string") {
      const html = node.value.trim();
      if (/^<\//.test(html)) {
        rawHtmlDepth = Math.max(0, rawHtmlDepth - 1);
      } else {
        const tag = /^<([A-Za-z][A-Za-z0-9-]*)\b[^>]*>$/.exec(html)?.[1]?.toLowerCase();
        if (
          tag &&
          !html.endsWith("/>") &&
          !html.includes(`</${tag}>`) &&
          !voidHtmlElements.has(tag)
        ) {
          rawHtmlDepth += 1;
        }
      }
      return;
    }
    if (
      rawHtmlDepth === 0 &&
      node.type === "linkReference" &&
      typeof node.identifier === "string" &&
      collectUrlReference(definitionUrls.get(node.identifier.toLowerCase()) ?? "")
    ) {
      return;
    }
    if (rawHtmlDepth === 0 && node.type === "text" && typeof node.value === "string") {
      collectTextReferences(node.value);
    } else if (
      rawHtmlDepth === 0 &&
      (node.type === "link" || node.type === "definition") &&
      typeof node.url === "string"
    ) {
      if (collectUrlReference(node.url)) return;
    }
    node.children?.forEach(visit);
  };
  visit(root);
  return [...references];
}

export class RvwService {
  private readonly repositoryLifecycle: RepositoryReviewLifecycle;

  constructor(
    readonly database: RvwDatabase,
    readonly git: GitClient,
    readonly github: GitHubPort,
  ) {
    this.repositoryLifecycle = new RepositoryReviewLifecycle(database, git, github);
  }

  async doctor(cwd: string): Promise<{
    ok: boolean;
    git: Awaited<ReturnType<GitClient["doctor"]>>;
    github: Awaited<ReturnType<GitHubPort["doctor"]>>;
    databasePath: string;
    databasePathSource: "default" | "configured";
    databasePathOverrideEnvironmentVariable: "RVW_DATABASE_PATH";
    databasePermissionsManagedByRvw: boolean;
    databasePermissions: ReturnType<RvwDatabase["permissionStatus"]>;
    databaseWriteProbe: ReturnType<RvwDatabase["writeProbe"]>;
    repositoryReviewRetainedRefs: {
      prefix: "refs/rvw/repository/";
      refs: Array<{
        ref: string;
        reviewId: string;
        oid: string;
        status: "current" | "referenced" | "unreferenced" | "orphan-review";
      }>;
    } | null;
  }> {
    const [git, github] = await Promise.all([this.git.doctor(cwd), this.github.doctor()]);
    if (git.repository) {
      const repositoryReview = this.database.findRepositoryReviewByGitCommonDir(
        git.repository.gitCommonDir,
      );
      if (repositoryReview) {
        const matchingRemote = await this.git.findBaseRepositoryIdentity(
          git.repository.worktreePath,
          repositoryReview.owner,
          repositoryReview.repository,
        );
        if (matchingRemote) git.selectedRemote = matchingRemote;
      }
    }
    const databaseWriteProbe = this.database.writeProbe();
    let repositoryReviewRetainedRefs: Awaited<
      ReturnType<RvwService["doctor"]>
    >["repositoryReviewRetainedRefs"] = null;
    if (git.repository) {
      const prefix = "refs/rvw/repository/" as const;
      const refs = await this.git.listRefsByPrefix(git.repository.worktreePath, prefix);
      const diagnostics: NonNullable<
        Awaited<ReturnType<RvwService["doctor"]>>["repositoryReviewRetainedRefs"]
      >["refs"] = [];
      const evidenceByReview = new Map<string, Set<string>>();
      for (const ref of refs) {
        const match = /^refs\/rvw\/repository\/([^/]+)\/commits\/oid-([^/]+)$/i.exec(ref);
        if (!match?.[1] || !match[2] || !GIT_OBJECT_ID_PATTERN.test(match[2])) continue;
        const review = this.database.getRepositoryReview(match[1]);
        if (!review) {
          diagnostics.push({ ref, reviewId: match[1], oid: match[2], status: "orphan-review" });
          continue;
        }
        let evidence = evidenceByReview.get(review.id);
        if (!evidence) {
          evidence = new Set(this.database.listRepositoryReviewEvidenceOids(review.id));
          evidenceByReview.set(review.id, evidence);
        }
        diagnostics.push({
          ref,
          reviewId: review.id,
          oid: match[2],
          status:
            review.sourceOid === match[2]
              ? "current"
              : evidence.has(match[2])
                ? "referenced"
                : "unreferenced",
        });
      }
      repositoryReviewRetainedRefs = {
        prefix,
        refs: diagnostics,
      };
    }
    return {
      ok: github.authenticated && databaseWriteProbe.ok,
      git,
      github,
      databasePath: this.database.filePath,
      databasePathSource: this.database.configuredPath ? "configured" : "default",
      databasePathOverrideEnvironmentVariable: "RVW_DATABASE_PATH",
      databasePermissionsManagedByRvw: !this.database.configuredPath,
      databasePermissions: this.database.permissionStatus(),
      databaseWriteProbe,
      repositoryReviewRetainedRefs,
    };
  }

  private localPullRequestForOpen(
    reference: string | undefined,
    repository: RepositoryContext,
  ): PullRequest | null {
    if (reference && /^https:\/\/github\.com\//.test(reference)) {
      const parsed = parsePullRequestUrl(reference);
      return this.database.findPullRequestByIdentity(
        parsed.owner,
        parsed.repository,
        parsed.number,
      );
    }
    const local = this.database.findPullRequestsByGitCommonDir(repository.gitCommonDir);
    if (reference && /^\d+$/.test(reference)) {
      return local.find((candidate) => candidate.number === Number(reference)) ?? null;
    }
    return reference === undefined && local.length === 1 ? (local[0] ?? null) : null;
  }

  private async repositoryMatches(
    pullRequest: PullRequest,
    repository: RepositoryContext,
  ): Promise<boolean> {
    let registeredGitCommonDir = path.resolve(pullRequest.gitCommonDir);
    try {
      registeredGitCommonDir = await realpath(registeredGitCommonDir);
    } catch {
      // Preserve the existing mismatch behavior when a saved clone no longer exists.
    }
    return registeredGitCommonDir === path.resolve(repository.gitCommonDir);
  }

  private async assertRepositoryMatch(
    pullRequest: PullRequest,
    repository: RepositoryContext,
  ): Promise<void> {
    if (!(await this.repositoryMatches(pullRequest, repository))) {
      throw new RvwError(
        "REPOSITORY_MISMATCH",
        "このPull Requestは別の独立cloneへすでに登録されています。",
        {
          suggestions: [
            `${pullRequest.localRepositoryPath} または同じrepositoryのworktreeから開いてください。`,
          ],
        },
      );
    }
  }

  async openPullRequest(reference: string | undefined, cwd: string): Promise<OpenResult> {
    let cwdRepository: RepositoryContext | null = null;
    try {
      cwdRepository = await this.git.repositoryContext(cwd);
    } catch (error) {
      if (!(error instanceof RvwError) || error.code !== "NOT_IN_GIT_REPOSITORY") throw error;
    }
    let explicitlyStored = cwdRepository
      ? this.localPullRequestForOpen(reference, cwdRepository)
      : null;
    if (reference && !explicitlyStored && !cwdRepository) {
      try {
        explicitlyStored = this.resolveStoredPullRequest(reference);
      } catch (error) {
        if (!(error instanceof RvwError) || error.code !== "PR_NOT_FOUND") throw error;
      }
    }
    const repository = explicitlyStored
      ? cwdRepository && (await this.repositoryMatches(explicitlyStored, cwdRepository))
        ? cwdRepository
        : await this.repositoryFor(explicitlyStored)
      : cwdRepository;
    if (!repository) {
      throw new RvwError(
        "NOT_IN_GIT_REPOSITORY",
        `${cwd} はGit repositoryではなく、指定されたPull Requestもローカルrvwへ登録されていません。`,
        { suggestions: ["登録済みのPR URLを指定するか、対象repositoryで実行してください。"] },
      );
    }
    const stored = explicitlyStored ?? this.localPullRequestForOpen(reference, repository);
    if (stored) {
      await this.assertRepositoryMatch(stored, repository);
      if (await this.git.hasObject(repository.worktreePath, stored.latestHeadOid)) {
        await this.git.ensureCommitRef(
          repository.worktreePath,
          stored.number,
          stored.latestHeadOid,
        );
        const locationChanged =
          path.resolve(stored.localRepositoryPath) !== path.resolve(repository.worktreePath) ||
          path.resolve(stored.gitCommonDir) !== path.resolve(repository.gitCommonDir);
        return {
          pullRequest: locationChanged
            ? this.database.updateRepositoryLocation(stored.id, {
                localRepositoryPath: repository.worktreePath,
                gitCommonDir: repository.gitCommonDir,
              })
            : stored,
          fromCache: true,
        };
      }
    }

    const github = await this.github.getPullRequest(reference, repository.worktreePath);
    const existing = this.database.findPullRequestByIdentity(
      github.owner,
      github.repository,
      github.number,
    );
    if (existing) await this.assertRepositoryMatch(existing, repository);
    const { pullRequest } = await this.synchronizeGithub(github, repository, []);
    return { pullRequest, fromCache: false };
  }

  getRepositoryReview(id: string): RepositoryReview {
    const review = this.database.getRepositoryReview(id);
    if (!review) {
      throw new RvwError("REPOSITORY_REVIEW_NOT_FOUND", "Repository Reviewが見つかりません。", {
        status: 404,
      });
    }
    return review;
  }

  resolveStoredRepositoryReview(repository: string): RepositoryReview {
    const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repository.trim());
    const review =
      match?.[1] && match[2]
        ? this.database.findRepositoryReviewByIdentity(match[1], match[2])
        : null;
    if (!review) {
      throw new RvwError("REPOSITORY_REVIEW_NOT_FOUND", "Repository Reviewが見つかりません。", {
        status: 404,
        suggestions: ["対象repositoryで rvw repository open を実行してください。"],
      });
    }
    return review;
  }

  private async resolveBoundRepositoryArtifactContext(
    repositoryReview: RepositoryReview,
    capability: "local-artifact" | "remote-mutation" = "local-artifact",
  ): Promise<ResolvedRepositoryReview> {
    return await this.repositoryLifecycle.resolveExistingAtPath(
      repositoryReview.localRepositoryPath,
      {
        policy: capability === "remote-mutation" ? { kind: "remote-required" } : { kind: "read" },
        expectedRepositoryReviewId: repositoryReview.id,
      },
    );
  }

  private async repositoryContextFor(
    repositoryReview: RepositoryReview,
  ): Promise<RepositoryContext> {
    return (await this.resolveBoundRepositoryArtifactContext(repositoryReview)).repository;
  }

  private repositoryReviewWriteContext(
    resolved: ResolvedRepositoryReview,
  ): RepositoryReviewWriteContext {
    return {
      repositoryReviewId: resolved.repositoryReview.id,
      expectedGitCommonDir: resolved.repository.gitCommonDir,
    };
  }

  async openRepositoryReview(cwd: string): Promise<OpenRepositoryResult> {
    return await this.repositoryLifecycle.openAtPath(cwd);
  }

  async getRepositoryRelocationPreview(
    repositoryPath: string,
  ): Promise<RepositoryRelocationPreview> {
    const resolved = await this.repositoryLifecycle.resolveRelocationCandidate(repositoryPath);
    return this.repositoryRelocationPreview(resolved);
  }

  private repositoryRelocationPreview(
    resolved: ResolvedRepositoryRelocation,
  ): RepositoryRelocationPreview {
    const { repositoryReview, repository, remoteIdentity, relocationEvidence } = resolved;
    if (!remoteIdentity) {
      throw new RvwError("REPOSITORY_MISMATCH", "relocation remote identityを確認できません。");
    }
    const reviewChangeSequence = this.database.getReviewChangeSequence(
      "repository",
      repositoryReview.id,
    );
    const previousLocation = {
      localRepositoryPath: repositoryReview.localRepositoryPath,
      gitCommonDir: repositoryReview.gitCommonDir,
    };
    const candidateLocation = {
      localRepositoryPath: repository.worktreePath,
      gitCommonDir: repository.gitCommonDir,
    };
    return {
      repositoryReview,
      previousLocation,
      candidateLocation,
      selectedRemote: { name: remoteIdentity.remoteName, url: remoteIdentity.remoteUrl },
      sourceOid: repositoryReview.sourceOid,
      ...relocationEvidence,
      reviewChangeSequence,
      confirmationToken: destructiveConfirmationToken({
        operation: "repository-relocate",
        reviewKind: "repository",
        reviewId: repositoryReview.id,
        reviewChangeSequence,
        counts: {
          previousLocation,
          candidateLocation,
          sourceOid: repositoryReview.sourceOid,
          ...relocationEvidence,
        },
      }),
      confirmationRequired: true,
    };
  }

  async relocateRepositoryReviewAtPath(
    repositoryPath: string,
    confirmationToken: string,
  ): Promise<{
    repositoryReview: RepositoryReview;
    previousLocation: RepositoryRelocationPreview["previousLocation"];
    candidateLocation: RepositoryRelocationPreview["candidateLocation"];
    selectedRemote: RepositoryRelocationPreview["selectedRemote"];
  }> {
    const resolved = await this.repositoryLifecycle.resolveRelocationCandidate(repositoryPath);
    const preview = this.repositoryRelocationPreview(resolved);
    assertDestructiveConfirmation(confirmationToken, preview);
    let repositoryReview: RepositoryReview;
    try {
      repositoryReview = this.database.relocateRepositoryReview(
        preview.repositoryReview.id,
        {
          ...preview.previousLocation,
          reviewChangeSequence: preview.reviewChangeSequence,
        },
        preview.candidateLocation,
      );
    } catch (error) {
      if (asRvwError(error).code === "DESTRUCTIVE_PREVIEW_STALE") {
        let currentPreview: RepositoryRelocationPreview | null = null;
        try {
          currentPreview = this.repositoryRelocationPreview(
            await this.repositoryLifecycle.resolveRelocationCandidate(repositoryPath),
          );
        } catch {
          // Preserve the final-CAS error when the candidate binding changed too far to preview.
        }
        if (currentPreview) {
          throw destructiveStaleErrorWithCurrentPreview(error, currentPreview);
        }
      }
      throw error;
    }
    return {
      repositoryReview,
      previousLocation: preview.previousLocation,
      candidateLocation: preview.candidateLocation,
      selectedRemote: preview.selectedRemote,
    };
  }

  async getRepositoryForgetPreviewAtPath(repositoryPath: string): Promise<RepositoryForgetPreview> {
    const resolved = await this.repositoryLifecycle.resolveForgetCandidate(repositoryPath);
    return this.repositoryForgetPreview(resolved);
  }

  private repositoryForgetPreview(resolved: ResolvedRepositoryForget): RepositoryForgetPreview {
    const { repositoryReview, repository, remoteIdentity, registeredBinding, refPrefix } = resolved;
    const counts = this.database.getRepositoryForgetCounts(repositoryReview.id);
    const reviewChangeSequence = this.database.getReviewChangeSequence(
      "repository",
      repositoryReview.id,
    );
    const registeredLocation = {
      localRepositoryPath: repositoryReview.localRepositoryPath,
      gitCommonDir: repositoryReview.gitCommonDir,
    };
    const candidateLocation = {
      localRepositoryPath: repository.worktreePath,
      gitCommonDir: repository.gitCommonDir,
    };
    const selectedRemote = { name: remoteIdentity.remoteName, url: remoteIdentity.remoteUrl };
    return {
      repositoryReview,
      counts,
      registeredLocation,
      candidateLocation,
      selectedRemote,
      registeredBinding,
      refPrefix,
      reviewChangeSequence,
      confirmationToken: destructiveConfirmationToken({
        operation: "repository-forget",
        reviewKind: "repository",
        reviewId: repositoryReview.id,
        reviewChangeSequence,
        counts: {
          artifacts: counts,
          registeredLocation,
          candidateLocation,
          selectedRemote,
          registeredBinding,
          refPrefix,
        },
      }),
      confirmationRequired: true,
    };
  }

  async forgetRepositoryReviewAtPath(
    repositoryPath: string,
    confirmationToken: string,
  ): Promise<{
    repositoryReview: RepositoryReview;
    deleted: RepositoryForgetCounts;
    candidateLocation: RepositoryForgetPreview["candidateLocation"];
    outcome: {
      kind: "completed-with-unreachable-orphan-refs";
      repositoryReviewDeleted: true;
      registeredRepositoryPath: string;
      registeredGitCommonDir: string;
      refPrefix: string;
      remainingRefs: null;
      cleanupAvailable: false;
    };
  }> {
    const resolved = await this.repositoryLifecycle.resolveForgetCandidate(repositoryPath);
    const preview = this.repositoryForgetPreview(resolved);
    assertDestructiveConfirmation(confirmationToken, preview);
    let deleted: RepositoryForgetCounts;
    try {
      deleted = this.database.forgetRepositoryReview(
        preview.repositoryReview.id,
        preview.reviewChangeSequence,
      );
    } catch (error) {
      if (asRvwError(error).code === "DESTRUCTIVE_PREVIEW_STALE") {
        const currentPreview = await this.repositoryLifecycle
          .resolveForgetCandidate(repositoryPath)
          .then((current) => this.repositoryForgetPreview(current))
          .catch(() => null);
        if (currentPreview) {
          throw destructiveStaleErrorWithCurrentPreview(error, currentPreview);
        }
      }
      throw error;
    }
    return {
      repositoryReview: preview.repositoryReview,
      deleted,
      candidateLocation: preview.candidateLocation,
      outcome: {
        kind: "completed-with-unreachable-orphan-refs",
        repositoryReviewDeleted: true,
        registeredRepositoryPath: preview.registeredLocation.localRepositoryPath,
        registeredGitCommonDir: preview.registeredLocation.gitCommonDir,
        refPrefix: preview.refPrefix,
        remainingRefs: null,
        cleanupAvailable: false,
      },
    };
  }

  async resolveExistingRepositoryReviewAtPath(
    repositoryPath: string,
  ): Promise<ResolvedRepositoryReview> {
    return await this.repositoryLifecycle.resolveExistingAtPath(repositoryPath, {
      policy: { kind: "read" },
    });
  }

  getRepositoryReviewView(id: string): RepositoryReviewView {
    const repositoryReview = this.getRepositoryReview(id);
    return {
      repositoryReview,
      issues: this.database.listReviewIssues("repository", id),
      walkthroughs: this.database.listRepositoryWalkthroughs(id),
    };
  }

  async getBoundRepositoryReviewView(id: string): Promise<RepositoryReviewView> {
    const stored = this.getRepositoryReview(id);
    const resolved = await this.repositoryLifecycle.resolveExistingAtPath(
      stored.localRepositoryPath,
      {
        policy: { kind: "read" },
        expectedRepositoryReviewId: id,
      },
    );
    return {
      ...this.getRepositoryReviewView(id),
      selectedRemote: resolved.remoteIdentity
        ? { name: resolved.remoteIdentity.remoteName, url: resolved.remoteIdentity.remoteUrl }
        : null,
    };
  }

  private async synchronizeResolvedRepositoryReview(
    existing: ResolvedRepositoryReview,
  ): Promise<RepositorySyncResult> {
    const synchronized = await this.repositoryLifecycle.synchronizeExisting(
      existing.repository.worktreePath,
      existing.repositoryReview.id,
    );
    const { repositoryReview } = synchronized;
    const issues = this.database.listReviewIssues("repository", repositoryReview.id);
    const issueResults = await mapWithConcurrency(
      issues,
      ISSUE_FETCH_CONCURRENCY,
      async (issue): Promise<RepositorySyncResult["issueResults"][number]> => {
        const expectedCacheGeneration = this.database.getIssueCacheGeneration(issue.id);
        try {
          const current = assertFetchedIssueIdentity(
            {
              owner: repositoryReview.owner,
              repository: repositoryReview.repository,
              number: issue.number,
            },
            await this.github.getIssue(
              issue.number,
              repositoryReview,
              synchronized.repository.worktreePath,
            ),
          );
          const refreshed = this.database.refreshReviewIssue(
            "repository",
            repositoryReview.id,
            issue.id,
            current,
          );
          return refreshed.skipped
            ? { issue: refreshed.issue ?? issue, ok: true, skipped: refreshed.skipped }
            : { issue: refreshed.issue!, ok: true };
        } catch (error) {
          const rvwError = asRvwError(error);
          if (rvwError.code === "REPOSITORY_REVIEW_NOT_FOUND") throw rvwError;
          if (isIssueIdentityMismatch(rvwError)) {
            if (!this.database.hasReviewIssue("repository", repositoryReview.id, issue.id)) {
              return { issue, ok: true, skipped: "membership-removed" };
            }
            return { issue, ok: false, error: rvwError.toJSON() };
          }
          const syncError = this.database.setReviewIssueSyncError(
            "repository",
            repositoryReview.id,
            issue.id,
            expectedCacheGeneration,
            rvwError.message,
          );
          if (syncError.skipped) {
            return { issue: syncError.issue ?? issue, ok: true, skipped: syncError.skipped };
          }
          const stale = syncError.issue ?? issue;
          return { issue: stale, ok: false, error: rvwError.toJSON() };
        }
      },
    );
    return {
      ...this.getRepositoryReviewView(repositoryReview.id),
      selectedRemote: synchronized.remoteIdentity
        ? {
            name: synchronized.remoteIdentity.remoteName,
            url: synchronized.remoteIdentity.remoteUrl,
          }
        : null,
      issueResults,
    };
  }

  async syncRepositoryReview(repositoryPath: string): Promise<RepositorySyncResult> {
    const existing = await this.repositoryLifecycle.resolveExistingAtPath(repositoryPath, {
      policy: { kind: "remote-required" },
    });
    return await this.synchronizeResolvedRepositoryReview(existing);
  }

  async syncRepositoryReviewById(repositoryReviewId: string): Promise<RepositorySyncResult> {
    const repositoryReview = this.getRepositoryReview(repositoryReviewId);
    const existing = await this.repositoryLifecycle.resolveExistingAtPath(
      repositoryReview.localRepositoryPath,
      {
        policy: { kind: "remote-required" },
        expectedRepositoryReviewId: repositoryReviewId,
      },
    );
    return await this.synchronizeResolvedRepositoryReview(existing);
  }

  private async addIssueToContext(
    review:
      | { kind: "pull-request"; value: PullRequest }
      | { kind: "repository"; value: RepositoryReview },
    reference: string,
  ): Promise<{ issue: IssueDocument; added: boolean }> {
    const identity = parseIssueReference(reference, review.value);
    if (
      identity.owner.toLowerCase() !== review.value.owner.toLowerCase() ||
      identity.repository.toLowerCase() !== review.value.repository.toLowerCase()
    ) {
      throw new RvwError("INVALID_INPUT", "cross-repository Issueは追加できません。");
    }
    const issue = assertFetchedIssueIdentity(
      identity,
      await this.github.getIssue(
        identity.number,
        {
          host: "github.com",
          owner: review.value.owner,
          repository: review.value.repository,
          canonicalName: `${review.value.owner}/${review.value.repository}`,
        },
        review.value.localRepositoryPath,
      ),
    );
    return this.database.addReviewIssue(review.kind, review.value.id, issue);
  }

  async addPullRequestIssue(
    pullRequestReference: string,
    issueReference: string,
  ): Promise<{ issue: IssueDocument; added: boolean }> {
    return await this.addIssueToContext(
      { kind: "pull-request", value: this.resolveStoredPullRequest(pullRequestReference) },
      issueReference,
    );
  }

  private async forceRepairIssue(
    reviewKind: "pull-request" | "repository",
    review: PullRequest | RepositoryReview,
    issueReference: string,
    repositoryPath: string,
  ): Promise<{ issue: IssueDocument; repaired: true; verifiedReads: 2 }> {
    const identity = parseIssueReference(issueReference, review);
    const cached = this.database.findIssue(identity.owner, identity.repository, identity.number);
    if (!cached || !this.database.hasReviewIssue(reviewKind, review.id, cached.id)) {
      throw new RvwError("ISSUE_NOT_FOUND", "このreviewにIssueが登録されていません。", {
        status: 404,
      });
    }
    const expectedCacheGeneration = this.database.getIssueCacheGeneration(cached.id);
    const target = {
      host: "github.com" as const,
      owner: review.owner,
      repository: review.repository,
      canonicalName: `${review.owner}/${review.repository}`,
    };
    const first = assertFetchedIssueIdentity(
      identity,
      await this.github.getIssue(identity.number, target, repositoryPath),
    );
    const second = assertFetchedIssueIdentity(
      identity,
      await this.github.getIssue(identity.number, target, repositoryPath),
    );
    if (issueRepairSnapshot(first) !== issueRepairSnapshot(second)) {
      throw new RvwError(
        "GITHUB_ISSUE_ERROR",
        "GitHub Issue snapshotが連続した二回の取得で一致しないためrepairを中止しました。",
        { details: { reason: "ISSUE_REPAIR_SNAPSHOT_UNSTABLE", number: identity.number } },
      );
    }
    return {
      issue: this.database.forceRepairReviewIssue(
        reviewKind,
        review.id,
        cached.id,
        expectedCacheGeneration,
        second,
      ),
      repaired: true,
      verifiedReads: 2,
    };
  }

  async forceRepairPullRequestIssue(
    pullRequestReference: string,
    issueReference: string,
  ): Promise<{ issue: IssueDocument; repaired: true; verifiedReads: 2 }> {
    const pullRequest = this.resolveStoredPullRequest(pullRequestReference);
    const repository = await this.repositoryFor(pullRequest);
    return await this.forceRepairIssue(
      "pull-request",
      pullRequest,
      issueReference,
      repository.worktreePath,
    );
  }

  async forceRepairRepositoryIssue(
    repositoryPath: string,
    issueReference: string,
  ): Promise<{ issue: IssueDocument; repaired: true; verifiedReads: 2 }> {
    const resolved = await this.repositoryLifecycle.resolveExistingAtPath(repositoryPath, {
      policy: { kind: "remote-required" },
    });
    return await this.forceRepairIssue(
      "repository",
      resolved.repositoryReview,
      issueReference,
      resolved.repository.worktreePath,
    );
  }

  async addRepositoryIssue(
    repositoryPath: string,
    issueReference: string,
  ): Promise<{ repositoryReview: RepositoryReview; issue: IssueDocument; added: boolean }> {
    const repositoryReview =
      await this.repositoryLifecycle.resolveOrCreateForIssueAddition(repositoryPath);
    const result = await this.addIssueToContext(
      { kind: "repository", value: repositoryReview },
      issueReference,
    );
    return { repositoryReview, ...result };
  }

  async addRepositoryIssueById(
    repositoryReviewId: string,
    issueReference: string,
  ): Promise<{ repositoryReview: RepositoryReview; issue: IssueDocument; added: boolean }> {
    const stored = this.getRepositoryReview(repositoryReviewId);
    const { repositoryReview } = await this.repositoryLifecycle.resolveExistingAtPath(
      stored.localRepositoryPath,
      {
        policy: { kind: "remote-required" },
        expectedRepositoryReviewId: repositoryReviewId,
      },
    );
    const result = await this.addIssueToContext(
      { kind: "repository", value: repositoryReview },
      issueReference,
    );
    return { repositoryReview: this.getRepositoryReview(repositoryReviewId), ...result };
  }

  listPullRequestIssues(pullRequestId: string): IssueDocument[] {
    this.getPullRequest(pullRequestId);
    return this.database.listReviewIssues("pull-request", pullRequestId);
  }

  listRepositoryIssues(repositoryReviewId: string): IssueDocument[] {
    this.getRepositoryReview(repositoryReviewId);
    return this.database.listReviewIssues("repository", repositoryReviewId);
  }

  getReviewIssue(
    reviewKind: "pull-request" | "repository",
    reviewId: string,
    issueId: string,
  ): IssueDocument {
    if (reviewKind === "pull-request") this.getPullRequest(reviewId);
    else this.getRepositoryReview(reviewId);
    const issue = this.database.getReviewIssue(reviewKind, reviewId, issueId);
    if (!issue) {
      throw new RvwError("ISSUE_NOT_FOUND", "Issue documentが見つかりません。", { status: 404 });
    }
    return issue;
  }

  getIssueRemovalPreview(
    reviewKind: "pull-request" | "repository",
    reviewId: string,
    issueReference: string,
  ): {
    issue: IssueDocument;
    counts: IssueRemovalCounts;
    reviewChangeSequence: number;
    confirmationToken: string;
    confirmationRequired: true;
  } {
    const review =
      reviewKind === "pull-request"
        ? this.getPullRequest(reviewId)
        : this.getRepositoryReview(reviewId);
    const identity = parseIssueReference(issueReference, review);
    const cached = this.database.findIssue(identity.owner, identity.repository, identity.number);
    const issue = cached ? this.database.getReviewIssue(reviewKind, reviewId, cached.id) : null;
    if (!issue) {
      throw new RvwError("ISSUE_NOT_FOUND", "このreviewにIssueが登録されていません。", {
        status: 404,
      });
    }
    const counts = this.database.getIssueRemovalCounts(reviewKind, reviewId, issue.id);
    const reviewChangeSequence = this.database.getReviewChangeSequence(reviewKind, reviewId);
    return {
      issue,
      counts,
      reviewChangeSequence,
      confirmationToken: destructiveConfirmationToken({
        operation: "issue-remove",
        reviewKind,
        reviewId,
        reviewChangeSequence,
        subjectId: issue.id,
        counts,
      }),
      confirmationRequired: true,
    };
  }

  private removeReviewIssueWithPreview(
    reviewKind: "pull-request" | "repository",
    reviewId: string,
    issueReference: string,
    preview: ReturnType<RvwService["getIssueRemovalPreview"]>,
  ): IssueRemovalCounts {
    try {
      return this.database.removeReviewIssue(
        reviewKind,
        reviewId,
        preview.issue.id,
        preview.reviewChangeSequence,
      );
    } catch (error) {
      if (asRvwError(error).code === "DESTRUCTIVE_PREVIEW_STALE") {
        throw destructiveStaleErrorWithCurrentPreview(
          error,
          this.getIssueRemovalPreview(reviewKind, reviewId, issueReference),
        );
      }
      throw error;
    }
  }

  removePullRequestIssue(
    pullRequestReference: string,
    issueReference: string,
    confirmationToken: string,
  ): {
    pullRequest: PullRequest;
    issue: IssueDocument;
    deleted: IssueRemovalCounts;
  } {
    const pullRequest = this.resolveStoredPullRequest(pullRequestReference);
    const preview = this.getIssueRemovalPreview("pull-request", pullRequest.id, issueReference);
    assertDestructiveConfirmation(confirmationToken, preview);
    return {
      pullRequest,
      issue: preview.issue,
      deleted: this.removeReviewIssueWithPreview(
        "pull-request",
        pullRequest.id,
        issueReference,
        preview,
      ),
    };
  }

  async removeRepositoryIssue(
    repositoryPath: string,
    issueReference: string,
    confirmationToken: string,
  ): Promise<{
    repositoryReview: RepositoryReview;
    issue: IssueDocument;
    deleted: IssueRemovalCounts;
  }> {
    const { repositoryReview } = await this.repositoryLifecycle.resolveExistingAtPath(
      repositoryPath,
      {
        policy: { kind: "issue-removal" },
      },
    );
    const preview = this.getIssueRemovalPreview("repository", repositoryReview.id, issueReference);
    assertDestructiveConfirmation(confirmationToken, preview);
    return {
      repositoryReview,
      issue: preview.issue,
      deleted: this.removeReviewIssueWithPreview(
        "repository",
        repositoryReview.id,
        issueReference,
        preview,
      ),
    };
  }

  async removeRepositoryIssueById(
    repositoryReviewId: string,
    issueReference: string,
    confirmationToken: string,
  ): Promise<{
    repositoryReview: RepositoryReview;
    issue: IssueDocument;
    deleted: IssueRemovalCounts;
  }> {
    const stored = this.getRepositoryReview(repositoryReviewId);
    const { repositoryReview } = await this.repositoryLifecycle.resolveExistingAtPath(
      stored.localRepositoryPath,
      {
        policy: { kind: "issue-removal" },
        expectedRepositoryReviewId: repositoryReviewId,
      },
    );
    const preview = this.getIssueRemovalPreview("repository", repositoryReview.id, issueReference);
    assertDestructiveConfirmation(confirmationToken, preview);
    const deleted = this.removeReviewIssueWithPreview(
      "repository",
      repositoryReview.id,
      issueReference,
      preview,
    );
    return {
      repositoryReview: this.getRepositoryReview(repositoryReviewId),
      issue: preview.issue,
      deleted,
    };
  }

  async getRepositoryIssueRemovalPreview(
    repositoryPath: string,
    issueReference: string,
  ): Promise<ReturnType<RvwService["getIssueRemovalPreview"]>> {
    const { repositoryReview } = await this.repositoryLifecycle.resolveExistingAtPath(
      repositoryPath,
      {
        policy: { kind: "issue-removal" },
      },
    );
    return this.getIssueRemovalPreview("repository", repositoryReview.id, issueReference);
  }

  async getRepositoryIssueRemovalPreviewById(
    repositoryReviewId: string,
    issueReference: string,
  ): Promise<ReturnType<RvwService["getIssueRemovalPreview"]>> {
    const stored = this.getRepositoryReview(repositoryReviewId);
    const { repositoryReview } = await this.repositoryLifecycle.resolveExistingAtPath(
      stored.localRepositoryPath,
      {
        policy: { kind: "issue-removal" },
        expectedRepositoryReviewId: repositoryReviewId,
      },
    );
    return this.getIssueRemovalPreview("repository", repositoryReview.id, issueReference);
  }

  async listRepositoryCommentContextsAtPath(
    repositoryPath: string,
    resolved?: boolean,
  ): Promise<{
    context: { kind: "repository"; repositoryReviewId: string; repository: string };
    repositoryReview: RepositoryReview;
    comments: Array<{ comment: RepositoryReviewComment; latestPlacement: CommentPlacement }>;
  }> {
    const { repositoryReview, repository } = await this.repositoryLifecycle.resolveExistingAtPath(
      repositoryPath,
      {
        policy: { kind: "read" },
      },
    );
    return {
      context: {
        kind: "repository",
        repositoryReviewId: repositoryReview.id,
        repository: repositoryReview.canonicalName,
      },
      repositoryReview,
      comments: await this.listRepositoryCommentContexts(repositoryReview.id, resolved, repository),
    };
  }

  async listRepositoryCommentContextsById(
    repositoryReviewId: string,
    resolved?: boolean,
  ): Promise<Array<{ comment: RepositoryReviewComment; latestPlacement: CommentPlacement }>> {
    const stored = this.getRepositoryReview(repositoryReviewId);
    const { repository } = await this.repositoryLifecycle.resolveExistingAtPath(
      stored.localRepositoryPath,
      {
        policy: { kind: "read" },
        expectedRepositoryReviewId: repositoryReviewId,
      },
    );
    const comments = await this.listRepositoryCommentContexts(
      repositoryReviewId,
      resolved,
      repository,
    );
    this.getRepositoryReview(repositoryReviewId);
    return comments;
  }

  getPullRequest(id: string): PullRequest {
    const pullRequest = this.database.getPullRequest(id);
    if (!pullRequest)
      throw new RvwError("PR_NOT_FOUND", "Pull Requestが見つかりません。", { status: 404 });
    return pullRequest;
  }

  resolveStoredPullRequest(reference: string): PullRequest {
    if (/^https:\/\/github\.com\//.test(reference)) {
      const parsed = parsePullRequestUrl(reference);
      const pullRequest = this.database.findPullRequestByIdentity(
        parsed.owner,
        parsed.repository,
        parsed.number,
      );
      if (pullRequest) return pullRequest;
    } else if (/^\d+$/.test(reference)) {
      const number = Number(reference);
      const matches = this.database.listPullRequests().filter((item) => item.number === number);
      if (matches.length === 1 && matches[0]) return matches[0];
    }
    throw new RvwError("PR_NOT_FOUND", "ローカルrvwへ登録済みのPull Requestが見つかりません。", {
      suggestions: [`対象repositoryで rvw open ${reference} を実行してください。`],
      status: 404,
    });
  }

  private async repositoryFor(pullRequest: PullRequest): Promise<RepositoryContext> {
    const repository = await this.git.repositoryContext(pullRequest.localRepositoryPath);
    await this.assertRepositoryMatch(pullRequest, repository);
    return repository;
  }

  private prepareCommentUpdates(
    pullRequestId: string,
    requestedUpdates: CommentUpdateRequest[],
  ): CommentUpdateInput[] {
    return requestedUpdates.map((update) => {
      const commentId = parseCommentUri(update.commentRef);
      const comment = this.database.getComment(commentId);
      if (!comment || comment.pullRequestId !== pullRequestId) {
        throw new RvwError(
          "COMMENT_NOT_FOUND",
          `コメントがこのPull Requestに存在しません: ${update.commentRef}`,
        );
      }
      if (!update.reply.trim() && !update.resolve) {
        throw new RvwError(
          "INVALID_INPUT",
          `commentUpdatesにはreplyまたはresolveが必要です: ${update.commentRef}`,
        );
      }
      if (!update.reply.trim() && (update.references?.length ?? 0) > 0) {
        throw new RvwError(
          "INVALID_INPUT",
          `replyのないcomment updateへcode referenceは追加できません: ${update.commentRef}`,
        );
      }
      if (update.reply.trim()) assertTextBody(update.reply);
      assertAuthorLabel(update.authorLabel);
      assertIdempotencyKey(update.idempotencyKey);
      const authorLabel = update.authorLabel ?? "Agent";
      return {
        commentId,
        reply: update.reply,
        resolve: update.resolve,
        lastModifiedBy: "agent",
        ...(update.references === undefined ? {} : { references: update.references }),
        ...(update.authorLabel === undefined ? {} : { authorLabel: update.authorLabel }),
        ...(update.idempotencyKey === undefined ? {} : { idempotencyKey: update.idempotencyKey }),
        ...(update.idempotencyKey === undefined
          ? {}
          : {
              idempotencyRequestHash: idempotencyRequestHash({
                operation: "pr.sync.comment-update",
                commentId,
                reply: update.reply,
                resolve: update.resolve,
                authorLabel,
                references: update.references ?? [],
              }),
            }),
      };
    });
  }

  private async synchronizeGithub(
    github: Awaited<ReturnType<GitHubPort["getPullRequest"]>>,
    repository: RepositoryContext,
    updates: CommentUpdateInput[],
  ): Promise<{ pullRequest: PullRequest; issueResults: IssueSyncResult[] }> {
    const remoteUrl = await this.git.assertBaseRepository(
      repository.worktreePath,
      github.owner,
      github.repository,
    );
    await this.git.ensurePullRequestObjects({
      cwd: repository.worktreePath,
      remoteUrl,
      number: github.number,
      baseRefName: github.baseRefName,
      baseOid: github.baseOid,
      headOid: github.headOid,
    });
    const comparisonBaseOid = await this.git.mergeBase(
      repository.worktreePath,
      github.baseOid,
      github.headOid,
    );
    await this.git.ensureCommitRef(repository.worktreePath, github.number, github.headOid);
    for (const update of updates) {
      if (!update.reply.trim()) continue;
      const comment = this.database.getComment(update.commentId);
      if (!comment) {
        throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
      }
      await this.validateCodeReferences(this.getPullRequest(comment.pullRequestId), {
        sourceOid: github.headOid,
        body: update.reply,
        references: update.references ?? [],
        subject: "comment sync reply",
      });
    }
    const repositoryLocation = {
      localRepositoryPath: repository.worktreePath,
      gitCommonDir: repository.gitCommonDir,
    };
    const pullRequest =
      updates.length > 0
        ? this.database.syncPullRequestAndComments(
            github,
            repositoryLocation,
            comparisonBaseOid,
            updates,
          )
        : this.database.upsertPullRequest(github, repositoryLocation, comparisonBaseOid);
    const issueResults: IssueSyncResult[] = [];
    const getIssue = this.github.getIssue.bind(this.github);
    const issueRequests: Array<{
      reference: string;
      number: number;
      previous: IssueDocument | null;
      operation: "add" | "refresh";
    }> = [];
    const fetchedIssueNumbers = new Set<number>();
    for (const reference of directIssueReferences(github.body, github.owner, github.repository)) {
      const identity = parseIssueReference(reference, pullRequest);
      fetchedIssueNumbers.add(identity.number);
      const cached = this.database.findIssue(
        pullRequest.owner,
        pullRequest.repository,
        identity.number,
      );
      issueRequests.push({
        reference,
        number: identity.number,
        previous: cached
          ? this.database.getReviewIssue("pull-request", pullRequest.id, cached.id)
          : null,
        operation: "add",
      });
    }
    for (const cached of this.database.listReviewIssues("pull-request", pullRequest.id)) {
      if (fetchedIssueNumbers.has(cached.number)) continue;
      issueRequests.push({
        reference: cached.url,
        number: cached.number,
        previous: cached,
        operation: "refresh",
      });
    }
    issueResults.push(
      ...(await mapWithConcurrency(
        issueRequests,
        ISSUE_FETCH_CONCURRENCY,
        async ({ reference, number, previous, operation }): Promise<IssueSyncResult> => {
          const expectedCacheGeneration = previous
            ? this.database.getIssueCacheGeneration(previous.id)
            : null;
          try {
            const issue = assertFetchedIssueIdentity(
              { owner: github.owner, repository: github.repository, number },
              await getIssue(
                number,
                {
                  host: "github.com",
                  owner: github.owner,
                  repository: github.repository,
                  canonicalName: `${github.owner}/${github.repository}`,
                },
                repository.worktreePath,
              ),
            );
            if (operation === "add") {
              const cached = this.database.addReviewIssue(
                "pull-request",
                pullRequest.id,
                issue,
              ).issue;
              return { reference, issue: cached, ok: true };
            }
            const refreshed = this.database.refreshReviewIssue(
              "pull-request",
              pullRequest.id,
              previous!.id,
              issue,
            );
            return refreshed.skipped
              ? {
                  reference,
                  issue: refreshed.issue ?? previous!,
                  ok: true,
                  skipped: refreshed.skipped,
                }
              : { reference, issue: refreshed.issue!, ok: true };
          } catch (error) {
            const rvwError = asRvwError(error);
            let stale: IssueDocument | null = null;
            if (previous) {
              if (isIssueIdentityMismatch(rvwError)) {
                const membershipExists = this.database.hasReviewIssue(
                  "pull-request",
                  pullRequest.id,
                  previous.id,
                );
                if (operation === "refresh" && !membershipExists) {
                  return {
                    reference,
                    issue: previous,
                    ok: true,
                    skipped: "membership-removed",
                  };
                }
                stale = membershipExists ? previous : null;
              } else {
                const result = this.database.setReviewIssueSyncError(
                  "pull-request",
                  pullRequest.id,
                  previous.id,
                  expectedCacheGeneration!,
                  rvwError.message,
                );
                if (operation === "refresh" && result.skipped) {
                  return {
                    reference,
                    issue: result.issue ?? previous,
                    ok: true,
                    skipped: result.skipped,
                  };
                }
                stale = result.skipped ? null : result.issue;
              }
            }
            return { reference, issue: stale, ok: false, error: rvwError.toJSON() };
          }
        },
      )),
    );
    return { pullRequest, issueResults };
  }

  async refreshPullRequest(id: string): Promise<SyncResult> {
    const current = this.getPullRequest(id);
    const repository = await this.repositoryFor(current);
    const github = await this.github.getPullRequest(current.url, repository.worktreePath);
    const { pullRequest, issueResults } = await this.synchronizeGithub(github, repository, []);
    return {
      ...(await this.getPullRequestView(pullRequest.id)),
      commentUpdatesApplied: 0,
      issueResults,
    };
  }

  async refreshByReference(reference: string): Promise<SyncResult> {
    return await this.refreshPullRequest(this.resolveStoredPullRequest(reference).id);
  }

  async syncPullRequest(input: {
    pullRequest: string;
    commentUpdates?: CommentUpdateRequest[];
    repositoryPath?: string;
    allowUntracked?: boolean;
  }): Promise<SyncResult> {
    const current = this.resolveStoredPullRequest(input.pullRequest);
    const repository = input.repositoryPath
      ? await this.git.repositoryContext(input.repositoryPath)
      : await this.repositoryFor(current);
    await this.assertRepositoryMatch(current, repository);
    const worktreeStatus = await this.git.worktreeStatus(repository.worktreePath);
    const blockingEntries = input.allowUntracked
      ? worktreeStatus.trackedEntries
      : worktreeStatus.entries;
    if (blockingEntries.length > 0) {
      throw new RvwError(
        "LOCAL_CHANGES_NOT_PUSHED",
        "ローカルに未commitの変更があります。GitHub上の状態だけを同期できます。",
        {
          details: {
            localRepositoryPath: repository.worktreePath,
            dirtyEntries: worktreeStatus.entries,
            blockingEntries,
          },
          suggestions: [
            "変更をcommit・pushしてから再実行してください。",
            ...(worktreeStatus.trackedEntries.length === 0 &&
            worktreeStatus.untrackedEntries.length > 0
              ? ["未追跡fileを確認後、必要なら --allow-untracked を明示してください。"]
              : []),
            "cleanな同一repository worktreeは --repository <path> で指定できます。",
          ],
        },
      );
    }
    const github = await this.github.getPullRequest(current.url, repository.worktreePath);
    const localHead = await this.git.headState(repository.worktreePath);
    if (localHead.branch === github.headRefName && localHead.oid !== github.headOid) {
      const remoteUrl = await this.git.assertBaseRepository(
        repository.worktreePath,
        github.owner,
        github.repository,
      );
      await this.git.ensurePullRequestObjects({
        cwd: repository.worktreePath,
        remoteUrl,
        number: github.number,
        baseRefName: github.baseRefName,
        baseOid: github.baseOid,
        headOid: github.headOid,
      });
      const simplyBehind = await this.git.isAncestor(
        repository.worktreePath,
        localHead.oid,
        github.headOid,
      );
      const belongsToPreviouslySynchronizedHistory = simplyBehind
        ? false
        : await this.git.isAncestor(repository.worktreePath, localHead.oid, current.latestHeadOid);
      if (!simplyBehind && !belongsToPreviouslySynchronizedHistory) {
        throw new RvwError(
          "LOCAL_CHANGES_NOT_PUSHED",
          `ローカルbranch ${localHead.branch} にGitHub PR headへ含まれないcommitがあります。`,
          {
            details: {
              localRepositoryPath: repository.worktreePath,
              localHeadOid: localHead.oid,
              githubHeadOid: github.headOid,
              relationship: "ahead-or-diverged",
            },
            suggestions: [
              "変更をpushし、GitHub PR headの更新を確認してから再実行してください。",
              "別のcleanなworktreeは --repository <path> で指定できます。",
            ],
          },
        );
      }
    }
    const updates = this.prepareCommentUpdates(current.id, input.commentUpdates ?? []);
    const { pullRequest, issueResults } = await this.synchronizeGithub(github, repository, updates);
    return {
      ...(await this.getPullRequestView(pullRequest.id)),
      commentUpdatesApplied: updates.length,
      issueResults,
    };
  }

  async attachPullRequest(reference: string, repositoryPath: string): Promise<PullRequest> {
    const pullRequest = this.resolveStoredPullRequest(reference);
    const repository = await this.git.repositoryContext(repositoryPath);
    await this.assertRepositoryMatch(pullRequest, repository);
    return this.database.updateRepositoryLocation(pullRequest.id, {
      localRepositoryPath: repository.worktreePath,
      gitCommonDir: repository.gitCommonDir,
    });
  }

  async getPullRequestView(id: string): Promise<PullRequestView> {
    const pullRequest = this.getPullRequest(id);
    const commits = await this.git.commits(
      pullRequest.localRepositoryPath,
      pullRequest.latestComparisonBaseOid,
      pullRequest.latestHeadOid,
    );
    return {
      pullRequest,
      comparisonBaseOid: pullRequest.latestComparisonBaseOid,
      headOid: pullRequest.latestHeadOid,
      commits,
    };
  }

  private async assertCommitAvailable(pullRequest: PullRequest, oid: string): Promise<void> {
    if (
      !GIT_OBJECT_ID_PATTERN.test(oid) ||
      !(await this.git.hasObject(pullRequest.localRepositoryPath, oid))
    ) {
      throw new RvwError("COMMIT_NOT_FOUND", `Git commitが見つかりません: ${oid}`, { status: 404 });
    }
  }

  private async assertCommitRange(
    pullRequest: PullRequest,
    oldOid: string,
    newOid: string,
  ): Promise<void> {
    await Promise.all([
      this.assertCommitAvailable(pullRequest, oldOid),
      this.assertCommitAvailable(pullRequest, newOid),
    ]);
    if (!(await this.git.isAncestor(pullRequest.localRepositoryPath, oldOid, newOid))) {
      throw new RvwError(
        "INVALID_COMMIT_RANGE",
        "比較元commitは比較先commitのancestorでなければなりません。",
      );
    }
  }

  async getTree(
    pullRequestId: string,
    oid: string,
  ): Promise<{ virtual: string; entries: TreeEntry[] }> {
    const pullRequest = this.getPullRequest(pullRequestId);
    await this.assertCommitAvailable(pullRequest, oid);
    return {
      virtual: "Pull Request.md",
      entries: await this.git.tree(pullRequest.localRepositoryPath, oid),
    };
  }

  private async assertRepositoryReviewEvidenceAvailable(
    repositoryReview: RepositoryReview,
    sourceOids: readonly string[],
    repositoryContext?: RepositoryContext,
  ): Promise<void> {
    const uniqueSourceOids = [...new Set(sourceOids)];
    const invalidOid = uniqueSourceOids.find((oid) => !GIT_OBJECT_ID_PATTERN.test(oid));
    if (invalidOid) {
      throw new RvwError("COMMIT_NOT_FOUND", `Git commitが見つかりません: ${invalidOid}`, {
        status: 404,
      });
    }
    const repository = repositoryContext ?? (await this.repositoryContextFor(repositoryReview));
    await mapWithConcurrency(
      uniqueSourceOids,
      REPOSITORY_COMMENT_PLACEMENT_CONCURRENCY,
      async (oid) => {
        const [retained, available] = await Promise.all([
          this.git.verifyRepositoryReviewCommitRef(
            repository.worktreePath,
            repositoryReview.id,
            oid,
          ),
          this.git.hasObject(repository.worktreePath, oid),
        ]);
        if (!retained || !available) {
          throw new RvwError(
            "COMMIT_NOT_FOUND",
            `Repository Reviewで保持されているGit commitが見つかりません: ${oid}`,
            {
              status: 404,
              details: {
                repositoryReviewId: repositoryReview.id,
                sourceOid: oid,
                retainedRefAvailable: retained,
                gitObjectAvailable: available,
              },
            },
          );
        }
      },
    );
  }

  private async assertRepositoryReviewCommitAvailable(
    repositoryReview: RepositoryReview,
    oid: string,
  ): Promise<void> {
    await this.assertRepositoryReviewEvidenceAvailable(repositoryReview, [oid]);
  }

  async getRepositoryTree(repositoryReviewId: string): Promise<{ entries: TreeEntry[] }> {
    const repositoryReview = this.getRepositoryReview(repositoryReviewId);
    await this.assertRepositoryReviewCommitAvailable(repositoryReview, repositoryReview.sourceOid);
    return {
      entries: await this.git.tree(
        repositoryReview.localRepositoryPath,
        repositoryReview.sourceOid,
      ),
    };
  }

  async getRepositoryReviewDocument(
    ref: RepositoryReviewDocumentRef,
  ): Promise<RepositoryReviewDocumentContent> {
    const repositoryReview = this.getRepositoryReview(ref.repositoryReviewId);
    if (ref.kind === "issue-markdown") {
      const issue = this.database.getIssue(ref.issueId);
      if (!issue || !this.database.hasReviewIssue("repository", repositoryReview.id, issue.id)) {
        throw new RvwError("ISSUE_NOT_FOUND", "Issue documentが見つかりません。", { status: 404 });
      }
      return {
        ref,
        availability: "available",
        text: issue.body,
        byteLength: Buffer.byteLength(issue.body, "utf8"),
        entryKind: "virtual",
        normalizedLineEndings: false,
        oid: null,
      };
    }
    await this.assertRepositoryReviewCommitAvailable(repositoryReview, ref.sourceOid);
    const content = await this.git.readDocument(
      repositoryReview.localRepositoryPath,
      ref.sourceOid,
      ref.path,
    );
    return { ref, ...content };
  }

  async getRepositoryReviewAsset(repositoryReviewId: string, sourceOid: string, filePath: string) {
    const repositoryReview = this.getRepositoryReview(repositoryReviewId);
    await this.assertRepositoryReviewCommitAvailable(repositoryReview, sourceOid);
    return await this.git.readRepositoryAsset(
      repositoryReview.localRepositoryPath,
      sourceOid,
      filePath,
    );
  }

  async searchRepositoryReview(
    repositoryReviewId: string,
    query: string,
    options: SearchOptions,
  ): Promise<RepositoryReviewSearchResponse> {
    const queryBytes = Buffer.byteLength(query, "utf8");
    if (queryBytes === 0 || queryBytes > MAX_SEARCH_QUERY_BYTES || /[\r\n]/.test(query)) {
      throw new RvwError(
        "INVALID_INPUT",
        `検索語は改行を含まない1〜${MAX_SEARCH_QUERY_BYTES} UTF-8 bytesにしてください。`,
      );
    }
    const repositoryReview = this.getRepositoryReview(repositoryReviewId);
    await this.assertRepositoryReviewCommitAvailable(repositoryReview, repositoryReview.sourceOid);
    const result = await this.git.search(
      repositoryReview.localRepositoryPath,
      repositoryReview.sourceOid,
      query,
      options,
    );
    const results = result.results.map((entry) => ({
      ...entry,
      document: {
        kind: "repository-file" as const,
        repositoryReviewId: repositoryReview.id,
        sourceOid: repositoryReview.sourceOid,
        path: entry.path,
      },
    }));
    return {
      results,
      matchCount: results.reduce((count, entry) => count + entry.matches.length, 0),
      truncated: result.truncated,
      limits: {
        queryBytes: MAX_SEARCH_QUERY_BYTES,
        resultCount: MAX_SEARCH_RESULTS,
        stdoutBytes: MAX_SEARCH_STDOUT_BYTES,
      },
    };
  }

  async getChangedFiles(
    pullRequestId: string,
    oldOid: string,
    newOid: string,
  ): Promise<{ oldOid: string; newOid: string; files: ChangedFile[] }> {
    const pullRequest = this.getPullRequest(pullRequestId);
    await this.assertCommitRange(pullRequest, oldOid, newOid);
    return {
      oldOid,
      newOid,
      files: await this.git.changedFiles(pullRequest.localRepositoryPath, oldOid, newOid),
    };
  }

  async getDocument(ref: DocumentRef): Promise<DocumentContent> {
    const pullRequest = this.getPullRequest(ref.pullRequestId);
    if (ref.kind === "pull-request-markdown") {
      const text = buildPullRequestMarkdown(pullRequest.latestTitle, pullRequest.latestBody);
      return {
        ref,
        availability: "available",
        text,
        byteLength: Buffer.byteLength(text, "utf8"),
        entryKind: "virtual",
        normalizedLineEndings: false,
        oid: null,
      };
    }
    if (ref.kind === "issue-markdown") {
      const issue = this.database.getIssue(ref.issueId);
      if (!issue || !this.database.hasReviewIssue("pull-request", pullRequest.id, issue.id)) {
        throw new RvwError("ISSUE_NOT_FOUND", "Issue documentが見つかりません。", { status: 404 });
      }
      return {
        ref,
        availability: "available",
        text: issue.body,
        byteLength: Buffer.byteLength(issue.body, "utf8"),
        entryKind: "virtual",
        normalizedLineEndings: false,
        oid: null,
      };
    }
    await this.assertCommitAvailable(pullRequest, ref.sourceOid);
    const content = await this.git.readDocument(
      pullRequest.localRepositoryPath,
      ref.sourceOid,
      ref.path,
    );
    return { ref, ...content };
  }

  async getRepositoryAsset(pullRequestId: string, sourceOid: string, filePath: string) {
    const pullRequest = this.getPullRequest(pullRequestId);
    await this.assertCommitAvailable(pullRequest, sourceOid);
    return await this.git.readRepositoryAsset(pullRequest.localRepositoryPath, sourceOid, filePath);
  }

  async getGitHubAttachment(
    pullRequestId: string,
    absoluteUrl: string,
  ): Promise<{ content: Buffer; byteLength: number; contentType: ImageContentType }> {
    this.getPullRequest(pullRequestId);
    return await this.fetchGitHubAttachment(absoluteUrl);
  }

  async getRepositoryGitHubAttachment(
    repositoryReviewId: string,
    absoluteUrl: string,
  ): Promise<{ content: Buffer; byteLength: number; contentType: ImageContentType }> {
    this.getRepositoryReview(repositoryReviewId);
    return await this.fetchGitHubAttachment(absoluteUrl);
  }

  private async fetchGitHubAttachment(
    absoluteUrl: string,
  ): Promise<{ content: Buffer; byteLength: number; contentType: ImageContentType }> {
    const canonicalUrl = canonicalGitHubAttachmentUrl(absoluteUrl);
    if (!canonicalUrl) {
      throw new RvwError("INVALID_INPUT", "GitHub user attachment URLが不正です。");
    }
    const attachment = await this.github.getAttachment(canonicalUrl);
    const contentType = detectImageContentType(attachment.content);
    if (!contentType) {
      throw new RvwError("UNSUPPORTED_IMAGE", "GitHub attachmentは対応画像形式ではありません。", {
        status: 415,
      });
    }
    return { ...attachment, contentType };
  }

  async getDiff(ref: DiffDocumentRef): Promise<{
    ref: DiffDocumentRef;
    old: DocumentContent | null;
    new: DocumentContent | null;
  }> {
    const [old, next] = await Promise.all([
      ref.old ? this.getDocument(ref.old) : Promise.resolve(null),
      ref.new ? this.getDocument(ref.new) : Promise.resolve(null),
    ]);
    return { ref, old, new: next };
  }

  async search(
    pullRequestId: string,
    oid: string,
    query: string,
    options: SearchOptions,
  ): Promise<SearchResponse> {
    const queryBytes = Buffer.byteLength(query, "utf8");
    if (
      queryBytes === 0 ||
      queryBytes > MAX_SEARCH_QUERY_BYTES ||
      query.includes("\n") ||
      query.includes("\r")
    ) {
      throw new RvwError(
        "INVALID_INPUT",
        `検索語は改行を含まない1〜${MAX_SEARCH_QUERY_BYTES} UTF-8 bytesにしてください。`,
      );
    }
    const pullRequest = this.getPullRequest(pullRequestId);
    await this.assertCommitAvailable(pullRequest, oid);
    const prMarkdown = buildPullRequestMarkdown(pullRequest.latestTitle, pullRequest.latestBody);
    const results: SearchResponse["results"] = [];
    for (const [index, line] of prMarkdown.split("\n").entries()) {
      const matches = findFixedStringMatches(line, query, options);
      if (matches.length > 0) {
        results.push({
          document: { kind: "pull-request-markdown", pullRequestId },
          path: "Pull Request.md",
          line: index + 1,
          text: line,
          matches,
        });
      }
      if (results.length >= MAX_SEARCH_RESULTS) break;
    }
    const gitResult = await this.git.search(pullRequest.localRepositoryPath, oid, query, options);
    for (const result of gitResult.results) {
      if (results.length >= MAX_SEARCH_RESULTS) break;
      results.push({
        ...result,
        document: { kind: "repository-file", pullRequestId, sourceOid: oid, path: result.path },
      });
    }
    return {
      results,
      matchCount: results.reduce((count, result) => count + result.matches.length, 0),
      truncated:
        gitResult.truncated ||
        (results.length >= MAX_SEARCH_RESULTS &&
          (gitResult.results.length > 0 ||
            prMarkdown
              .split("\n")
              .some((line) => findFixedStringMatches(line, query, options).length > 0))),
      limits: {
        queryBytes: MAX_SEARCH_QUERY_BYTES,
        resultCount: MAX_SEARCH_RESULTS,
        stdoutBytes: MAX_SEARCH_STDOUT_BYTES,
      },
    };
  }

  private validateLineRange(
    text: string,
    startLine: number | null,
    endLine: number | null,
    subject = "コメント",
  ): void {
    assertLinePair(startLine, endLine);
    if (startLine === null || endLine === null) return;
    const lineCount = text.split("\n").length;
    if (startLine < 1 || endLine < startLine || endLine > lineCount) {
      throw new RvwError("INVALID_INPUT", `${subject}の行範囲が文書外です。`);
    }
  }

  private async validateCodeReferences(
    review: PullRequest | RepositoryReview,
    input: {
      sourceOid: string | null;
      body: string;
      references: CodeReference[];
      additionalUsedReferenceIds?: Iterable<string>;
      subject: string;
    },
  ): Promise<WalkthroughMarkdownAnalysis> {
    const markdown = analyzeReferenceMarkdown(input.body);
    if (input.references.length > MAX_CODE_REFERENCES) {
      throw new RvwError(
        "INVALID_INPUT",
        `${input.subject}のcode referenceは${MAX_CODE_REFERENCES}件以下にしてください。`,
      );
    }
    if ((input.references.length > 0 || markdown.referenceIds.length > 0) && !input.sourceOid) {
      throw new RvwError(
        "INVALID_INPUT",
        `${input.subject}でcode referenceを使う場合はrelated commitが必要です。`,
      );
    }
    if (input.sourceOid) {
      if ("defaultBranchName" in review) {
        await this.assertRepositoryReviewCommitAvailable(review, input.sourceOid);
      } else {
        await this.assertCommitAvailable(review, input.sourceOid);
      }
    }

    const referenceIds = new Set<string>();
    for (const reference of input.references) {
      if (!codeReferenceIdPattern.test(reference.id) || referenceIds.has(reference.id)) {
        throw new RvwError(
          "INVALID_INPUT",
          `code reference IDが不正または重複しています: ${reference.id}`,
        );
      }
      referenceIds.add(reference.id);
      assertCodeReferencePath(reference.path);
      if (
        reference.label.trim().length === 0 ||
        reference.label.length > MAX_CODE_REFERENCE_LABEL_CHARACTERS
      ) {
        throw new RvwError("INVALID_INPUT", `code reference labelが不正です: ${reference.id}`);
      }
      if (
        reference.description !== null &&
        reference.description.length > MAX_CODE_REFERENCE_DESCRIPTION_CHARACTERS
      ) {
        throw new RvwError(
          "INVALID_INPUT",
          `code reference descriptionが長すぎます: ${reference.id}`,
        );
      }
      const content = await this.git.readDocument(
        review.localRepositoryPath,
        input.sourceOid!,
        reference.path,
      );
      if (content.availability !== "available") {
        throw new RvwError("INVALID_INPUT", `code referenceを表示できません: ${reference.path}`);
      }
      this.validateLineRange(
        content.text ?? "",
        reference.startLine,
        reference.endLine,
        `code reference ${reference.id}`,
      );
    }

    const malformedReference = markdown.referenceIds.find(
      (referenceId) => !codeReferenceIdPattern.test(referenceId),
    );
    if (malformedReference !== undefined) {
      throw new RvwError(
        "INVALID_INPUT",
        `Markdown reference IDが不正です: ${malformedReference || "(empty)"}`,
      );
    }
    const missingReference = markdown.referenceIds.find(
      (referenceId) => !referenceIds.has(referenceId),
    );
    if (missingReference) {
      throw new RvwError(
        "INVALID_INPUT",
        `Markdown referenceが見つかりません: ${missingReference}`,
      );
    }
    const usedReferenceIds = new Set([
      ...markdown.referenceIds,
      ...(input.additionalUsedReferenceIds ?? []),
    ]);
    const unusedReference = input.references.find(
      (reference) => !usedReferenceIds.has(reference.id),
    );
    if (unusedReference) {
      const usageSurface =
        input.additionalUsedReferenceIds === undefined ? "本文" : "本文またはbinding";
      throw new RvwError(
        "INVALID_INPUT",
        `code referenceが${usageSurface}から参照されていません: ${unusedReference.id}`,
      );
    }
    return markdown;
  }

  private async prepareCommentTarget(
    pullRequest: PullRequest,
    target: CommentTargetRequest,
  ): Promise<CommentTarget> {
    if (target.kind === "pull-request") return target;
    if (target.kind === "repository") {
      throw new RvwError(
        "INVALID_INPUT",
        "Pull Request Reviewにはrepository targetを作成できません。",
      );
    }
    if (target.kind === "issue") {
      const storedById = this.database.getIssue(target.issue);
      const identity = storedById ? storedById : parseIssueReference(target.issue, pullRequest);
      if (
        identity.owner.toLowerCase() !== pullRequest.owner.toLowerCase() ||
        identity.repository.toLowerCase() !== pullRequest.repository.toLowerCase()
      ) {
        throw new RvwError("INVALID_INPUT", "cross-repository Issueは追加できません。");
      }
      const issue =
        storedById ?? this.database.findIssue(identity.owner, identity.repository, identity.number);
      if (!issue || !this.database.hasReviewIssue("pull-request", pullRequest.id, issue.id)) {
        throw new RvwError(
          "ISSUE_NOT_FOUND",
          "このPull Request ReviewにIssueが登録されていません。",
        );
      }
      const startLine = target.startLine ?? null;
      const endLine = target.endLine ?? null;
      assertLinePair(startLine, endLine);
      this.validateLineRange(issue.body, startLine, endLine, "Issueコメント");
      const quotedText =
        startLine === null || endLine === null
          ? null
          : selectedLineText(issue.body, startLine, endLine);
      return {
        kind: "issue",
        issueId: issue.id,
        issueUrl: issue.url,
        issueNumber: issue.number,
        issueTitle: issue.title,
        sourceDocumentHash: issue.bodyHash,
        quotedText,
        startLine,
        endLine,
      };
    }
    if (target.kind === "walkthrough") {
      const walkthrough = this.database.getWalkthrough(target.walkthroughId);
      if (!walkthrough || walkthrough.pullRequestId !== pullRequest.id) {
        throw new RvwError("INVALID_INPUT", "このPRのWalkthroughが見つかりません。");
      }
      const startLine = target.startLine ?? null;
      const endLine = target.endLine ?? null;
      assertLinePair(startLine, endLine);
      this.validateLineRange(walkthrough.body, startLine, endLine, "Walkthroughコメント");
      const quotedText =
        startLine === null || endLine === null
          ? null
          : selectedLineText(walkthrough.body, startLine, endLine);
      if (startLine !== null && quotedText === null) {
        throw new RvwError("INVALID_INPUT", "Walkthroughのコメント範囲を取得できません。");
      }
      return {
        kind: target.kind,
        walkthroughId: target.walkthroughId,
        walkthroughTitle: walkthrough.title,
        sourceDocumentHash: quotedText === null ? null : hashDocument(walkthrough.body),
        quotedText,
        startLine,
        endLine,
      };
    }
    assertLinePair(target.startLine, target.endLine);
    if (target.documentKind === "pull-request-markdown") {
      const markdown = buildPullRequestMarkdown(pullRequest.latestTitle, pullRequest.latestBody);
      this.validateLineRange(markdown, target.startLine, target.endLine);
      const quotedText =
        target.startLine === null || target.endLine === null
          ? null
          : selectedLineText(markdown, target.startLine, target.endLine);
      if (target.startLine !== null && quotedText === null) {
        throw new RvwError("INVALID_INPUT", "PR本文のコメント範囲を取得できません。");
      }
      return {
        ...target,
        sourceDocumentHash: hashDocument(markdown),
        quotedText,
      };
    }
    const content = await this.getDocument({
      kind: "repository-file",
      pullRequestId: pullRequest.id,
      sourceOid: target.sourceOid,
      path: target.path,
    });
    if (content.availability !== "available") {
      if (
        target.startLine === null &&
        target.endLine === null &&
        content.availability !== "missing"
      ) {
        return target;
      }
      if (content.availability === "missing") {
        throw new RvwError("INVALID_INPUT", "文書が見つからないためコメントを作成できません。");
      }
      throw new RvwError("INVALID_INPUT", "表示できない文書には行コメントを作成できません。");
    }
    this.validateLineRange(content.text ?? "", target.startLine, target.endLine);
    return target;
  }

  async createComment(input: {
    pullRequestId: string;
    target: CommentTargetRequest;
    body: string;
    authorLabel?: string | null;
    relatedCommitOid?: string | null;
    references?: CodeReference[];
    lastModifiedBy?: CommentPostModifier;
  }): Promise<ReviewComment> {
    const pullRequest = this.getPullRequest(input.pullRequestId);
    const target = await this.prepareCommentTarget(pullRequest, input.target);
    assertAuthorLabel(input.authorLabel);
    const body = assertTextBody(input.body);
    const references = input.references ?? [];
    await this.validateCodeReferences(pullRequest, {
      sourceOid: input.relatedCommitOid ?? null,
      body,
      references,
      subject: "comment post",
    });
    const write = (): ReviewComment =>
      this.database.createComment({
        pullRequestId: pullRequest.id,
        createdHeadOid: pullRequest.latestHeadOid,
        target,
        body,
        ...(input.relatedCommitOid === undefined
          ? {}
          : { relatedCommitOid: input.relatedCommitOid }),
        references,
        ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
        ...(input.lastModifiedBy === undefined ? {} : { lastModifiedBy: input.lastModifiedBy }),
      });
    return input.relatedCommitOid
      ? await this.writeWithRetainedCommit(pullRequest, input.relatedCommitOid, write)
      : write();
  }

  private async prepareRepositoryCommentTarget(
    repositoryReview: RepositoryReview,
    target: CommentTargetRequest,
  ): Promise<RepositoryReviewCommentTarget> {
    if (target.kind === "repository") return target;
    if (target.kind === "pull-request") {
      throw new RvwError(
        "INVALID_INPUT",
        "Repository ReviewにはPull Request targetを作成できません。",
      );
    }
    if (target.kind === "issue") {
      const storedById = this.database.getIssue(target.issue);
      const identity = storedById
        ? storedById
        : parseIssueReference(target.issue, repositoryReview);
      const issue =
        storedById ?? this.database.findIssue(identity.owner, identity.repository, identity.number);
      if (!issue || !this.database.hasReviewIssue("repository", repositoryReview.id, issue.id)) {
        throw new RvwError("ISSUE_NOT_FOUND", "このRepository ReviewにIssueが登録されていません。");
      }
      const startLine = target.startLine ?? null;
      const endLine = target.endLine ?? null;
      assertLinePair(startLine, endLine);
      this.validateLineRange(issue.body, startLine, endLine, "Issueコメント");
      const quotedText =
        startLine === null || endLine === null
          ? null
          : selectedLineText(issue.body, startLine, endLine);
      return {
        kind: "issue",
        issueId: issue.id,
        issueUrl: issue.url,
        issueNumber: issue.number,
        issueTitle: issue.title,
        sourceDocumentHash: issue.bodyHash,
        quotedText,
        startLine,
        endLine,
      };
    }
    if (target.kind === "walkthrough") {
      const walkthrough = this.database.getRepositoryWalkthrough(target.walkthroughId);
      if (!walkthrough || walkthrough.repositoryReviewId !== repositoryReview.id) {
        throw new RvwError("INVALID_INPUT", "このRepository ReviewのWalkthroughが見つかりません。");
      }
      const startLine = target.startLine ?? null;
      const endLine = target.endLine ?? null;
      assertLinePair(startLine, endLine);
      this.validateLineRange(walkthrough.body, startLine, endLine, "Walkthroughコメント");
      const quotedText =
        startLine === null || endLine === null
          ? null
          : selectedLineText(walkthrough.body, startLine, endLine);
      return {
        kind: "walkthrough",
        walkthroughId: walkthrough.id,
        walkthroughTitle: walkthrough.title,
        sourceDocumentHash: quotedText === null ? null : hashDocument(walkthrough.body),
        quotedText,
        startLine,
        endLine,
      };
    }
    if (target.documentKind === "pull-request-markdown") {
      throw new RvwError("INVALID_INPUT", "Repository ReviewにPull Request.mdはありません。");
    }
    assertLinePair(target.startLine, target.endLine);
    if (target.sourceOid !== repositoryReview.sourceOid) {
      throw new RvwError(
        "INVALID_INPUT",
        "Repository Reviewの新規code commentはcurrent source OIDを対象にしてください。",
      );
    }
    await this.assertRepositoryReviewCommitAvailable(repositoryReview, target.sourceOid);
    const content = await this.git.readDocument(
      repositoryReview.localRepositoryPath,
      target.sourceOid,
      target.path,
    );
    if (content.availability !== "available") {
      if (
        target.startLine === null &&
        target.endLine === null &&
        content.availability !== "missing"
      ) {
        return target;
      }
      throw new RvwError("INVALID_INPUT", "表示できない文書には行コメントを作成できません。");
    }
    this.validateLineRange(content.text ?? "", target.startLine, target.endLine);
    return target;
  }

  private async writeWithRepositoryRetainedCommit<T>(
    resolved: ResolvedRepositoryReview,
    sourceOid: string,
    write: () => T,
  ): Promise<T> {
    const { repositoryReview, repository } = resolved;
    const retained = await this.git.ensureRepositoryReviewCommitRef(
      repository.worktreePath,
      repositoryReview.id,
      sourceOid,
    );
    try {
      return write();
    } catch (error) {
      if (retained.created && !this.database.getRepositoryReview(repositoryReview.id)) {
        await this.git
          .deleteRef(repository.worktreePath, retained.ref, sourceOid)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async createRepositoryComment(input: {
    repositoryReviewId: string;
    target: CommentTargetRequest;
    body: string;
    authorLabel?: string | null;
    relatedCommitOid?: string | null;
    references?: CodeReference[];
    lastModifiedBy?: CommentPostModifier;
  }): Promise<RepositoryReviewComment> {
    const resolved = await this.resolveBoundRepositoryArtifactContext(
      this.getRepositoryReview(input.repositoryReviewId),
    );
    const { repositoryReview } = resolved;
    const writeContext = this.repositoryReviewWriteContext(resolved);
    const target = await this.prepareRepositoryCommentTarget(repositoryReview, input.target);
    const body = assertTextBody(input.body);
    assertAuthorLabel(input.authorLabel);
    const references = input.references ?? [];
    await this.validateCodeReferences(repositoryReview, {
      sourceOid: input.relatedCommitOid ?? null,
      body,
      references,
      subject: "comment post",
    });
    const write = (): RepositoryReviewComment =>
      this.database.createRepositoryComment(
        {
          repositoryReviewId: repositoryReview.id,
          createdSourceOid: repositoryReview.sourceOid,
          target,
          body,
          ...(input.relatedCommitOid === undefined
            ? {}
            : { relatedCommitOid: input.relatedCommitOid }),
          references,
          ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
          ...(input.lastModifiedBy === undefined ? {} : { lastModifiedBy: input.lastModifiedBy }),
        },
        writeContext,
      );
    return input.relatedCommitOid
      ? await this.writeWithRepositoryRetainedCommit(resolved, input.relatedCommitOid, write)
      : write();
  }

  async createCommentForReference(
    input: CommentCreateRequest,
  ): Promise<ReviewComment | RepositoryReviewComment> {
    const review =
      input.review ??
      (input.pullRequest
        ? { kind: "pull-request" as const, pullRequest: input.pullRequest }
        : null);
    if (!review) throw new RvwError("INVALID_INPUT", "review targetが必要です。");
    if (review.kind === "repository") {
      const repositoryReview = this.resolveStoredRepositoryReview(review.repository);
      return await this.createRepositoryComment({
        repositoryReviewId: repositoryReview.id,
        target: input.target,
        body: input.body,
        ...(input.relatedCommitOid === undefined
          ? {}
          : { relatedCommitOid: input.relatedCommitOid }),
        ...(input.references === undefined ? {} : { references: input.references }),
        ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
        lastModifiedBy: "agent",
      });
    }
    const pullRequest = this.resolveStoredPullRequest(review.pullRequest);
    return await this.createComment({
      pullRequestId: pullRequest.id,
      target: input.target,
      body: input.body,
      ...(input.relatedCommitOid === undefined ? {} : { relatedCommitOid: input.relatedCommitOid }),
      ...(input.references === undefined ? {} : { references: input.references }),
      ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
      lastModifiedBy: "agent",
    });
  }

  getCommentByUri(uri: string): { pullRequest: PullRequest; comment: ReviewComment } {
    const id = parseCommentUri(uri);
    const comment = this.database.getComment(id);
    if (!comment)
      throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。", { status: 404 });
    return { pullRequest: this.getPullRequest(comment.pullRequestId), comment };
  }

  getRepositoryCommentByUri(uri: string): {
    repositoryReview: RepositoryReview;
    comment: RepositoryReviewComment;
  } {
    const id = parseCommentUri(uri);
    const comment = this.database.getRepositoryComment(id);
    if (!comment) {
      throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。", { status: 404 });
    }
    return { repositoryReview: this.getRepositoryReview(comment.repositoryReviewId), comment };
  }

  private async getCommentExactSource(comment: ReviewComment): Promise<CommentExactSource | null> {
    if (comment.target.kind !== "document" || comment.target.documentKind !== "repository-file") {
      return null;
    }
    const target = comment.target;
    const content = await this.getDocument({
      kind: "repository-file",
      pullRequestId: comment.pullRequestId,
      sourceOid: target.sourceOid,
      path: target.path,
    });
    return {
      sourceOid: target.sourceOid,
      path: target.path,
      availability: content.availability,
      excerpt:
        content.availability === "available"
          ? createSourceExcerpt(content.text ?? "", target.startLine, target.endLine)
          : null,
    };
  }

  private async getRepositoryCommentExactSource(
    repositoryReview: RepositoryReview,
    comment: RepositoryReviewComment,
    evidenceVerified = false,
    repositoryContext?: RepositoryContext,
  ): Promise<CommentExactSource | null> {
    if (comment.target.kind !== "document") return null;
    const target = comment.target;
    if (!evidenceVerified) {
      await this.assertRepositoryReviewEvidenceAvailable(
        repositoryReview,
        [target.sourceOid],
        repositoryContext,
      );
    }
    const content = await this.git.readDocument(
      repositoryContext?.worktreePath ?? repositoryReview.localRepositoryPath,
      target.sourceOid,
      target.path,
    );
    return {
      sourceOid: target.sourceOid,
      path: target.path,
      availability: content.availability,
      excerpt:
        content.availability === "available"
          ? createSourceExcerpt(content.text ?? "", target.startLine, target.endLine)
          : null,
    };
  }

  private async placeRepositoryCommentAtSource(
    repositoryReview: RepositoryReview,
    comment: RepositoryReviewComment,
    destinationOid: string,
    cache?: RepositoryPlacementCache,
    evidenceVerified = false,
    repositoryContext?: RepositoryContext,
  ): Promise<CommentPlacement> {
    const target = comment.target;
    if (target.kind === "repository") return { outdated: false, range: null, path: null };
    if (target.kind === "issue") {
      const issue = this.database.getIssue(target.issueId);
      return placeIssueComment(
        target,
        issue,
        issue !== null &&
          this.database.hasReviewIssue("repository", repositoryReview.id, target.issueId),
      );
    }
    if (target.kind === "walkthrough") {
      const walkthrough = this.database.getRepositoryWalkthrough(target.walkthroughId);
      if (!walkthrough) return { outdated: true, range: null, path: null };
      if (target.startLine === null || target.endLine === null) {
        return { outdated: false, range: null, path: null };
      }
      return { ...placeMutableDocumentComment(target, walkthrough.body), path: null };
    }
    if (!evidenceVerified) {
      await this.assertRepositoryReviewEvidenceAvailable(
        repositoryReview,
        [target.sourceOid, destinationOid],
        repositoryContext,
      );
    }
    const repositoryPath = repositoryContext?.worktreePath ?? repositoryReview.localRepositoryPath;
    const resolved =
      target.sourceOid === destinationOid
        ? { path: target.path, deleted: false }
        : await (async () => {
            const cacheKey = `${target.sourceOid}:${destinationOid}`;
            let changesPromise = cache?.changedFiles.get(cacheKey);
            if (!changesPromise) {
              changesPromise = this.git.changedFiles(
                repositoryPath,
                target.sourceOid,
                destinationOid,
              );
              cache?.changedFiles.set(cacheKey, changesPromise);
            }
            const changes = await changesPromise;
            const change = changes.find((candidate) => candidate.oldPath === target.path);
            return {
              path: change?.newPath ?? target.path,
              deleted:
                change?.kind === "deleted" || (change !== undefined && change.newPath === null),
            };
          })();
    if (resolved.deleted) return { outdated: true, range: null, path: target.path };
    const readDocument = (oid: string, filePath: string): Promise<BlobContent> => {
      const cacheKey = `${oid}:${filePath}`;
      let documentPromise = cache?.documents.get(cacheKey);
      if (!documentPromise) {
        documentPromise = this.git.readDocument(repositoryPath, oid, filePath);
        cache?.documents.set(cacheKey, documentPromise);
      }
      return documentPromise;
    };
    const destination = await readDocument(destinationOid, resolved.path);
    if (target.startLine === null || target.endLine === null) {
      return destination.availability === "missing"
        ? { outdated: true, range: null, path: resolved.path }
        : { outdated: false, range: null, path: resolved.path };
    }
    const source = await readDocument(target.sourceOid, target.path);
    if (source.availability !== "available" || destination.availability !== "available") {
      return { outdated: true, range: null, path: resolved.path };
    }
    const range = mapUnchangedLineRange(
      source.text ?? "",
      destination.text ?? "",
      target.startLine,
      target.endLine,
    );
    return range
      ? { outdated: false, range, path: resolved.path }
      : { outdated: true, range: null, path: resolved.path };
  }

  async placeRepositoryCommentAtCommit(
    repositoryReviewId: string,
    comment: RepositoryReviewComment,
    destinationOid: string,
  ): Promise<CommentPlacement> {
    const repositoryReview = this.getRepositoryReview(repositoryReviewId);
    if (comment.repositoryReviewId !== repositoryReview.id) {
      return { outdated: true, range: null, path: null };
    }
    await this.assertRepositoryReviewEvidenceAvailable(
      repositoryReview,
      comment.target.kind === "document"
        ? [comment.target.sourceOid, destinationOid]
        : [destinationOid],
    );
    return await this.placeRepositoryCommentAtSource(
      repositoryReview,
      comment,
      destinationOid,
      undefined,
      comment.target.kind === "document",
    );
  }

  placeRepositoryWalkthroughComment(
    repositoryReviewId: string,
    comment: RepositoryReviewComment,
    walkthroughId: string,
  ): CommentPlacement {
    if (
      comment.repositoryReviewId !== repositoryReviewId ||
      comment.target.kind !== "walkthrough" ||
      comment.target.walkthroughId !== walkthroughId
    ) {
      return { outdated: true, range: null, path: null };
    }
    const walkthrough = this.database.getRepositoryWalkthrough(walkthroughId);
    if (!walkthrough || walkthrough.repositoryReviewId !== repositoryReviewId) {
      return { outdated: true, range: null, path: null };
    }
    if (comment.target.startLine === null || comment.target.endLine === null) {
      return { outdated: false, range: null, path: null };
    }
    return { ...placeMutableDocumentComment(comment.target, walkthrough.body), path: null };
  }

  placeRepositoryIssueComment(
    repositoryReviewId: string,
    comment: RepositoryReviewComment,
    issueId: string,
  ): CommentPlacement {
    if (
      comment.repositoryReviewId !== repositoryReviewId ||
      comment.target.kind !== "issue" ||
      comment.target.issueId !== issueId
    ) {
      return { outdated: true, range: null, path: null };
    }
    const issue = this.database.getIssue(issueId);
    return placeIssueComment(
      comment.target,
      issue,
      issue !== null && this.database.hasReviewIssue("repository", repositoryReviewId, issue.id),
    );
  }

  async getAnyCommentReviewContext(
    uri: string,
    options: { live?: boolean } = {},
  ): Promise<CommentReviewContext | RepositoryCommentReviewContext> {
    const id = parseCommentUri(uri);
    const repositoryComment = this.database.getRepositoryComment(id);
    if (repositoryComment) {
      const repositoryReview = this.getRepositoryReview(repositoryComment.repositoryReviewId);
      await this.repositoryContextFor(repositoryReview);
      const evidenceVerified = repositoryComment.target.kind === "document";
      if (repositoryComment.target.kind === "document") {
        await this.assertRepositoryReviewEvidenceAvailable(repositoryReview, [
          repositoryComment.target.sourceOid,
          repositoryReview.sourceOid,
        ]);
      }
      const [latestPlacement, exactSource] = await Promise.all([
        this.placeRepositoryCommentAtSource(
          repositoryReview,
          repositoryComment,
          repositoryReview.sourceOid,
          undefined,
          evidenceVerified,
        ),
        this.getRepositoryCommentExactSource(repositoryReview, repositoryComment, evidenceVerified),
      ]);
      return {
        context: {
          kind: "repository",
          repositoryReviewId: repositoryReview.id,
          repository: repositoryReview.canonicalName,
        },
        repositoryReview,
        comment: repositoryComment,
        latestPlacement,
        exactSource,
        walkthrough:
          repositoryComment.target.kind === "walkthrough"
            ? this.database.getRepositoryWalkthrough(repositoryComment.target.walkthroughId)
            : null,
        issue:
          repositoryComment.target.kind === "issue"
            ? this.database.getReviewIssue(
                "repository",
                repositoryReview.id,
                repositoryComment.target.issueId,
              )
            : null,
        githubState: { liveCheckedAt: null, staleAgainstGitHub: null, live: null },
      };
    }
    const result = this.getCommentByUri(uri);
    const [latestPlacement, exactSource] = await Promise.all([
      this.placeCommentAtCommit(result.comment, result.pullRequest.latestHeadOid),
      this.getCommentExactSource(result.comment),
    ]);
    const walkthrough =
      result.comment.target.kind === "walkthrough"
        ? this.database.getWalkthrough(result.comment.target.walkthroughId)
        : null;
    const live = options.live
      ? await this.github.getPullRequest(
          result.pullRequest.url,
          result.pullRequest.localRepositoryPath,
        )
      : null;
    const staleAgainstGitHub = live
      ? live.title !== result.pullRequest.latestTitle ||
        live.body !== result.pullRequest.latestBody ||
        live.headRepositoryOwner !== result.pullRequest.latestHeadRepositoryOwner ||
        live.headRepositoryName !== result.pullRequest.latestHeadRepositoryName ||
        live.baseOid !== result.pullRequest.latestBaseOid ||
        live.headOid !== result.pullRequest.latestHeadOid ||
        live.updatedAt !== result.pullRequest.githubUpdatedAt
      : null;
    return {
      context: {
        kind: "pull-request",
        pullRequestId: result.pullRequest.id,
        pullRequestUrl: result.pullRequest.url,
      },
      ...result,
      latestPlacement,
      exactSource,
      walkthrough,
      issue:
        result.comment.target.kind === "issue"
          ? this.database.getReviewIssue(
              "pull-request",
              result.pullRequest.id,
              result.comment.target.issueId,
            )
          : null,
      githubState: {
        liveCheckedAt: live ? new Date().toISOString() : null,
        staleAgainstGitHub,
        live,
      },
    };
  }

  async listRepositoryCommentContexts(
    repositoryReviewId: string,
    resolved?: boolean,
    repositoryContext?: RepositoryContext,
  ): Promise<Array<{ comment: RepositoryReviewComment; latestPlacement: CommentPlacement }>> {
    const repositoryReview = this.getRepositoryReview(repositoryReviewId);
    const cache: RepositoryPlacementCache = {
      changedFiles: new Map(),
      documents: new Map(),
    };
    const comments = this.database.listRepositoryComments(repositoryReviewId, resolved);
    const sourceOids = comments.flatMap((comment) =>
      comment.target.kind === "document"
        ? [comment.target.sourceOid, repositoryReview.sourceOid]
        : [],
    );
    if (sourceOids.length > 0) {
      await this.assertRepositoryReviewEvidenceAvailable(
        repositoryReview,
        sourceOids,
        repositoryContext,
      );
    }
    return await mapWithConcurrency(
      comments,
      REPOSITORY_COMMENT_PLACEMENT_CONCURRENCY,
      async (comment) => ({
        comment,
        latestPlacement: await this.placeRepositoryCommentAtSource(
          repositoryReview,
          comment,
          repositoryReview.sourceOid,
          cache,
          comment.target.kind === "document",
          repositoryContext,
        ),
      }),
    );
  }

  async getCommentReviewContext(
    uri: string,
    options: { live?: boolean } = {},
  ): Promise<CommentReviewContext> {
    const result = await this.getAnyCommentReviewContext(uri, options);
    if (!("pullRequest" in result)) {
      throw new RvwError("INVALID_INPUT", "この操作はPull Request Comment専用です。");
    }
    return result;
  }

  async listCommentReviewContexts(
    reference: string,
    resolved?: boolean,
    page: { limit?: number; offset?: number } = {},
  ): Promise<CommentListContext> {
    const limit = page.limit ?? DEFAULT_COMMENT_LIST_LIMIT;
    const offset = page.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COMMENT_LIST_LIMIT) {
      throw new RvwError(
        "INVALID_INPUT",
        `comment listのlimitは1〜${MAX_COMMENT_LIST_LIMIT}の整数にしてください。`,
      );
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RvwError("INVALID_INPUT", "comment listのoffsetは0以上の整数にしてください。");
    }
    const pullRequest = this.resolveStoredPullRequest(reference);
    const result = this.database.listCommentPage(pullRequest.id, resolved, limit, offset);
    const contexts: CommentListItemContext[] = [];
    for (const item of result.comments) {
      contexts.push({
        ...item,
        latestPlacement: await this.placeCommentAtCommit(item.comment, pullRequest.latestHeadOid),
      });
    }
    const nextOffset = offset + contexts.length;
    const hasMore = nextOffset < result.total;
    return {
      pullRequest,
      comments: contexts,
      page: {
        offset,
        limit,
        returned: contexts.length,
        total: result.total,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
      },
    };
  }

  listCommentPostEvents(cursor?: string, limit = DEFAULT_COMMENT_WATCH_LIMIT): CommentWatchContext {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COMMENT_WATCH_LIMIT) {
      throw new RvwError(
        "INVALID_INPUT",
        `comment watchのlimitは1〜${MAX_COMMENT_WATCH_LIMIT}の整数にしてください。`,
      );
    }
    const databaseId = this.database.getCommentWatchDatabaseId();
    const parsed = cursor === undefined ? null : parseCommentWatchCursor(cursor);
    if (parsed !== null && parsed.databaseId !== databaseId) {
      throw new RvwError("INVALID_INPUT", "comment watch cursorは別のrvw database用です。");
    }
    const latestAtStart = this.database.getLatestCommentPostEventSequence();
    if (parsed !== null && parsed.sequence > latestAtStart) {
      throw new RvwError("INVALID_INPUT", "comment watch cursorはdatabaseの最新eventより先です。");
    }
    const afterSequence = parsed?.sequence ?? latestAtStart;
    const rawEvents = this.database.listCommentPostEvents(afterSequence, limit);
    const events = rawEvents.map((event) => ({
      cursor: formatCommentWatchCursor({ databaseId, sequence: event.sequence }),
      event,
    }));
    const lastSequence = rawEvents.at(-1)?.sequence ?? afterSequence;
    const latestSequence = this.database.getLatestCommentPostEventSequence();
    return {
      databaseId,
      startCursor: formatCommentWatchCursor({ databaseId, sequence: afterSequence }),
      cursor: formatCommentWatchCursor({ databaseId, sequence: lastSequence }),
      anchoredAtCurrent: parsed === null,
      hasMore: lastSequence < latestSequence,
      events,
    };
  }

  listComments(pullRequestId: string, resolved?: boolean): ReviewComment[] {
    this.getPullRequest(pullRequestId);
    return this.database.listComments(pullRequestId, resolved);
  }

  listRepositoryComments(
    repositoryReviewId: string,
    resolved?: boolean,
  ): RepositoryReviewComment[] {
    this.getRepositoryReview(repositoryReviewId);
    return this.database.listRepositoryComments(repositoryReviewId, resolved);
  }

  listWalkthroughs(pullRequestId: string): WalkthroughSummary[] {
    this.getPullRequest(pullRequestId);
    return this.database.listWalkthroughs(pullRequestId);
  }

  listRepositoryWalkthroughs(repositoryReviewId: string): RepositoryWalkthroughSummary[] {
    this.getRepositoryReview(repositoryReviewId);
    return this.database.listRepositoryWalkthroughs(repositoryReviewId);
  }

  getRepositoryWalkthrough(
    repositoryReviewId: string,
    walkthroughId: string,
  ): RepositoryWalkthrough {
    this.getRepositoryReview(repositoryReviewId);
    const walkthrough = this.database.getRepositoryWalkthrough(walkthroughId);
    if (!walkthrough || walkthrough.repositoryReviewId !== repositoryReviewId) {
      throw new RvwError("NOT_FOUND", "Walkthroughが見つかりません。", { status: 404 });
    }
    return walkthrough;
  }

  async getRepositoryResetPreview(repositoryReviewId: string): Promise<{
    repositoryReview: RepositoryReview;
    counts: RepositoryResetCounts;
    retainedRefs: string[];
    reviewChangeSequence: number;
    confirmationToken: string;
    confirmationRequired: true;
  }> {
    const repositoryReview = this.getRepositoryReview(repositoryReviewId);
    const resolved = await this.repositoryLifecycle.resolveExistingAtPath(
      repositoryReview.localRepositoryPath,
      {
        policy: { kind: "reset" },
        expectedRepositoryReviewId: repositoryReview.id,
      },
    );
    return await this.getResolvedRepositoryResetPreview(resolved);
  }

  async getRepositoryResetPreviewAtPath(repositoryPath: string): Promise<{
    repositoryReview: RepositoryReview;
    counts: RepositoryResetCounts;
    retainedRefs: string[];
    reviewChangeSequence: number;
    confirmationToken: string;
    confirmationRequired: true;
  }> {
    const resolved = await this.repositoryLifecycle.resolveExistingAtPath(repositoryPath, {
      policy: { kind: "reset" },
    });
    return await this.getResolvedRepositoryResetPreview(resolved);
  }

  private async getResolvedRepositoryResetPreview(resolved: ResolvedRepositoryReview): Promise<{
    repositoryReview: RepositoryReview;
    counts: RepositoryResetCounts;
    retainedRefs: string[];
    reviewChangeSequence: number;
    confirmationToken: string;
    confirmationRequired: true;
  }> {
    const repositoryReviewId = resolved.repositoryReview.id;
    const { repository } = resolved;
    const prefix = `refs/rvw/repository/${repositoryReviewId.toLowerCase()}/commits/`;
    const retainedRefs = await this.git.listRefsByPrefix(repository.worktreePath, prefix);
    const repositoryReview = this.getRepositoryReview(repositoryReviewId);
    const counts = this.database.getRepositoryResetCounts(repositoryReviewId, retainedRefs.length);
    const reviewChangeSequence = this.database.getReviewChangeSequence(
      "repository",
      repositoryReviewId,
    );
    return {
      repositoryReview,
      counts,
      retainedRefs,
      reviewChangeSequence,
      confirmationToken: destructiveConfirmationToken({
        operation: "repository-reset",
        reviewKind: "repository",
        reviewId: repositoryReview.id,
        reviewChangeSequence,
        counts,
        retainedRefs,
      }),
      confirmationRequired: true,
    };
  }

  private async getCurrentRepositoryResetPreview(repositoryReviewId: string) {
    const current = this.getRepositoryReview(repositoryReviewId);
    const resolved = await this.repositoryLifecycle.resolveExistingAtPath(
      current.localRepositoryPath,
      {
        policy: { kind: "reset" },
        expectedRepositoryReviewId: repositoryReviewId,
      },
    );
    return await this.getResolvedRepositoryResetPreview(resolved);
  }

  private async listRepositoryResetRefs(
    repositoryPath: string,
    prefix: string,
  ): Promise<string[] | null> {
    try {
      return await this.git.listRefsByPrefix(repositoryPath, prefix);
    } catch {
      return null;
    }
  }

  private async deleteRepositoryResetRefs(repositoryPath: string, prefix: string) {
    let beforeRefs = await this.listRepositoryResetRefs(repositoryPath, prefix);
    if (beforeRefs !== null && beforeRefs.length > 0) {
      await this.git.deleteRefs(repositoryPath, beforeRefs).catch(() => undefined);
    }

    let remainingRefs = await this.listRepositoryResetRefs(repositoryPath, prefix);
    if (remainingRefs !== null && remainingRefs.length > 0) {
      if (beforeRefs === null) beforeRefs = remainingRefs;
      await this.git.deleteRefs(repositoryPath, remainingRefs).catch(() => undefined);
      remainingRefs = await this.listRepositoryResetRefs(repositoryPath, prefix);
    }

    const removedRefs =
      beforeRefs === null || remainingRefs === null
        ? []
        : beforeRefs.filter((ref) => !remainingRefs.includes(ref));
    return { removedRefs, remainingRefs };
  }

  async resetRepositoryReview(
    repositoryReviewId: string,
    confirmationToken: string,
  ): Promise<{
    repositoryReview: RepositoryReview;
    deleted: RepositoryResetCounts;
    removedRefs: string[];
    outcome:
      | { kind: "completed" }
      | {
          kind: "completed-with-orphan-refs";
          repositoryReviewDeleted: true;
          remainingRefs: string[] | null;
          refPrefix: string;
          repositoryPath: string;
          manualCleanupPossible: true;
        };
  }> {
    const repositoryReview = this.getRepositoryReview(repositoryReviewId);
    const resolved = await this.repositoryLifecycle.resolveExistingAtPath(
      repositoryReview.localRepositoryPath,
      {
        policy: { kind: "reset" },
        expectedRepositoryReviewId: repositoryReview.id,
      },
    );
    return await this.resetResolvedRepositoryReview(resolved, confirmationToken);
  }

  async resetRepositoryReviewAtPath(
    repositoryPath: string,
    confirmationToken: string,
  ): Promise<{
    repositoryReview: RepositoryReview;
    deleted: RepositoryResetCounts;
    removedRefs: string[];
    outcome:
      | { kind: "completed" }
      | {
          kind: "completed-with-orphan-refs";
          repositoryReviewDeleted: true;
          remainingRefs: string[] | null;
          refPrefix: string;
          repositoryPath: string;
          manualCleanupPossible: true;
        };
  }> {
    const resolved = await this.repositoryLifecycle.resolveExistingAtPath(repositoryPath, {
      policy: { kind: "reset" },
    });
    return await this.resetResolvedRepositoryReview(resolved, confirmationToken);
  }

  private async resetResolvedRepositoryReview(
    resolved: ResolvedRepositoryReview,
    confirmationToken: string,
  ): Promise<{
    repositoryReview: RepositoryReview;
    deleted: RepositoryResetCounts;
    removedRefs: string[];
    outcome:
      | { kind: "completed" }
      | {
          kind: "completed-with-orphan-refs";
          repositoryReviewDeleted: true;
          remainingRefs: string[] | null;
          refPrefix: string;
          repositoryPath: string;
          manualCleanupPossible: true;
        };
  }> {
    const preview = await this.getResolvedRepositoryResetPreview(resolved);
    assertDestructiveConfirmation(confirmationToken, preview);
    const prefix = `refs/rvw/repository/${preview.repositoryReview.id.toLowerCase()}/commits/`;
    let deleted: RepositoryResetCounts;
    try {
      deleted = this.database.resetRepositoryReview(
        preview.repositoryReview.id,
        preview.retainedRefs.length,
        preview.reviewChangeSequence,
      );
    } catch (error) {
      if (asRvwError(error).code === "DESTRUCTIVE_PREVIEW_STALE") {
        const currentPreview = await this.getCurrentRepositoryResetPreview(
          preview.repositoryReview.id,
        ).catch(() => null);
        if (currentPreview) {
          throw destructiveStaleErrorWithCurrentPreview(error, currentPreview);
        }
        // Rebuilding the current preview must not hide the final SQLite CAS error.
      }
      throw error;
    }
    let outcome:
      | { kind: "completed" }
      | {
          kind: "completed-with-orphan-refs";
          repositoryReviewDeleted: true;
          remainingRefs: string[] | null;
          refPrefix: string;
          repositoryPath: string;
          manualCleanupPossible: true;
        } = { kind: "completed" };
    const { removedRefs, remainingRefs } = await this.deleteRepositoryResetRefs(
      resolved.repository.worktreePath,
      prefix,
    );
    if (remainingRefs === null || remainingRefs.length > 0) {
      outcome = {
        kind: "completed-with-orphan-refs",
        repositoryReviewDeleted: true,
        remainingRefs,
        refPrefix: prefix,
        repositoryPath: resolved.repository.worktreePath,
        manualCleanupPossible: true,
      };
    }
    return {
      repositoryReview: preview.repositoryReview,
      deleted: { ...deleted, gitRefs: removedRefs.length },
      removedRefs,
      outcome,
    };
  }

  getWalkthrough(pullRequestId: string, walkthroughId: string): Walkthrough {
    this.getPullRequest(pullRequestId);
    const walkthrough = this.database.getWalkthrough(walkthroughId);
    if (!walkthrough || walkthrough.pullRequestId !== pullRequestId) {
      throw new RvwError("NOT_FOUND", "Walkthroughが見つかりません。", { status: 404 });
    }
    return walkthrough;
  }

  getWalkthroughByUri(uri: string): { pullRequest: PullRequest; walkthrough: Walkthrough } {
    const walkthrough = this.database.getWalkthrough(parseWalkthroughUri(uri));
    if (!walkthrough) {
      throw new RvwError("NOT_FOUND", "Walkthroughが見つかりません。", { status: 404 });
    }
    return {
      pullRequest: this.getPullRequest(walkthrough.pullRequestId),
      walkthrough,
    };
  }

  getAnyWalkthroughByUri(uri: string):
    | { context: { kind: "pull-request"; pullRequest: PullRequest }; walkthrough: Walkthrough }
    | {
        context: { kind: "repository"; repositoryReview: RepositoryReview };
        walkthrough: RepositoryWalkthrough;
      } {
    const id = parseWalkthroughUri(uri);
    const pullRequestWalkthrough = this.database.getWalkthrough(id);
    if (pullRequestWalkthrough) {
      return {
        context: {
          kind: "pull-request",
          pullRequest: this.getPullRequest(pullRequestWalkthrough.pullRequestId),
        },
        walkthrough: pullRequestWalkthrough,
      };
    }
    const repositoryWalkthrough = this.database.getRepositoryWalkthrough(id);
    if (repositoryWalkthrough) {
      return {
        context: {
          kind: "repository",
          repositoryReview: this.getRepositoryReview(repositoryWalkthrough.repositoryReviewId),
        },
        walkthrough: repositoryWalkthrough,
      };
    }
    throw new RvwError("NOT_FOUND", "Walkthroughが見つかりません。", { status: 404 });
  }

  async getBoundAnyWalkthroughByUri(
    uri: string,
  ): Promise<ReturnType<RvwService["getAnyWalkthroughByUri"]>> {
    const current = this.getAnyWalkthroughByUri(uri);
    if (current.context.kind === "repository") {
      await this.resolveBoundRepositoryArtifactContext(current.context.repositoryReview);
    }
    return current;
  }

  private async validateWalkthroughContent(
    review: PullRequest | RepositoryReview,
    input: WalkthroughContentRequest,
  ): Promise<
    Omit<WalkthroughContentRequest, "diagramBindings"> & {
      diagramBindings: Record<string, string>;
    }
  > {
    if ("defaultBranchName" in review) {
      await this.assertRepositoryReviewCommitAvailable(review, input.sourceOid);
    } else {
      await this.assertCommitAvailable(review, input.sourceOid);
    }
    const title = input.title.trim();
    if (title.length === 0 || title.length > MAX_WALKTHROUGH_TITLE_CHARACTERS) {
      throw new RvwError(
        "INVALID_INPUT",
        `walkthrough titleは1〜${MAX_WALKTHROUGH_TITLE_CHARACTERS}文字にしてください。`,
      );
    }
    if (
      input.body.trim().length === 0 ||
      Buffer.byteLength(input.body, "utf8") > MAX_WALKTHROUGH_BODY_BYTES
    ) {
      throw new RvwError(
        "INVALID_INPUT",
        `walkthrough本文は1〜${MAX_WALKTHROUGH_BODY_BYTES} UTF-8 bytesにしてください。`,
      );
    }
    if (input.references.length === 0 || input.references.length > MAX_CODE_REFERENCES) {
      throw new RvwError(
        "INVALID_INPUT",
        `walkthrough referenceは1〜${MAX_CODE_REFERENCES}件にしてください。`,
      );
    }
    assertAuthorLabel(input.authorLabel);
    const markdown = analyzeReferenceMarkdown(input.body);
    const diagramBindings = input.diagramBindings ?? {};
    const referenceIds = new Set(input.references.map((reference) => reference.id));
    for (const [nodeId, referenceId] of Object.entries(diagramBindings)) {
      if (!walkthroughDiagramNodePattern.test(nodeId)) {
        throw new RvwError("INVALID_INPUT", `Mermaid node IDが不正です: ${nodeId}`);
      }
      if (!referenceIds.has(referenceId)) {
        throw new RvwError(
          "INVALID_INPUT",
          `Mermaid node ${nodeId} のreferenceが見つかりません: ${referenceId}`,
        );
      }
      if (!markdown.mermaidNodeIds.has(nodeId)) {
        throw new RvwError(
          "INVALID_INPUT",
          `Mermaid nodeが本文のflowchartまたはclassDiagramに見つかりません: ${nodeId}`,
        );
      }
    }
    await this.validateCodeReferences(review, {
      sourceOid: input.sourceOid,
      body: input.body,
      references: input.references,
      additionalUsedReferenceIds: Object.values(diagramBindings),
      subject: "Walkthrough",
    });
    return {
      sourceOid: input.sourceOid,
      title,
      body: input.body,
      ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
      diagramBindings,
      references: input.references,
    };
  }

  private async writeWithRetainedCommit<T>(
    pullRequest: PullRequest,
    sourceOid: string,
    write: () => T,
  ): Promise<T> {
    await this.git.ensureCommitRef(pullRequest.localRepositoryPath, pullRequest.number, sourceOid);
    return write();
  }

  private async fetchRequestedIssues(
    review: PullRequest | RepositoryReview,
    references: string[],
  ): Promise<GitHubIssue[]> {
    if (references.length === 0) return [];
    if (references.length > MAX_WALKTHROUGH_ISSUES_TO_ADD) {
      throw new RvwError(
        "INVALID_INPUT",
        `issuesToAddは一回の操作につき${MAX_WALKTHROUGH_ISSUES_TO_ADD}件以下にしてください。`,
      );
    }
    const issueNumbers = new Set<number>();
    for (const reference of references) {
      if (reference.length > MAX_ISSUE_REFERENCE_CHARACTERS) {
        throw new RvwError(
          "INVALID_INPUT",
          `Issue referenceは${MAX_ISSUE_REFERENCE_CHARACTERS}文字以下にしてください。`,
        );
      }
      const identity = parseIssueReference(reference, review);
      if (
        identity.owner.toLowerCase() !== review.owner.toLowerCase() ||
        identity.repository.toLowerCase() !== review.repository.toLowerCase()
      ) {
        throw new RvwError("INVALID_INPUT", "cross-repository Issueは追加できません。");
      }
      issueNumbers.add(identity.number);
    }
    if (issueNumbers.size > MAX_WALKTHROUGH_ISSUES_TO_ADD) {
      throw new RvwError(
        "INVALID_INPUT",
        `issuesToAddは重複除去後に${MAX_WALKTHROUGH_ISSUES_TO_ADD}件以下にしてください。`,
      );
    }
    return await mapWithConcurrency([...issueNumbers], ISSUE_FETCH_CONCURRENCY, async (number) =>
      assertFetchedIssueIdentity(
        { owner: review.owner, repository: review.repository, number },
        await this.github.getIssue(
          number,
          {
            host: "github.com",
            owner: review.owner,
            repository: review.repository,
            canonicalName: `${review.owner}/${review.repository}`,
          },
          review.localRepositoryPath,
        ),
      ),
    );
  }

  async publishWalkthrough(input: WalkthroughPublishRequest): Promise<WalkthroughMutationResult> {
    const target =
      input.review ??
      (input.pullRequest
        ? { kind: "pull-request" as const, pullRequest: input.pullRequest }
        : null);
    if (!target) throw new RvwError("INVALID_INPUT", "review targetが必要です。");
    if (target.kind === "repository") {
      const stored = this.resolveStoredRepositoryReview(target.repository);
      const resolved = await this.resolveBoundRepositoryArtifactContext(
        stored,
        (input.issuesToAdd?.length ?? 0) > 0 ? "remote-mutation" : "local-artifact",
      );
      const { repositoryReview } = resolved;
      const writeContext = this.repositoryReviewWriteContext(resolved);
      if (input.sourceOid !== repositoryReview.sourceOid) {
        throw new RvwError(
          "INVALID_INPUT",
          "Repository Walkthroughのpublishはcurrent source OIDを対象にしてください。",
        );
      }
      const content = await this.validateWalkthroughContent(repositoryReview, input);
      const issues = await this.fetchRequestedIssues(repositoryReview, input.issuesToAdd ?? []);
      return await this.writeWithRepositoryRetainedCommit(resolved, content.sourceOid, () =>
        this.database.createRepositoryWalkthrough(
          { repositoryReviewId: repositoryReview.id, ...content },
          writeContext,
          issues,
        ),
      );
    }
    const pullRequest = this.resolveStoredPullRequest(target.pullRequest);
    const content = await this.validateWalkthroughContent(pullRequest, input);
    const issues = await this.fetchRequestedIssues(pullRequest, input.issuesToAdd ?? []);
    return await this.writeWithRetainedCommit(pullRequest, content.sourceOid, () =>
      this.database.createWalkthrough({ pullRequestId: pullRequest.id, ...content }, issues),
    );
  }

  async updateWalkthrough(
    uri: string,
    input: WalkthroughUpdateRequest,
  ): Promise<WalkthroughMutationResult> {
    const current = await this.getBoundAnyWalkthroughByUri(uri);
    const repositoryResolved =
      current.context.kind === "repository"
        ? await this.resolveBoundRepositoryArtifactContext(
            current.context.repositoryReview,
            (input.issuesToAdd?.length ?? 0) > 0 ? "remote-mutation" : "local-artifact",
          )
        : null;
    const repositoryReview = repositoryResolved?.repositoryReview ?? null;
    const review =
      current.context.kind === "pull-request" ? current.context.pullRequest : repositoryReview!;
    const content = await this.validateWalkthroughContent(review, {
      ...input,
      authorLabel:
        input.authorLabel === undefined ? current.walkthrough.authorLabel : input.authorLabel,
    });
    const issues = await this.fetchRequestedIssues(review, input.issuesToAdd ?? []);
    return current.context.kind === "pull-request"
      ? await this.writeWithRetainedCommit(current.context.pullRequest, content.sourceOid, () =>
          this.database.updateWalkthrough(current.walkthrough.id, content, issues),
        )
      : await this.writeWithRepositoryRetainedCommit(repositoryResolved!, content.sourceOid, () =>
          this.database.updateRepositoryWalkthrough(
            current.walkthrough.id,
            content,
            this.repositoryReviewWriteContext(repositoryResolved!),
            issues,
          ),
        );
  }

  async getWalkthroughDeletePreview(uri: string): Promise<WalkthroughDeletePreview> {
    const current = await this.getBoundAnyWalkthroughByUri(uri);
    const { walkthrough } = current;
    const reviewKind = current.context.kind;
    const reviewId =
      current.context.kind === "pull-request"
        ? current.context.pullRequest.id
        : current.context.repositoryReview.id;
    const counts =
      current.context.kind === "pull-request"
        ? this.database.getWalkthroughDeleteCounts(walkthrough.id)
        : this.database.getRepositoryWalkthroughDeleteCounts(walkthrough.id);
    const reviewChangeSequence = this.database.getReviewChangeSequence(reviewKind, reviewId);
    return {
      walkthrough,
      counts,
      reviewChangeSequence,
      confirmationToken: destructiveConfirmationToken({
        operation: "walkthrough-delete",
        reviewKind,
        reviewId,
        reviewChangeSequence,
        subjectId: walkthrough.id,
        counts,
      }),
      confirmationRequired: true,
    };
  }

  private async deleteWalkthroughWithPreview(
    uri: string,
    current: ReturnType<RvwService["getAnyWalkthroughByUri"]>,
    preview: WalkthroughDeletePreview,
  ): Promise<DeletedWalkthrough | DeletedRepositoryWalkthrough> {
    try {
      return current.context.kind === "pull-request"
        ? this.database.deleteWalkthrough(current.walkthrough.id, preview.reviewChangeSequence)
        : this.database.deleteRepositoryWalkthrough(
            current.walkthrough.id,
            preview.reviewChangeSequence,
          );
    } catch (error) {
      if (asRvwError(error).code === "DESTRUCTIVE_PREVIEW_STALE") {
        throw destructiveStaleErrorWithCurrentPreview(
          error,
          await this.getWalkthroughDeletePreview(uri),
        );
      }
      throw error;
    }
  }

  async deleteWalkthroughByUri(
    uri: string,
    confirmationToken: string,
  ): Promise<DeletedWalkthrough | DeletedRepositoryWalkthrough> {
    const current = await this.getBoundAnyWalkthroughByUri(uri);
    const preview = await this.getWalkthroughDeletePreview(uri);
    assertDestructiveConfirmation(confirmationToken, preview);
    return await this.deleteWalkthroughWithPreview(uri, current, preview);
  }

  async deleteWalkthrough(
    pullRequestId: string,
    walkthroughId: string,
    confirmationToken: string,
  ): Promise<DeletedWalkthrough> {
    this.getWalkthrough(pullRequestId, walkthroughId);
    const uri = `rvw://walkthrough/${walkthroughId}`;
    const current = this.getAnyWalkthroughByUri(uri);
    const preview = await this.getWalkthroughDeletePreview(uri);
    assertDestructiveConfirmation(confirmationToken, preview);
    const deleted = await this.deleteWalkthroughWithPreview(uri, current, preview);
    if (!("pullRequestId" in deleted)) {
      throw new RvwError("INVALID_INPUT", "この操作はPull Request Walkthrough専用です。");
    }
    return deleted;
  }

  async deleteRepositoryWalkthrough(
    repositoryReviewId: string,
    walkthroughId: string,
    confirmationToken: string,
  ): Promise<DeletedRepositoryWalkthrough> {
    this.getRepositoryWalkthrough(repositoryReviewId, walkthroughId);
    const uri = `rvw://walkthrough/${walkthroughId}`;
    const current = this.getAnyWalkthroughByUri(uri);
    const preview = await this.getWalkthroughDeletePreview(uri);
    assertDestructiveConfirmation(confirmationToken, preview);
    const deleted = await this.deleteWalkthroughWithPreview(uri, current, preview);
    if (!("repositoryReviewId" in deleted)) {
      throw new RvwError("INVALID_INPUT", "この操作はRepository Walkthrough専用です。");
    }
    return deleted;
  }

  async replyToComment(
    uriOrId: string,
    input: {
      body: string;
      relatedCommitOid?: string | null;
      authorLabel?: string | null;
      references?: CodeReference[];
      idempotencyKey?: string;
      lastModifiedBy?: CommentPostModifier;
    },
  ) {
    const id = uriOrId.startsWith("rvw://") ? parseCommentUri(uriOrId) : uriOrId;
    const comment = this.database.getComment(id);
    assertAuthorLabel(input.authorLabel);
    assertIdempotencyKey(input.idempotencyKey);
    const body = assertTextBody(input.body);
    const references = input.references ?? [];
    if (!comment) {
      const repositoryComment = this.database.getRepositoryComment(id);
      if (!repositoryComment) {
        throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。", { status: 404 });
      }
      const resolved = await this.resolveBoundRepositoryArtifactContext(
        this.getRepositoryReview(repositoryComment.repositoryReviewId),
      );
      const { repositoryReview } = resolved;
      const writeContext = this.repositoryReviewWriteContext(resolved);
      await this.validateCodeReferences(repositoryReview, {
        sourceOid: input.relatedCommitOid ?? null,
        body,
        references,
        subject: "comment reply",
      });
      const write = (): CommentPost =>
        this.database.insertRepositoryReply(
          id,
          {
            ...input,
            body,
            references,
            ...(input.idempotencyKey === undefined
              ? {}
              : {
                  idempotencyRequestHash: idempotencyRequestHash({
                    operation: "comment.reply",
                    reviewKind: "repository",
                    commentId: id,
                    body,
                    relatedCommitOid: input.relatedCommitOid ?? null,
                    authorLabel: input.authorLabel ?? null,
                    references,
                  }),
                }),
          },
          writeContext,
        );
      return input.relatedCommitOid
        ? await this.writeWithRepositoryRetainedCommit(resolved, input.relatedCommitOid, write)
        : write();
    }
    const pullRequest = this.getPullRequest(comment.pullRequestId);
    await this.validateCodeReferences(pullRequest, {
      sourceOid: input.relatedCommitOid ?? null,
      body,
      references,
      subject: "comment reply",
    });
    const write = (): CommentPost =>
      this.database.insertReply(id, {
        ...input,
        body,
        references,
        ...(input.lastModifiedBy === undefined ? {} : { lastModifiedBy: input.lastModifiedBy }),
        ...(input.idempotencyKey === undefined
          ? {}
          : {
              idempotencyRequestHash: idempotencyRequestHash({
                operation: "comment.reply",
                commentId: id,
                body,
                relatedCommitOid: input.relatedCommitOid ?? null,
                authorLabel: input.authorLabel ?? null,
                references,
              }),
            }),
      });
    return input.relatedCommitOid
      ? await this.writeWithRetainedCommit(pullRequest, input.relatedCommitOid, write)
      : write();
  }

  async setCommentResolved(
    uriOrId: string,
    resolved: boolean,
  ): Promise<ReviewComment | RepositoryReviewComment> {
    const id = uriOrId.startsWith("rvw://") ? parseCommentUri(uriOrId) : uriOrId;
    if (!this.database.getComment(id)) {
      const comment = this.database.getRepositoryComment(id);
      if (!comment) {
        throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。", { status: 404 });
      }
      await this.resolveBoundRepositoryArtifactContext(
        this.getRepositoryReview(comment.repositoryReviewId),
      );
      return this.database.setRepositoryCommentResolved(id, resolved);
    }
    return this.database.setCommentResolved(id, resolved);
  }

  async deleteComment(uriOrId: string): Promise<{ id: string; ref: string }> {
    const id = uriOrId.startsWith("rvw://") ? parseCommentUri(uriOrId) : uriOrId;
    if (!this.database.getComment(id)) {
      const comment = this.database.getRepositoryComment(id);
      if (!comment) {
        throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。", { status: 404 });
      }
      await this.resolveBoundRepositoryArtifactContext(
        this.getRepositoryReview(comment.repositoryReviewId),
      );
      return this.database.deleteRepositoryComment(id);
    }
    return this.database.deleteComment(id);
  }

  async updateCommentPost(
    commentId: string,
    postId: string,
    body: string,
    lastModifiedBy?: CommentPostModifier,
  ): Promise<CommentPost> {
    const comment =
      this.database.getComment(commentId) ?? this.database.getRepositoryComment(commentId);
    const post = comment?.posts.find((candidate) => candidate.id === postId);
    if (!comment || !post) {
      throw new RvwError("COMMENT_POST_NOT_FOUND", "コメント投稿が見つかりません。", {
        status: 404,
      });
    }
    const usedReferenceIds = new Set(analyzeReferenceMarkdown(body).referenceIds);
    return await this.editCommentPost(commentId, postId, {
      body,
      references: post.references.filter((reference) => usedReferenceIds.has(reference.id)),
      ...(lastModifiedBy === undefined ? {} : { lastModifiedBy }),
    });
  }

  async editCommentPost(
    uriOrId: string,
    postId: string,
    input: {
      body: string;
      relatedCommitOid?: string | null;
      references?: CodeReference[];
      lastModifiedBy?: CommentPostModifier;
    },
  ): Promise<CommentPost> {
    const commentId = uriOrId.startsWith("rvw://") ? parseCommentUri(uriOrId) : uriOrId;
    const comment = this.database.getComment(commentId);
    const repositoryComment = comment ? null : this.database.getRepositoryComment(commentId);
    if (!comment && !repositoryComment) {
      throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。", { status: 404 });
    }
    const post = (comment ?? repositoryComment)!.posts.find((candidate) => candidate.id === postId);
    if (!post) {
      throw new RvwError("COMMENT_POST_NOT_FOUND", "コメント投稿が見つかりません。", {
        status: 404,
      });
    }
    const body = assertTextBody(input.body);
    const relatedCommitOid =
      input.relatedCommitOid === undefined ? post.relatedCommitOid : input.relatedCommitOid;
    const references = input.references ?? post.references;
    const review = comment
      ? this.getPullRequest(comment.pullRequestId)
      : this.getRepositoryReview(repositoryComment!.repositoryReviewId);
    const repositoryResolved = repositoryComment
      ? await this.resolveBoundRepositoryArtifactContext(review as RepositoryReview)
      : null;
    const repositoryReview = repositoryResolved?.repositoryReview ?? null;
    await this.validateCodeReferences(repositoryReview ?? review, {
      sourceOid: relatedCommitOid,
      body,
      references,
      subject: "comment post",
    });
    const write = (): CommentPost =>
      comment
        ? this.database.updateCommentPost(
            commentId,
            postId,
            body,
            relatedCommitOid,
            references,
            input.lastModifiedBy ?? post.lastModifiedBy,
          )
        : this.database.updateRepositoryCommentPost(
            commentId,
            postId,
            this.repositoryReviewWriteContext(repositoryResolved!),
            body,
            relatedCommitOid,
            references,
            input.lastModifiedBy ?? post.lastModifiedBy,
          );
    if (!relatedCommitOid) return write();
    return comment
      ? await this.writeWithRetainedCommit(review as PullRequest, relatedCommitOid, write)
      : await this.writeWithRepositoryRetainedCommit(repositoryResolved!, relatedCommitOid, write);
  }

  async deleteReply(
    commentId: string,
    postId: string,
  ): Promise<{ commentId: string; postId: string }> {
    const repositoryComment = this.database.getRepositoryComment(commentId);
    if (repositoryComment) {
      await this.resolveBoundRepositoryArtifactContext(
        this.getRepositoryReview(repositoryComment.repositoryReviewId),
      );
      return this.database.deleteRepositoryReply(commentId, postId);
    }
    return this.database.deleteReply(commentId, postId);
  }

  private placePullRequestMarkdownComment(
    comment: Pick<ReviewComment, "pullRequestId" | "target">,
    pullRequest: PullRequest,
  ): CommentPlacement {
    if (
      comment.target.kind !== "document" ||
      comment.target.documentKind !== "pull-request-markdown"
    ) {
      return { outdated: true, range: null, path: null };
    }
    const markdown = buildPullRequestMarkdown(pullRequest.latestTitle, pullRequest.latestBody);
    return { ...placeMutableDocumentComment(comment.target, markdown), path: "Pull Request.md" };
  }

  placeWalkthroughComment(
    comment: Pick<ReviewComment, "pullRequestId" | "target">,
    expectedWalkthroughId?: string,
  ): CommentPlacement {
    if (comment.target.kind !== "walkthrough") {
      return { outdated: true, range: null, path: null };
    }
    if (
      expectedWalkthroughId !== undefined &&
      comment.target.walkthroughId !== expectedWalkthroughId
    ) {
      return { outdated: true, range: null, path: null };
    }
    if (comment.target.startLine === null || comment.target.endLine === null) {
      return { outdated: false, range: null, path: null };
    }
    const walkthrough = this.database.getWalkthrough(comment.target.walkthroughId);
    if (!walkthrough || walkthrough.pullRequestId !== comment.pullRequestId) {
      return { outdated: true, range: null, path: null };
    }
    return { ...placeMutableDocumentComment(comment.target, walkthrough.body), path: null };
  }

  private async resolveRepositoryCommentPath(
    pullRequest: PullRequest,
    source: RepositoryCommentTarget,
    destinationOid: string,
  ): Promise<{ path: string; deleted: boolean }> {
    if (source.sourceOid === destinationOid) {
      return { path: source.path, deleted: false };
    }
    const changes = await this.git.changedFiles(
      pullRequest.localRepositoryPath,
      source.sourceOid,
      destinationOid,
    );
    const change = changes.find((candidate) => candidate.oldPath === source.path);
    if (change?.kind === "deleted" || (change && change.newPath === null)) {
      return { path: source.path, deleted: true };
    }
    return { path: change?.newPath ?? source.path, deleted: false };
  }

  private async placeRepositoryCommentAtPath(
    pullRequest: PullRequest,
    source: RepositoryCommentTarget,
    destinationOid: string,
    destinationPath: string,
  ): Promise<CommentPlacement> {
    const destinationContent = await this.getDocument({
      kind: "repository-file",
      pullRequestId: pullRequest.id,
      sourceOid: destinationOid,
      path: destinationPath,
    });
    if (source.startLine === null || source.endLine === null) {
      return destinationContent.availability === "missing"
        ? { outdated: true, range: null, path: destinationPath }
        : { outdated: false, range: null, path: destinationPath };
    }
    if (destinationContent.availability !== "available") {
      return { outdated: true, range: null, path: destinationPath };
    }
    const sourceContent = await this.getDocument({
      kind: "repository-file",
      pullRequestId: pullRequest.id,
      sourceOid: source.sourceOid,
      path: source.path,
    });
    if (sourceContent.availability !== "available") {
      return { outdated: true, range: null, path: destinationPath };
    }
    const range = mapUnchangedLineRange(
      sourceContent.text ?? "",
      destinationContent.text ?? "",
      source.startLine,
      source.endLine,
    );
    return range
      ? { outdated: false, range, path: destinationPath }
      : { outdated: true, range: null, path: destinationPath };
  }

  async placeComment(
    comment: Pick<ReviewComment, "pullRequestId" | "target">,
    destination: DocumentRef,
  ): Promise<CommentPlacement> {
    if (comment.pullRequestId !== destination.pullRequestId) {
      return { outdated: true, range: null, path: null };
    }
    if (comment.target.kind === "pull-request") return { outdated: false, range: null, path: null };
    if (comment.target.kind === "walkthrough") {
      return this.placeWalkthroughComment(comment);
    }
    if (comment.target.kind === "issue") {
      if (destination.kind !== "issue-markdown" || destination.issueId !== comment.target.issueId) {
        return { outdated: true, range: null, path: null };
      }
      const issue = this.database.getIssue(comment.target.issueId);
      return placeIssueComment(
        comment.target,
        issue,
        issue !== null &&
          this.database.hasReviewIssue("pull-request", comment.pullRequestId, issue.id),
      );
    }
    const pullRequest = this.getPullRequest(comment.pullRequestId);
    if (comment.target.documentKind === "pull-request-markdown") {
      return destination.kind === "pull-request-markdown"
        ? this.placePullRequestMarkdownComment(comment, pullRequest)
        : { outdated: true, range: null, path: null };
    }
    if (destination.kind !== "repository-file") return { outdated: true, range: null, path: null };
    const source = comment.target;
    const resolved = await this.resolveRepositoryCommentPath(
      pullRequest,
      source,
      destination.sourceOid,
    );
    if (resolved.deleted) return { outdated: true, range: null, path: source.path };
    if (resolved.path !== destination.path) {
      return { outdated: true, range: null, path: resolved.path };
    }
    return await this.placeRepositoryCommentAtPath(
      pullRequest,
      source,
      destination.sourceOid,
      resolved.path,
    );
  }

  async placeCommentAtCommit(
    comment: Pick<ReviewComment, "pullRequestId" | "target">,
    destinationOid: string,
  ): Promise<CommentPlacement> {
    const pullRequest = this.getPullRequest(comment.pullRequestId);
    await this.assertCommitAvailable(pullRequest, destinationOid);
    if (comment.target.kind === "pull-request") return { outdated: false, range: null, path: null };
    if (comment.target.kind === "walkthrough") {
      return this.placeWalkthroughComment(comment);
    }
    if (comment.target.kind === "issue") {
      const issue = this.database.getIssue(comment.target.issueId);
      return placeIssueComment(
        comment.target,
        issue,
        issue !== null &&
          this.database.hasReviewIssue("pull-request", comment.pullRequestId, issue.id),
      );
    }
    if (comment.target.documentKind === "pull-request-markdown") {
      return this.placePullRequestMarkdownComment(comment, pullRequest);
    }
    const source = comment.target;
    const resolved = await this.resolveRepositoryCommentPath(pullRequest, source, destinationOid);
    if (resolved.deleted) return { outdated: true, range: null, path: source.path };
    return await this.placeRepositoryCommentAtPath(
      pullRequest,
      source,
      destinationOid,
      resolved.path,
    );
  }

  async getResetPreview(pullRequestId: string): Promise<ResetPreview> {
    const pullRequest = this.getPullRequest(pullRequestId);
    const refs = await this.git.listRefsByPrefix(
      pullRequest.localRepositoryPath,
      `refs/rvw/pr/${pullRequest.number}/`,
    );
    // PR retained refs are immutable evidence. Reset clears SQLite-owned review artifacts but
    // preserves every historical source ref; a future explicit GC can reason about unreferenced
    // refs without racing a concurrent Comment or Walkthrough writer.
    const counts = this.database.getResetCounts(pullRequest.id, 0);
    const reviewChangeSequence = this.database.getReviewChangeSequence(
      "pull-request",
      pullRequest.id,
    );
    return {
      pullRequest,
      counts,
      retainedRefs: refs,
      retainedRefsPreserved: true,
      reviewChangeSequence,
      confirmationToken: destructiveConfirmationToken({
        operation: "pull-request-reset",
        reviewKind: "pull-request",
        reviewId: pullRequest.id,
        reviewChangeSequence,
        counts,
      }),
      confirmationRequired: true,
    };
  }

  async resetPullRequest(
    pullRequestId: string,
    confirmationToken: string,
  ): Promise<{
    pullRequest: PullRequest;
    commits: CommitSummary[];
    deleted: ResetCounts;
  }> {
    const preview = await this.getResetPreview(pullRequestId);
    assertDestructiveConfirmation(confirmationToken, preview);
    const repository = await this.repositoryFor(preview.pullRequest);
    const github = await this.github.getPullRequest(
      preview.pullRequest.url,
      repository.worktreePath,
    );
    const remoteUrl = await this.git.assertBaseRepository(
      repository.worktreePath,
      github.owner,
      github.repository,
    );
    await this.git.ensurePullRequestObjects({
      cwd: repository.worktreePath,
      remoteUrl,
      number: github.number,
      baseRefName: github.baseRefName,
      baseOid: github.baseOid,
      headOid: github.headOid,
    });
    const comparisonBaseOid = await this.git.mergeBase(
      repository.worktreePath,
      github.baseOid,
      github.headOid,
    );
    const currentPreview = await this.getResetPreview(pullRequestId);
    assertDestructiveConfirmation(confirmationToken, currentPreview);
    await this.git.ensureCommitRef(repository.worktreePath, github.number, github.headOid);
    const commits = await this.git.commits(
      repository.worktreePath,
      comparisonBaseOid,
      github.headOid,
    );
    try {
      const pullRequest = this.database.resetPullRequest(
        github,
        {
          localRepositoryPath: repository.worktreePath,
          gitCommonDir: repository.gitCommonDir,
        },
        comparisonBaseOid,
        preview.reviewChangeSequence,
      );
      return {
        pullRequest,
        commits,
        deleted: preview.counts,
      };
    } catch (error) {
      if (asRvwError(error).code === "DESTRUCTIVE_PREVIEW_STALE") {
        throw destructiveStaleErrorWithCurrentPreview(
          error,
          await this.getResetPreview(pullRequestId),
        );
      }
      throw new RvwError("LOCAL_STATE_INCONSISTENT", "reset中にSQLite更新が失敗しました。", {
        cause: error,
        suggestions: [
          "Pull Request reset previewを再取得し、返された最新の確認tokenで再実行してください。",
        ],
      });
    }
  }
}
