import { createHash } from "node:crypto";
import path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { STRUCTURE_NODE_NOTATIONS } from "../domain/models.js";
import type {
  ChangedFile,
  CodeReference,
  CommentPlacement,
  CommentPlacementBatchResult,
  CommentPlacementDestination,
  CommentPost,
  CommentPostModifier,
  CommentPostEvent,
  CommentTarget,
  CommitSummary,
  DiffDocumentRef,
  DeletedStructure,
  DocumentAvailability,
  DocumentContent,
  DocumentRef,
  FileStructureReference,
  FileStructureReferenceIndex,
  GitHubPullRequest,
  PullRequest,
  PullRequestSummary,
  ResetCounts,
  ReviewComment,
  SearchResponse,
  SearchOptions,
  SourceAnchor,
  Structure,
  StructureDeleteCounts,
  StructureEdge,
  StructureNode,
  StructureNodeNotation,
  StructureSourceLocator,
  StructureSourceResolution,
  StructureSummary,
  TreeEntry,
  DeletedWalkthrough,
  Walkthrough,
  WalkthroughDeleteCounts,
  WalkthroughReference,
  SourceReferenceFileTarget,
  SourceReferenceResolution,
  WalkthroughSummary,
} from "../domain/models.js";
import { parseCommentUri } from "../domain/comment-uri.js";
import {
  formatCommentWatchCursor,
  parseCommentWatchCursor,
} from "../domain/comment-watch-cursor.js";
import { parseWalkthroughUri } from "../domain/walkthrough-uri.js";
import { parseStructureUri } from "../domain/structure-uri.js";
import { mapUnchangedLineRange, placeMutableDocumentComment } from "../domain/line-mapping.js";
import {
  closestMatchingStructureNode,
  sourceAnchorFingerprint,
  structureSourceAnchor,
} from "../domain/source-reference.js";
import { buildPullRequestMarkdown, hashDocument, selectedLineText } from "../domain/pr-markdown.js";
import { createSourceExcerpt, type SourceExcerpt } from "../domain/source-excerpt.js";
import {
  DEFAULT_COMMENT_LIST_LIMIT,
  DEFAULT_PULL_REQUEST_LIST_LIMIT,
  DEFAULT_COMMENT_WATCH_LIMIT,
  GIT_OBJECT_ID_PATTERN,
  MAX_AUTHOR_LABEL_CHARACTERS,
  MAX_COMMENT_BODY_BYTES,
  MAX_COMMENT_LIST_LIMIT,
  MAX_PULL_REQUEST_LIST_LIMIT,
  MAX_COMMENT_WATCH_LIMIT,
  MAX_IDEMPOTENCY_KEY_CHARACTERS,
  MAX_SEARCH_QUERY_BYTES,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_STDOUT_BYTES,
  MAX_STRUCTURE_DESCRIPTION_CHARACTERS,
  MAX_STRUCTURE_EDGE_ANCHORS,
  MAX_STRUCTURE_EDGES,
  MAX_STRUCTURE_ID_CHARACTERS,
  MAX_STRUCTURE_KIND_CHARACTERS,
  MAX_STRUCTURE_LABEL_CHARACTERS,
  MAX_STRUCTURE_NODES,
  MAX_STRUCTURE_PAYLOAD_BYTES,
  MAX_STRUCTURE_SCOPE_CHARACTERS,
  MAX_STRUCTURE_SOURCE_ANCHORS,
  MAX_STRUCTURE_TITLE_CHARACTERS,
  STRUCTURE_ID_PATTERN,
  MAX_WALKTHROUGH_BODY_BYTES,
  MAX_CODE_REFERENCE_DESCRIPTION_CHARACTERS,
  MAX_CODE_REFERENCE_LABEL_CHARACTERS,
  MAX_CODE_REFERENCE_PATH_CHARACTERS,
  MAX_CODE_REFERENCES,
  MAX_WALKTHROUGH_TITLE_CHARACTERS,
} from "../shared/constants.js";
import { findFixedStringMatches } from "../domain/search.js";
import { asRvwError, RvwError, type SerializedRvwError } from "../shared/errors.js";
import {
  canonicalGitHubAttachmentUrl,
  detectImageContentType,
  type ImageContentType,
} from "../shared/image-assets.js";
import {
  analyzeWalkthroughHtmlPreview,
  MAX_WALKTHROUGH_HTML_IMAGES,
  type HtmlPreviewAnalysis,
} from "../shared/walkthrough-html.js";
import { RvwDatabase, type CommentUpdateInput } from "../infrastructure/db/database.js";
import { GitClient, type RepositoryContext } from "../infrastructure/git/git-client.js";
import { parsePullRequestUrl, type GitHubPort } from "../infrastructure/github/github-client.js";

export interface OpenResult {
  pullRequest: PullRequest;
  fromCache: boolean;
}

export interface PullRequestView {
  pullRequest: PullRequest;
  comparisonBaseOid: string;
  headOid: string;
  commits: CommitSummary[];
}

export interface PullRequestList {
  items: PullRequestSummary[];
  pagination: {
    offset: number;
    limit: number;
    returned: number;
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
}

export interface PullRequestStatusRefreshResult {
  attempted: number;
  updated: number;
  failures: Array<{
    pullRequestId: string;
    owner: string;
    repository: string;
    number: number;
    error: SerializedRvwError;
  }>;
}

export interface SyncResult extends PullRequestView {
  commentUpdatesApplied: number;
}

export interface ResetPreview {
  pullRequest: PullRequest;
  counts: ResetCounts;
  confirmationRequired: true;
}

export interface CommentUpdateRequest {
  commentRef: string;
  reply: string;
  resolve: boolean;
  authorLabel?: string | null;
  references?: CodeReference[] | undefined;
  idempotencyKey?: string | undefined;
}

export interface CommentCreateRequest {
  pullRequest: string;
  target: CommentTargetRequest;
  body: string;
  authorLabel?: string | null;
  relatedCommitOid?: string | null;
  references?: CodeReference[] | undefined;
}

export interface CommentExactSource {
  sourceOid: string;
  path: string;
  availability: DocumentAvailability;
  excerpt: SourceExcerpt | null;
}

export interface CommentReviewContext {
  pullRequest: PullRequest;
  comment: ReviewComment;
  latestPlacement: CommentPlacement;
  exactSource: CommentExactSource | null;
  walkthrough: Walkthrough | null;
  githubState: {
    liveCheckedAt: string | null;
    staleAgainstGitHub: boolean | null;
    live: GitHubPullRequest | null;
  };
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
}

export interface WalkthroughPublishRequest extends WalkthroughContentRequest {
  pullRequest: string;
}

export type WalkthroughUpdateRequest = WalkthroughContentRequest;

export interface WalkthroughDeletePreview {
  walkthrough: Walkthrough;
  counts: WalkthroughDeleteCounts;
  confirmationRequired: true;
}

export interface SourceAnchorRequest {
  path: string;
  startLine?: number | null;
  endLine?: number | null;
}

export interface StructureNodeRequest {
  id: string;
  label: string;
  description?: string | null;
  kind?: string | null;
  notation?: StructureNodeNotation;
  anchor?: SourceAnchorRequest | null;
}

export interface StructureEdgeRequest {
  id: string;
  from: string;
  to: string;
  label: string;
  directed: boolean;
  anchors?: SourceAnchorRequest[];
}

export interface StructureContentRequest {
  sourceOid: string;
  title: string;
  scope: string;
  originNodeId: string;
  nodes: StructureNodeRequest[];
  edges: StructureEdgeRequest[];
}

export interface StructurePublishRequest extends StructureContentRequest {
  pullRequest: string;
  idempotencyKey: string;
}

export interface StructureUpdateRequest extends StructureContentRequest {
  expectedUpdatedAt: string;
}

export interface StructureDeletePreview {
  structure: Structure;
  counts: StructureDeleteCounts;
  confirmationRequired: true;
}

export type CommentTargetRequest =
  | { kind: "pull-request" }
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

const codeReferenceIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const walkthroughDiagramNodePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

interface MarkdownNode {
  type: string;
  url?: unknown;
  identifier?: unknown;
  lang?: unknown;
  value?: unknown;
  children?: MarkdownNode[];
  position?: {
    start: { line: number };
    end: { line: number };
  };
}

interface ResolvedSourceFile {
  path: string;
  document: DocumentContent;
}

function structureSummary(structure: Structure): StructureSummary {
  return {
    id: structure.id,
    ref: structure.ref,
    pullRequestId: structure.pullRequestId,
    sourceOid: structure.sourceOid,
    title: structure.title,
    scope: structure.scope,
    createdAt: structure.createdAt,
    updatedAt: structure.updatedAt,
  };
}

export interface WalkthroughMarkdownAnalysis {
  referenceIds: string[];
  mermaidNodeIds: Set<string>;
  htmlPreviews: HtmlPreviewAnalysis[];
}

const mermaidIdentifierPattern = /[A-Za-z][A-Za-z0-9_-]{0,63}/g;
const mermaidEdgePattern = /[<|o*x]*[-.=~]{2,}[|o*x>]*/g;
const mermaidClassShorthandPattern = /:::[A-Za-z][A-Za-z0-9_-]*(?:,[A-Za-z][A-Za-z0-9_-]*)*/g;
const flowchartAndClassKeywords = new Set([
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
const noMermaidKeywords = new Set<string>();

function mermaidIdentifiers(value: string, excludedKeywords: ReadonlySet<string>): string[] {
  return [...value.matchAll(mermaidIdentifierPattern)]
    .map(([identifier]) => identifier)
    .filter((identifier) => !excludedKeywords.has(identifier));
}

function mermaidLineWithoutComment(value: string): string {
  const commentIndex = value.indexOf("%%");
  return commentIndex === -1 ? value : value.slice(0, commentIndex);
}

function mermaidLineWithoutClassShorthand(value: string): string {
  return value.replace(mermaidClassShorthandPattern, "");
}

function mermaidLineWithoutLabels(value: string): string {
  const uncommented = mermaidLineWithoutComment(value);
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

function addMermaidEdgeEndpoints(
  line: string,
  nodeIds: Set<string>,
  excludedKeywords: ReadonlySet<string>,
): void {
  const endpointLine = mermaidLineWithoutClassShorthand(line);
  const edges = [...endpointLine.matchAll(mermaidEdgePattern)];
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]!;
    const edgeStart = edge.index;
    const edgeEnd = edgeStart + edge[0].length;
    const leftStart = index === 0 ? 0 : edges[index - 1]!.index + edges[index - 1]![0].length;
    const rightEnd = index + 1 === edges.length ? endpointLine.length : edges[index + 1]!.index;
    const left = endpointLine.slice(leftStart, edgeStart);
    const right = endpointLine.slice(edgeEnd, rightEnd);
    const leftIdentifiers = mermaidIdentifiers(left, excludedKeywords);
    const rightIdentifiers = mermaidIdentifiers(right, excludedKeywords);
    const leftEndpoints = left.includes("&") ? leftIdentifiers : leftIdentifiers.slice(-1);
    const rightEndpoints = right.includes("&") ? rightIdentifiers : rightIdentifiers.slice(0, 1);
    for (const identifier of [...leftEndpoints, ...rightEndpoints]) nodeIds.add(identifier);
  }
}

function addSequenceMessageParticipants(line: string, nodeIds: Set<string>): void {
  const message = line.match(
    /^([A-Za-z][A-Za-z0-9_-]{0,63})\s*<*[-=]+[)>x]+\s*[+-]?([A-Za-z][A-Za-z0-9_-]{0,63})\b/,
  );
  if (!message) return;
  nodeIds.add(message[1]!);
  nodeIds.add(message[2]!);
}

const erCardinalitySource = [
  "one\\s+or\\s+zero",
  "one\\s+or\\s+(?:more|many)",
  "zero\\s+or\\s+(?:one|more|many)",
  "only\\s+one",
  "many\\([01]\\)",
  "[01]\\+",
  "many",
  "one",
  "\\d+(?:\\.\\d+)?",
].join("|");
const erTextualRelationshipPattern = new RegExp(
  `^([A-Za-z][A-Za-z0-9_-]{0,63})\\s+(?:${erCardinalitySource})\\s+(?:to|optionally\\s+to)\\s+(?:${erCardinalitySource})\\s+([A-Za-z][A-Za-z0-9_-]{0,63})\\b`,
  "i",
);

function addErRelationshipEntities(line: string, nodeIds: Set<string>): void {
  const relationship =
    line.match(
      /^([A-Za-z][A-Za-z0-9_-]{0,63})\s+[|o}{]+[.-]{2}[|o}{]+\s+([A-Za-z][A-Za-z0-9_-]{0,63})\b/,
    ) ?? line.match(erTextualRelationshipPattern);
  if (!relationship) return;
  nodeIds.add(relationship[1]!);
  nodeIds.add(relationship[2]!);
}

function addMermaidDiagramNodes(source: string, nodeIds: Set<string>): void {
  const lines = source.split("\n");
  const header = lines
    .map((line) => mermaidLineWithoutLabels(line).trim())
    .find((line) => line.length > 0);
  const diagramType = header?.match(
    /^(flowchart|graph|classDiagram|sequenceDiagram|stateDiagram-v2|erDiagram|architecture-beta)\b/,
  )?.[1];
  if (!diagramType) return;

  for (const rawLine of lines) {
    const diagramLine =
      diagramType === "erDiagram" || diagramType === "sequenceDiagram"
        ? mermaidLineWithoutComment(rawLine)
        : mermaidLineWithoutLabels(rawLine);
    for (const statement of diagramLine.split(";")) {
      const line = statement.trim();
      if (
        !line ||
        /^(flowchart|graph|classDiagram|sequenceDiagram|stateDiagram-v2|erDiagram|architecture-beta)\b/.test(
          line,
        )
      ) {
        continue;
      }
      if (diagramType === "sequenceDiagram") {
        const participant = line.match(
          /^(?:participant|actor)\s+([A-Za-z][A-Za-z0-9_-]{0,63})(?:\s*@\s*\{|\s+as\b|\s*$)/,
        )?.[1];
        if (participant) nodeIds.add(participant);
        else addSequenceMessageParticipants(line, nodeIds);
        continue;
      }
      if (diagramType === "architecture-beta") {
        const service = line.match(/^service\s+([A-Za-z][A-Za-z0-9_-]{0,63})(?:\s|\(|$)/)?.[1];
        if (service) nodeIds.add(service);
        continue;
      }
      if (diagramType === "stateDiagram-v2") {
        addMermaidEdgeEndpoints(line, nodeIds, noMermaidKeywords);
        const alias = line.match(/^state\s+.+?\s+as\s+([A-Za-z][A-Za-z0-9_-]{0,63})\b/)?.[1];
        const declaration = alias
          ? undefined
          : line.match(/^state\s+([A-Za-z][A-Za-z0-9_-]{0,63})(?:\s|\{|$)/)?.[1];
        const describedState = line.match(/^([A-Za-z][A-Za-z0-9_-]{0,63})\s*:/)?.[1];
        const standaloneState = line.match(/^([A-Za-z][A-Za-z0-9_-]{0,63})$/)?.[1];
        for (const identifier of [alias, declaration, describedState, standaloneState]) {
          if (identifier) nodeIds.add(identifier);
        }
        continue;
      }
      if (diagramType === "erDiagram") {
        const entityLine = mermaidLineWithoutClassShorthand(line);
        addErRelationshipEntities(entityLine, nodeIds);
        const entity = entityLine.match(
          /^([A-Za-z][A-Za-z0-9_-]{0,63})(?:\s*\[[^\]\n]+\])?\s*(?:\{|$)/,
        )?.[1];
        if (entity) nodeIds.add(entity);
        continue;
      }
      addMermaidEdgeEndpoints(line, nodeIds, flowchartAndClassKeywords);
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

export function analyzeReferenceMarkdown(
  body: string,
  options: { htmlPreviews?: boolean } = {},
): WalkthroughMarkdownAnalysis {
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
  const htmlPreviews: HtmlPreviewAnalysis[] = [];
  visit(root, (node) => {
    if (node.type === "link" && typeof node.url === "string") urls.push(node.url);
    if (node.type === "linkReference" && typeof node.identifier === "string") {
      const url = definitions.get(node.identifier);
      if (url) urls.push(url);
    }
    if (node.type === "code" && node.lang === "mermaid" && typeof node.value === "string") {
      addMermaidDiagramNodes(node.value, mermaidNodeIds);
    }
    if (
      options.htmlPreviews &&
      node.type === "code" &&
      node.lang === "html-preview" &&
      typeof node.value === "string"
    ) {
      htmlPreviews.push(analyzeWalkthroughHtmlPreview(node.value, node.position?.start.line ?? 1));
    }
  });
  const htmlImageCount = htmlPreviews.reduce((count, preview) => count + preview.imageCount, 0);
  if (htmlImageCount > MAX_WALKTHROUGH_HTML_IMAGES) {
    throw new RvwError(
      "INVALID_INPUT",
      `html-preview画像はWalkthrough全体で${MAX_WALKTHROUGH_HTML_IMAGES}件以下にしてください。`,
    );
  }
  return {
    referenceIds: [
      ...urls
        .filter((url) => url.startsWith("rvw-ref:"))
        .map((url) => url.slice("rvw-ref:".length)),
      ...htmlPreviews.flatMap((preview) => preview.referenceIds),
    ],
    mermaidNodeIds,
    htmlPreviews,
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

interface CommentPlacementRequestContext {
  commitAvailability: Map<string, Promise<void>>;
  changedFiles: Map<string, Promise<ChangedFile[]>>;
  documents: Map<string, Promise<DocumentContent>>;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => await worker()),
  );
  return results;
}

export class RvwService {
  constructor(
    readonly database: RvwDatabase,
    readonly git: GitClient,
    readonly github: GitHubPort,
  ) {}

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
  }> {
    const [git, github] = await Promise.all([this.git.doctor(cwd), this.github.doctor()]);
    const databaseWriteProbe = this.database.writeProbe();
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

  private assertRepositoryMatch(pullRequest: PullRequest, repository: RepositoryContext): void {
    if (path.resolve(pullRequest.gitCommonDir) !== path.resolve(repository.gitCommonDir)) {
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
      ? cwdRepository &&
        path.resolve(cwdRepository.gitCommonDir) === path.resolve(explicitlyStored.gitCommonDir)
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
      this.assertRepositoryMatch(stored, repository);
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

    const github = await this.github.getPullRequest(reference, repository.worktreePath, {
      allowClosed: stored !== null,
    });
    const existing = this.database.findPullRequestByIdentity(
      github.owner,
      github.repository,
      github.number,
    );
    if (existing) this.assertRepositoryMatch(existing, repository);
    const pullRequest = await this.synchronizeGithub(github, repository, []);
    return { pullRequest, fromCache: false };
  }

  getPullRequest(id: string): PullRequest {
    const pullRequest = this.database.getPullRequest(id);
    if (!pullRequest)
      throw new RvwError("PR_NOT_FOUND", "Pull Requestが見つかりません。", { status: 404 });
    return pullRequest;
  }

  listPullRequests(input: {
    offset?: number | undefined;
    limit?: number | undefined;
    hideClosedOrMerged?: boolean | undefined;
  }): PullRequestList {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? DEFAULT_PULL_REQUEST_LIST_LIMIT;
    const hideClosedOrMerged = input.hideClosedOrMerged ?? true;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RvwError("INVALID_INPUT", "offsetは0以上の整数にしてください。");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PULL_REQUEST_LIST_LIMIT) {
      throw new RvwError(
        "INVALID_INPUT",
        `limitは1以上${MAX_PULL_REQUEST_LIST_LIMIT}以下の整数にしてください。`,
      );
    }
    const page = this.database.listPullRequestSummaries(offset, limit, hideClosedOrMerged);
    const returned = page.items.length;
    const hasMore = offset + returned < page.total;
    return {
      items: page.items,
      pagination: {
        offset,
        limit,
        returned,
        total: page.total,
        hasMore,
        nextOffset: hasMore ? offset + returned : null,
      },
    };
  }

  async refreshPullRequestStatuses(): Promise<PullRequestStatusRefreshResult> {
    const pullRequests = this.database.listPullRequestsNeedingStatusRefresh();
    if (pullRequests.length === 0) {
      return { attempted: 0, updated: 0, failures: [] };
    }
    const outcomes = await this.github.getPullRequestStatuses(
      pullRequests.map((pullRequest) => pullRequest.url),
    );
    if (outcomes.length !== pullRequests.length) {
      throw new RvwError("GITHUB_ERROR", "Pull Request状態の一括取得件数が一致しません。", {
        status: 502,
      });
    }
    const successful = outcomes.flatMap((outcome, index) => {
      const pullRequest = pullRequests[index];
      return outcome.status === "fulfilled" && pullRequest
        ? [{ pullRequestId: pullRequest.id, ...outcome.value }]
        : [];
    });
    this.database.updatePullRequestGitHubStatuses(successful);
    const failures = outcomes.flatMap((outcome, index) => {
      const pullRequest = pullRequests[index];
      return outcome.status === "rejected" && pullRequest
        ? [
            {
              pullRequestId: pullRequest.id,
              owner: pullRequest.owner,
              repository: pullRequest.repository,
              number: pullRequest.number,
              error: asRvwError(outcome.error).toJSON(),
            },
          ]
        : [];
    });
    return {
      attempted: pullRequests.length,
      updated: successful.length,
      failures,
    };
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
    this.assertRepositoryMatch(pullRequest, repository);
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
  ): Promise<PullRequest> {
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
    return updates.length > 0
      ? this.database.syncPullRequestAndComments(
          github,
          repositoryLocation,
          comparisonBaseOid,
          updates,
        )
      : this.database.upsertPullRequest(github, repositoryLocation, comparisonBaseOid);
  }

  async refreshPullRequest(id: string): Promise<SyncResult> {
    const current = this.getPullRequest(id);
    const repository = await this.repositoryFor(current);
    const github = await this.github.getPullRequest(current.url, repository.worktreePath, {
      allowClosed: true,
    });
    const pullRequest = await this.synchronizeGithub(github, repository, []);
    return { ...(await this.getPullRequestView(pullRequest.id)), commentUpdatesApplied: 0 };
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
    this.assertRepositoryMatch(current, repository);
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
    const github = await this.github.getPullRequest(current.url, repository.worktreePath, {
      allowClosed: true,
    });
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
    const pullRequest = await this.synchronizeGithub(github, repository, updates);
    return {
      ...(await this.getPullRequestView(pullRequest.id)),
      commentUpdatesApplied: updates.length,
    };
  }

  async attachPullRequest(reference: string, repositoryPath: string): Promise<PullRequest> {
    const pullRequest = this.resolveStoredPullRequest(reference);
    const repository = await this.git.repositoryContext(repositoryPath);
    this.assertRepositoryMatch(pullRequest, repository);
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
    pullRequest: PullRequest,
    input: {
      sourceOid: string | null;
      body: string;
      references: CodeReference[];
      additionalUsedReferenceIds?: Iterable<string>;
      markdownAnalysis?: WalkthroughMarkdownAnalysis;
      subject: string;
    },
  ): Promise<WalkthroughMarkdownAnalysis> {
    const markdown = input.markdownAnalysis ?? analyzeReferenceMarkdown(input.body);
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
    if (input.sourceOid) await this.assertCommitAvailable(pullRequest, input.sourceOid);

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
      const content = await this.getDocument({
        kind: "repository-file",
        pullRequestId: pullRequest.id,
        sourceOid: input.sourceOid!,
        path: reference.path,
      });
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
      ? await this.writeWithRetainedCommit(pullRequest, input.relatedCommitOid, "comment", write)
      : write();
  }

  async createCommentForReference(input: CommentCreateRequest): Promise<ReviewComment> {
    const pullRequest = this.resolveStoredPullRequest(input.pullRequest);
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

  async getCommentReviewContext(
    uri: string,
    options: { live?: boolean } = {},
  ): Promise<CommentReviewContext> {
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
          { allowClosed: true },
        )
      : null;
    const staleAgainstGitHub = live
      ? live.title !== result.pullRequest.latestTitle ||
        live.body !== result.pullRequest.latestBody ||
        live.headRepositoryOwner !== result.pullRequest.latestHeadRepositoryOwner ||
        live.headRepositoryName !== result.pullRequest.latestHeadRepositoryName ||
        live.baseOid !== result.pullRequest.latestBaseOid ||
        live.headOid !== result.pullRequest.latestHeadOid ||
        live.updatedAt !== result.pullRequest.githubUpdatedAt ||
        live.state !== result.pullRequest.githubState ||
        live.isDraft !== result.pullRequest.githubIsDraft
      : null;
    return {
      ...result,
      latestPlacement,
      exactSource,
      walkthrough,
      githubState: {
        liveCheckedAt: live ? new Date().toISOString() : null,
        staleAgainstGitHub,
        live,
      },
    };
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

  listWalkthroughs(pullRequestId: string): WalkthroughSummary[] {
    this.getPullRequest(pullRequestId);
    return this.database.listWalkthroughs(pullRequestId);
  }

  listStructures(pullRequestId: string): StructureSummary[] {
    this.getPullRequest(pullRequestId);
    return this.database.listStructures(pullRequestId);
  }

  async listFileStructureReferences(
    pullRequestId: string,
    targetSourceOid: string,
    targetPath: string,
  ): Promise<FileStructureReference[]> {
    assertCodeReferencePath(targetPath);
    const index = await this.listFileStructureReferenceIndex(pullRequestId, targetSourceOid);
    return index.entries.find(({ path: candidate }) => candidate === targetPath)?.references ?? [];
  }

  async listFileStructureReferenceIndex(
    pullRequestId: string,
    targetSourceOid: string,
  ): Promise<FileStructureReferenceIndex> {
    const pullRequest = this.getPullRequest(pullRequestId);
    const structures = this.database.listStructures(pullRequestId).flatMap((summary) => {
      const structure = this.database.getStructure(summary.id);
      return structure?.pullRequestId === pullRequestId ? [structure] : [];
    });
    if (structures.length === 0) return { sourceOid: targetSourceOid, entries: [] };
    await this.assertCommitAvailable(pullRequest, targetSourceOid);
    const treePaths = (await this.git.tree(pullRequest.localRepositoryPath, targetSourceOid)).map(
      (entry) => entry.path,
    );
    const targetPaths = new Set(treePaths);

    const successorIndexes = new Map<string, Promise<Map<string, ReadonlySet<string>>>>();
    const successorIndex = (sourceOid: string): Promise<Map<string, ReadonlySet<string>>> => {
      const key = JSON.stringify([sourceOid, targetSourceOid]);
      const cached = successorIndexes.get(key);
      if (cached) return cached;
      const index = this.git
        .changedFilesWithCopies(pullRequest.localRepositoryPath, sourceOid, targetSourceOid)
        .then((changes) => {
          const successors = new Map<string, Set<string>>();
          for (const candidate of changes) {
            if (
              (!candidate.status.startsWith("R") && !candidate.status.startsWith("C")) ||
              candidate.oldPath === null ||
              candidate.newPath === null
            ) {
              continue;
            }
            const paths = successors.get(candidate.oldPath) ?? new Set<string>();
            paths.add(candidate.newPath);
            successors.set(candidate.oldPath, paths);
          }
          return successors;
        });
      successorIndexes.set(key, index);
      return index;
    };
    const resolvePath = (sourceOid: string, sourcePath: string): Promise<string | null> => {
      if (targetPaths.has(sourcePath)) return Promise.resolve(sourcePath);
      if (sourceOid === targetSourceOid) return Promise.resolve(null);
      return successorIndex(sourceOid).then((index) => {
        const successors = index.get(sourcePath);
        if (successors?.size !== 1) return null;
        const successor = [...successors][0]!;
        return targetPaths.has(successor) ? successor : null;
      });
    };

    const referencesByPath = new Map<string, FileStructureReference[]>();
    for (const structure of structures) {
      const matchingNodeIdsByPath = new Map<string, Set<string>>();
      for (const node of structure.nodes) {
        if (!node.anchor) continue;
        const resolvedPath = await resolvePath(structure.sourceOid, node.anchor.path);
        if (!resolvedPath) continue;
        const nodeIds = matchingNodeIdsByPath.get(resolvedPath) ?? new Set<string>();
        nodeIds.add(node.id);
        matchingNodeIdsByPath.set(resolvedPath, nodeIds);
      }
      for (const [resolvedPath, matchingNodeIds] of matchingNodeIdsByPath) {
        const targetNode = closestMatchingStructureNode(structure, matchingNodeIds);
        if (!targetNode) continue;
        const references = referencesByPath.get(resolvedPath) ?? [];
        references.push({
          structure: structureSummary(structure),
          targetNodeId: targetNode.id,
          targetNodeLabel: targetNode.label,
          matchingNodeCount: matchingNodeIds.size,
        });
        referencesByPath.set(resolvedPath, references);
      }
    }
    return {
      sourceOid: targetSourceOid,
      entries: treePaths.flatMap((path) => {
        const references = referencesByPath.get(path);
        return references ? [{ path, references }] : [];
      }),
    };
  }

  listStructuresByReference(reference: string): {
    pullRequest: PullRequest;
    structures: StructureSummary[];
  } {
    const pullRequest = this.resolveStoredPullRequest(reference);
    return { pullRequest, structures: this.database.listStructures(pullRequest.id) };
  }

  getStructure(pullRequestId: string, structureId: string): Structure {
    this.getPullRequest(pullRequestId);
    const structure = this.database.getStructure(structureId);
    if (!structure || structure.pullRequestId !== pullRequestId) {
      throw new RvwError("NOT_FOUND", "Structureが見つかりません。", { status: 404 });
    }
    return structure;
  }

  getStructureByUri(uri: string): { pullRequest: PullRequest; structure: Structure } {
    const structure = this.database.getStructure(parseStructureUri(uri));
    if (!structure) {
      throw new RvwError("NOT_FOUND", "Structureが見つかりません。", { status: 404 });
    }
    return {
      pullRequest: this.getPullRequest(structure.pullRequestId),
      structure,
    };
  }

  private async validateSourceAnchor(
    pullRequest: PullRequest,
    sourceOid: string,
    anchor: SourceAnchorRequest,
    subject: string,
    documents: Map<string, Promise<DocumentContent>>,
  ): Promise<SourceAnchor> {
    assertCodeReferencePath(anchor.path);
    const startLine = anchor.startLine ?? null;
    const endLine = anchor.endLine ?? null;
    assertLinePair(startLine, endLine);
    let contentPromise = documents.get(anchor.path);
    if (!contentPromise) {
      contentPromise = this.getDocument({
        kind: "repository-file",
        pullRequestId: pullRequest.id,
        sourceOid,
        path: anchor.path,
      });
      documents.set(anchor.path, contentPromise);
    }
    const content = await contentPromise;
    if (content.availability !== "available") {
      throw new RvwError("INVALID_INPUT", `${subject}のsourceを表示できません: ${anchor.path}`);
    }
    this.validateLineRange(content.text ?? "", startLine, endLine, subject);
    return { path: anchor.path, startLine, endLine };
  }

  private assertStructureText(value: string, maximum: number, subject: string): string {
    const normalized = value.trim();
    if (normalized.length === 0 || value.length > maximum) {
      throw new RvwError("INVALID_INPUT", `${subject}は1〜${maximum}文字にしてください。`);
    }
    return normalized;
  }

  private assertStructureId(value: string, subject: string): string {
    if (!STRUCTURE_ID_PATTERN.test(value)) {
      throw new RvwError(
        "INVALID_INPUT",
        `${subject}は英字で始まる英数字・_・-の1〜${MAX_STRUCTURE_ID_CHARACTERS}文字にしてください。`,
      );
    }
    return value;
  }

  private normalizeOptionalStructureText(
    value: string | null | undefined,
    maximum: number,
    subject: string,
  ): string | null {
    if (value === null || value === undefined) return null;
    if (value.length > maximum) {
      throw new RvwError("INVALID_INPUT", `${subject}が長すぎます。`);
    }
    return value.trim() || null;
  }

  private async validateStructureContent(
    pullRequest: PullRequest,
    input: StructureContentRequest,
  ): Promise<Omit<Structure, "id" | "ref" | "pullRequestId" | "createdAt" | "updatedAt">> {
    await this.assertCommitAvailable(pullRequest, input.sourceOid);
    const title = this.assertStructureText(
      input.title,
      MAX_STRUCTURE_TITLE_CHARACTERS,
      "Structure title",
    );
    const scope = this.assertStructureText(
      input.scope,
      MAX_STRUCTURE_SCOPE_CHARACTERS,
      "Structure scope",
    );
    if (input.nodes.length < 1 || input.nodes.length > MAX_STRUCTURE_NODES) {
      throw new RvwError(
        "INVALID_INPUT",
        `Structure Nodeは1〜${MAX_STRUCTURE_NODES}件にしてください。`,
      );
    }
    if (input.edges.length > MAX_STRUCTURE_EDGES) {
      throw new RvwError(
        "INVALID_INPUT",
        `Structure Edgeは${MAX_STRUCTURE_EDGES}件以下にしてください。`,
      );
    }
    const documents = new Map<string, Promise<DocumentContent>>();
    const nodeIds = new Set<string>();
    const nodes: StructureNode[] = [];
    for (const node of input.nodes) {
      const id = this.assertStructureId(node.id, "Structure Node ID");
      if (nodeIds.has(id)) {
        throw new RvwError("INVALID_INPUT", `Structure Node IDが重複しています: ${id}`);
      }
      nodeIds.add(id);
      const label = this.assertStructureText(
        node.label,
        MAX_STRUCTURE_LABEL_CHARACTERS,
        `Structure Node ${id} label`,
      );
      const notation = node.notation ?? "plain";
      if (!STRUCTURE_NODE_NOTATIONS.includes(notation)) {
        throw new RvwError("INVALID_INPUT", `Structure Node ${id} notationが不正です。`);
      }
      nodes.push({
        id,
        label,
        description: this.normalizeOptionalStructureText(
          node.description,
          MAX_STRUCTURE_DESCRIPTION_CHARACTERS,
          `Structure Node ${id} description`,
        ),
        kind: this.normalizeOptionalStructureText(
          node.kind,
          MAX_STRUCTURE_KIND_CHARACTERS,
          `Structure Node ${id} kind`,
        ),
        notation,
        anchor: node.anchor
          ? await this.validateSourceAnchor(
              pullRequest,
              input.sourceOid,
              node.anchor,
              `Structure Node ${id}`,
              documents,
            )
          : null,
      });
    }
    const edgeIds = new Set<string>();
    const edges: StructureEdge[] = [];
    for (const edge of input.edges) {
      const id = this.assertStructureId(edge.id, "Structure Edge ID");
      if (edgeIds.has(id)) {
        throw new RvwError("INVALID_INPUT", `Structure Edge IDが重複しています: ${id}`);
      }
      edgeIds.add(id);
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        throw new RvwError(
          "INVALID_INPUT",
          `Structure Edge ${id} のendpointが存在しません: ${edge.from} → ${edge.to}`,
        );
      }
      if (typeof edge.directed !== "boolean") {
        throw new RvwError("INVALID_INPUT", `Structure Edge ${id} のdirectedが必要です。`);
      }
      const anchors = edge.anchors ?? [];
      if (anchors.length > MAX_STRUCTURE_EDGE_ANCHORS) {
        throw new RvwError(
          "INVALID_INPUT",
          `Structure Edge ${id} のanchorは${MAX_STRUCTURE_EDGE_ANCHORS}件以下にしてください。`,
        );
      }
      edges.push({
        id,
        from: edge.from,
        to: edge.to,
        label: this.assertStructureText(
          edge.label,
          MAX_STRUCTURE_LABEL_CHARACTERS,
          `Structure Edge ${id} label`,
        ),
        directed: edge.directed,
        anchors: await Promise.all(
          anchors.map((anchor, index) =>
            this.validateSourceAnchor(
              pullRequest,
              input.sourceOid,
              anchor,
              `Structure Edge ${id} anchor ${index + 1}`,
              documents,
            ),
          ),
        ),
      });
    }
    if (typeof input.originNodeId !== "string") {
      throw new RvwError("INVALID_INPUT", "originNodeIdが必要です。");
    }
    const originNodeId = this.assertStructureId(input.originNodeId, "Structure originNodeId");
    if (!nodeIds.has(originNodeId)) {
      throw new RvwError("INVALID_INPUT", `originNodeId Nodeが存在しません: ${originNodeId}`);
    }
    const originNode = nodes.find((node) => node.id === originNodeId)!;
    if (originNode.anchor === null) {
      throw new RvwError("INVALID_INPUT", "Structure origin Nodeにはsource anchorが必要です。");
    }
    const neighbors = new Map(nodes.map((node) => [node.id, new Set<string>()]));
    for (const edge of edges) {
      neighbors.get(edge.from)!.add(edge.to);
      neighbors.get(edge.to)!.add(edge.from);
    }
    const reached = new Set([originNodeId]);
    const queue = [originNodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of neighbors.get(current) ?? []) {
        if (reached.has(neighbor)) continue;
        reached.add(neighbor);
        queue.push(neighbor);
      }
    }
    const disconnected = nodes.filter((node) => !reached.has(node.id)).map((node) => node.id);
    if (disconnected.length > 0) {
      throw new RvwError(
        "INVALID_INPUT",
        `Structureの全Nodeをoriginから辿れる関係graphにしてください: ${disconnected.join(", ")}`,
      );
    }
    const anchorCount =
      nodes.filter((node) => node.anchor !== null).length +
      edges.reduce((count, edge) => count + edge.anchors.length, 0);
    if (anchorCount < 1) {
      throw new RvwError(
        "INVALID_INPUT",
        "Structureにはsource anchorを少なくとも1件含めてください。",
      );
    }
    if (anchorCount > MAX_STRUCTURE_SOURCE_ANCHORS) {
      throw new RvwError(
        "INVALID_INPUT",
        `Structureのsource anchorは合計${MAX_STRUCTURE_SOURCE_ANCHORS}件以下にしてください。`,
      );
    }
    const graph = { originNodeId, nodes, edges };
    if (Buffer.byteLength(JSON.stringify(graph), "utf8") > MAX_STRUCTURE_PAYLOAD_BYTES) {
      throw new RvwError(
        "INVALID_INPUT",
        `Structure payloadは${MAX_STRUCTURE_PAYLOAD_BYTES} UTF-8 bytes以下にしてください。`,
      );
    }
    return { sourceOid: input.sourceOid, title, scope, ...graph };
  }

  async publishStructure(input: StructurePublishRequest): Promise<Structure> {
    if (typeof input.idempotencyKey !== "string") {
      throw new RvwError("INVALID_INPUT", "idempotencyKeyが必要です。");
    }
    assertIdempotencyKey(input.idempotencyKey);
    const pullRequest = this.resolveStoredPullRequest(input.pullRequest);
    const content = await this.validateStructureContent(pullRequest, input);
    return await this.writeWithRetainedCommit(pullRequest, content.sourceOid, "Structure", () =>
      this.database.createStructure({
        pullRequestId: pullRequest.id,
        ...content,
        idempotencyKey: input.idempotencyKey,
        idempotencyRequestHash: idempotencyRequestHash({
          operation: "structure.publish",
          pullRequestId: pullRequest.id,
          content,
        }),
      }),
    );
  }

  async updateStructure(uri: string, input: StructureUpdateRequest): Promise<Structure> {
    const { pullRequest, structure } = this.getStructureByUri(uri);
    if (typeof input.expectedUpdatedAt !== "string" || input.expectedUpdatedAt.length === 0) {
      throw new RvwError("INVALID_INPUT", "expectedUpdatedAtが必要です。");
    }
    const content = await this.validateStructureContent(pullRequest, input);
    return await this.writeWithRetainedCommit(pullRequest, content.sourceOid, "Structure", () =>
      this.database.updateStructure(structure.id, input.expectedUpdatedAt, content),
    );
  }

  getStructureDeletePreview(uri: string): StructureDeletePreview {
    const { structure } = this.getStructureByUri(uri);
    return {
      structure,
      counts: this.database.getStructureDeleteCounts(structure.id),
      confirmationRequired: true,
    };
  }

  deleteStructureByUri(uri: string, expectedUpdatedAt: string): DeletedStructure {
    const { structure } = this.getStructureByUri(uri);
    return this.database.deleteStructure(structure.id, expectedUpdatedAt);
  }

  deleteStructure(
    pullRequestId: string,
    structureId: string,
    expectedUpdatedAt: string,
  ): DeletedStructure {
    this.getStructure(pullRequestId, structureId);
    return this.database.deleteStructure(structureId, expectedUpdatedAt);
  }

  getWalkthrough(pullRequestId: string, walkthroughId: string): Walkthrough {
    this.getPullRequest(pullRequestId);
    const walkthrough = this.database.getWalkthrough(walkthroughId);
    if (!walkthrough || walkthrough.pullRequestId !== pullRequestId) {
      throw new RvwError("NOT_FOUND", "Walkthroughが見つかりません。", { status: 404 });
    }
    return walkthrough;
  }

  private async sourceReferenceFallbackTarget(
    pullRequest: PullRequest,
    sourceOid: string,
    filePath: string,
  ): Promise<SourceReferenceFileTarget> {
    const diffBaseOid = await this.git.firstParent(pullRequest.localRepositoryPath, sourceOid);
    if (!diffBaseOid) {
      return {
        sourceOid,
        path: filePath,
        diffBaseOid: null,
        oldPath: filePath,
        newPath: filePath,
        hasDiff: false,
      };
    }
    const change = (
      await this.git.changedFiles(pullRequest.localRepositoryPath, diffBaseOid, sourceOid)
    ).find((candidate) => candidate.newPath === filePath);
    return {
      sourceOid,
      path: filePath,
      diffBaseOid,
      oldPath: change?.oldPath ?? filePath,
      newPath: change?.newPath ?? filePath,
      hasDiff: change !== undefined,
    };
  }

  async resolveWalkthroughReference(
    pullRequestId: string,
    walkthroughId: string,
    referenceId: string,
  ): Promise<SourceReferenceResolution> {
    const pullRequest = this.getPullRequest(pullRequestId);
    const walkthrough = this.getWalkthrough(pullRequestId, walkthroughId);
    const reference = walkthrough.references.find((candidate) => candidate.id === referenceId);
    if (!reference) {
      throw new RvwError("NOT_FOUND", "Walkthroughのcode referenceが見つかりません。", {
        status: 404,
      });
    }
    const referenceFingerprint = sourceAnchorFingerprint(walkthrough.sourceOid, reference);
    return await this.resolveSourceAnchor(
      pullRequest,
      walkthrough.sourceOid,
      reference,
      referenceFingerprint,
    );
  }

  async resolveStructureSource(
    pullRequestId: string,
    structureId: string,
    locator: StructureSourceLocator,
  ): Promise<StructureSourceResolution> {
    const pullRequest = this.getPullRequest(pullRequestId);
    const structure = this.getStructure(pullRequestId, structureId);
    const anchor = structureSourceAnchor(structure, locator);
    if (!anchor) {
      throw new RvwError("NOT_FOUND", "Structureの参照元claimが見つかりません。", {
        status: 404,
      });
    }
    const resolution = await this.resolveSourceAnchor(
      pullRequest,
      structure.sourceOid,
      anchor,
      sourceAnchorFingerprint(structure.sourceOid, anchor),
    );
    return { ...resolution, resolvedAnchor: anchor };
  }

  private async resolveSourceAnchor(
    pullRequest: PullRequest,
    sourceOid: string,
    reference: SourceAnchor,
    referenceFingerprint: string,
  ): Promise<SourceReferenceResolution> {
    const sourceDocument = await this.getDocument({
      kind: "repository-file",
      pullRequestId: pullRequest.id,
      sourceOid,
      path: reference.path,
    });
    const latestHeadOid = pullRequest.latestHeadOid;
    const resolvedLatestFile = await this.resolveSourceFileAtCommit(
      pullRequest,
      sourceOid,
      reference.path,
      latestHeadOid,
      sourceDocument,
    );
    const latestPath = resolvedLatestFile?.path ?? null;
    const latestDocument = resolvedLatestFile?.document ?? null;
    const latestFileExists = latestDocument !== null && latestDocument.availability !== "missing";
    const latestFileDisplayable = latestDocument?.availability === "available";
    const mappedRange =
      reference.startLine === null || reference.endLine === null
        ? latestFileDisplayable
          ? null
          : undefined
        : sourceDocument.availability === "available" &&
            latestDocument?.availability === "available"
          ? mapUnchangedLineRange(
              sourceDocument.text ?? "",
              latestDocument.text ?? "",
              reference.startLine,
              reference.endLine,
            )
          : null;
    const resolvedToLatest =
      latestFileDisplayable &&
      (reference.startLine === null || reference.endLine === null || mappedRange !== null);

    if (resolvedToLatest && latestPath !== null && latestDocument !== null) {
      return {
        outcome: "latest",
        anchorSourceOid: sourceOid,
        latestHeadOid,
        referenceFingerprint,
        target: {
          sourceOid: latestHeadOid,
          path: latestPath,
          diffBaseOid: null,
          oldPath: latestPath,
          newPath: latestPath,
          hasDiff: false,
          startLine: mappedRange?.startLine ?? reference.startLine,
          endLine: mappedRange?.endLine ?? reference.endLine,
        },
        latestFile: null,
        document: latestDocument,
      };
    }

    const targetFile = await this.sourceReferenceFallbackTarget(
      pullRequest,
      sourceOid,
      reference.path,
    );
    const latestFile =
      latestFileExists && latestPath !== null
        ? {
            sourceOid: latestHeadOid,
            path: latestPath,
            diffBaseOid: null,
            oldPath: latestPath,
            newPath: latestPath,
            hasDiff: false,
          }
        : null;
    return {
      outcome: "source-fallback",
      anchorSourceOid: sourceOid,
      latestHeadOid,
      referenceFingerprint,
      target: {
        ...targetFile,
        startLine: reference.startLine,
        endLine: reference.endLine,
      },
      latestFile,
      document: sourceDocument,
    };
  }

  private async resolveSourceFileAtCommit(
    pullRequest: PullRequest,
    sourceOid: string,
    sourcePath: string,
    targetSourceOid: string,
    sourceDocument: DocumentContent,
  ): Promise<ResolvedSourceFile | null> {
    const directDocument =
      sourceOid === targetSourceOid
        ? sourceDocument
        : await this.getDocument({
            kind: "repository-file",
            pullRequestId: pullRequest.id,
            sourceOid: targetSourceOid,
            path: sourcePath,
          });
    if (directDocument.availability !== "missing") {
      return { path: sourcePath, document: directDocument };
    }
    if (sourceOid === targetSourceOid) return null;
    const successorPaths = [
      ...new Set(
        (
          await this.git.changedFilesWithCopies(
            pullRequest.localRepositoryPath,
            sourceOid,
            targetSourceOid,
          )
        )
          .filter(
            (candidate) =>
              (candidate.status.startsWith("R") || candidate.status.startsWith("C")) &&
              candidate.oldPath === sourcePath &&
              candidate.newPath !== null,
          )
          .map((candidate) => candidate.newPath!),
      ),
    ];
    if (successorPaths.length !== 1) return null;
    const successorPath = successorPaths[0]!;
    const successorDocument = await this.getDocument({
      kind: "repository-file",
      pullRequestId: pullRequest.id,
      sourceOid: targetSourceOid,
      path: successorPath,
    });
    return successorDocument.availability === "missing"
      ? null
      : { path: successorPath, document: successorDocument };
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

  private async validateWalkthroughContent(
    pullRequest: PullRequest,
    input: WalkthroughContentRequest,
  ): Promise<
    Omit<WalkthroughContentRequest, "diagramBindings"> & {
      diagramBindings: Record<string, string>;
    }
  > {
    await this.assertCommitAvailable(pullRequest, input.sourceOid);
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
    const markdown = analyzeReferenceMarkdown(input.body, { htmlPreviews: true });
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
          `Mermaid binding対象が本文の対応diagramに見つかりません: ${nodeId}`,
        );
      }
    }
    await this.validateCodeReferences(pullRequest, {
      sourceOid: input.sourceOid,
      body: input.body,
      references: input.references,
      additionalUsedReferenceIds: Object.values(diagramBindings),
      markdownAnalysis: markdown,
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
    subject: "comment" | "Walkthrough" | "Structure",
    write: () => T,
  ): Promise<T> {
    const commitRef = await this.git.ensureCommitRef(
      pullRequest.localRepositoryPath,
      pullRequest.number,
      sourceOid,
    );
    try {
      return write();
    } catch (error) {
      if (commitRef.created) {
        try {
          await this.git.deleteRef(pullRequest.localRepositoryPath, commitRef.ref, sourceOid);
        } catch (cleanupError) {
          throw new RvwError(
            "LOCAL_STATE_INCONSISTENT",
            `${subject}の書き込み失敗後にGit refを復元できませんでした。`,
            { cause: cleanupError },
          );
        }
      }
      throw error;
    }
  }

  async publishWalkthrough(input: WalkthroughPublishRequest): Promise<Walkthrough> {
    const pullRequest = this.resolveStoredPullRequest(input.pullRequest);
    const content = await this.validateWalkthroughContent(pullRequest, input);
    return await this.writeWithRetainedCommit(pullRequest, content.sourceOid, "Walkthrough", () =>
      this.database.createWalkthrough({
        pullRequestId: pullRequest.id,
        ...content,
      }),
    );
  }

  async updateWalkthrough(uri: string, input: WalkthroughUpdateRequest): Promise<Walkthrough> {
    const { pullRequest, walkthrough } = this.getWalkthroughByUri(uri);
    const content = await this.validateWalkthroughContent(pullRequest, {
      ...input,
      authorLabel: input.authorLabel === undefined ? walkthrough.authorLabel : input.authorLabel,
    });
    return await this.writeWithRetainedCommit(pullRequest, content.sourceOid, "Walkthrough", () =>
      this.database.updateWalkthrough(walkthrough.id, content),
    );
  }

  getWalkthroughDeletePreview(uri: string): WalkthroughDeletePreview {
    const { walkthrough } = this.getWalkthroughByUri(uri);
    return {
      walkthrough,
      counts: this.database.getWalkthroughDeleteCounts(walkthrough.id),
      confirmationRequired: true,
    };
  }

  deleteWalkthroughByUri(uri: string): DeletedWalkthrough {
    const { walkthrough } = this.getWalkthroughByUri(uri);
    return this.database.deleteWalkthrough(walkthrough.id);
  }

  deleteWalkthrough(pullRequestId: string, walkthroughId: string): DeletedWalkthrough {
    this.getWalkthrough(pullRequestId, walkthroughId);
    return this.database.deleteWalkthrough(walkthroughId);
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
    if (!comment)
      throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。", { status: 404 });
    assertAuthorLabel(input.authorLabel);
    assertIdempotencyKey(input.idempotencyKey);
    const pullRequest = this.getPullRequest(comment.pullRequestId);
    const body = assertTextBody(input.body);
    const references = input.references ?? [];
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
      ? await this.writeWithRetainedCommit(pullRequest, input.relatedCommitOid, "comment", write)
      : write();
  }

  setCommentResolved(uriOrId: string, resolved: boolean): ReviewComment {
    const id = uriOrId.startsWith("rvw://") ? parseCommentUri(uriOrId) : uriOrId;
    return this.database.setCommentResolved(id, resolved);
  }

  deleteComment(uriOrId: string): { id: string; ref: string } {
    const id = uriOrId.startsWith("rvw://") ? parseCommentUri(uriOrId) : uriOrId;
    return this.database.deleteComment(id);
  }

  async updateCommentPost(
    commentId: string,
    postId: string,
    body: string,
    lastModifiedBy?: CommentPostModifier,
  ): Promise<CommentPost> {
    const comment = this.database.getComment(commentId);
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
    if (!comment) {
      throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。", { status: 404 });
    }
    const post = comment.posts.find((candidate) => candidate.id === postId);
    if (!post) {
      throw new RvwError("COMMENT_POST_NOT_FOUND", "コメント投稿が見つかりません。", {
        status: 404,
      });
    }
    const body = assertTextBody(input.body);
    const relatedCommitOid =
      input.relatedCommitOid === undefined ? post.relatedCommitOid : input.relatedCommitOid;
    const references = input.references ?? post.references;
    const pullRequest = this.getPullRequest(comment.pullRequestId);
    await this.validateCodeReferences(pullRequest, {
      sourceOid: relatedCommitOid,
      body,
      references,
      subject: "comment post",
    });
    const write = (): CommentPost =>
      this.database.updateCommentPost(
        commentId,
        postId,
        body,
        relatedCommitOid,
        references,
        input.lastModifiedBy ?? post.lastModifiedBy,
      );
    return relatedCommitOid
      ? await this.writeWithRetainedCommit(pullRequest, relatedCommitOid, "comment", write)
      : write();
  }

  deleteReply(commentId: string, postId: string): { commentId: string; postId: string } {
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
    context: CommentPlacementRequestContext,
  ): Promise<{ path: string; deleted: boolean }> {
    if (source.sourceOid === destinationOid) {
      return { path: source.path, deleted: false };
    }
    const key = JSON.stringify([source.sourceOid, destinationOid]);
    let changesPromise = context.changedFiles.get(key);
    if (!changesPromise) {
      changesPromise = this.git.changedFiles(
        pullRequest.localRepositoryPath,
        source.sourceOid,
        destinationOid,
      );
      context.changedFiles.set(key, changesPromise);
    }
    const changes = await changesPromise;
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
    context: CommentPlacementRequestContext,
  ): Promise<CommentPlacement> {
    const destinationContent = await this.getPlacementDocument(
      pullRequest,
      {
        kind: "repository-file",
        pullRequestId: pullRequest.id,
        sourceOid: destinationOid,
        path: destinationPath,
      },
      context,
    );
    if (source.startLine === null || source.endLine === null) {
      return destinationContent.availability === "missing"
        ? { outdated: true, range: null, path: destinationPath }
        : { outdated: false, range: null, path: destinationPath };
    }
    if (destinationContent.availability !== "available") {
      return { outdated: true, range: null, path: destinationPath };
    }
    const sourceContent = await this.getPlacementDocument(
      pullRequest,
      {
        kind: "repository-file",
        pullRequestId: pullRequest.id,
        sourceOid: source.sourceOid,
        path: source.path,
      },
      context,
    );
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
    const pullRequest = this.getPullRequest(comment.pullRequestId);
    return await this.placeCommentForDestination(
      comment,
      pullRequest,
      { kind: "document", ref: destination },
      this.createCommentPlacementRequestContext(),
    );
  }

  private createCommentPlacementRequestContext(): CommentPlacementRequestContext {
    return {
      commitAvailability: new Map(),
      changedFiles: new Map(),
      documents: new Map(),
    };
  }

  private async assertPlacementCommitAvailable(
    pullRequest: PullRequest,
    oid: string,
    context: CommentPlacementRequestContext,
  ): Promise<void> {
    let available = context.commitAvailability.get(oid);
    if (!available) {
      available = this.assertCommitAvailable(pullRequest, oid);
      context.commitAvailability.set(oid, available);
    }
    await available;
  }

  private async getPlacementDocument(
    pullRequest: PullRequest,
    ref: DocumentRef,
    context: CommentPlacementRequestContext,
  ): Promise<DocumentContent> {
    const key = JSON.stringify(ref);
    let document = context.documents.get(key);
    if (!document) {
      document = (async () => {
        if (ref.kind === "pull-request-markdown") {
          const text = buildPullRequestMarkdown(pullRequest.latestTitle, pullRequest.latestBody);
          return {
            ref,
            availability: "available" as const,
            text,
            byteLength: Buffer.byteLength(text, "utf8"),
            entryKind: "virtual" as const,
            normalizedLineEndings: false,
            oid: null,
          };
        }
        await this.assertPlacementCommitAvailable(pullRequest, ref.sourceOid, context);
        const content = await this.git.readDocument(
          pullRequest.localRepositoryPath,
          ref.sourceOid,
          ref.path,
        );
        return { ref, ...content };
      })();
      context.documents.set(key, document);
    }
    return await document;
  }

  private async placeCommentForDestination(
    comment: Pick<ReviewComment, "pullRequestId" | "target">,
    pullRequest: PullRequest,
    destination: CommentPlacementDestination,
    context: CommentPlacementRequestContext,
  ): Promise<CommentPlacement> {
    if (destination.kind === "walkthrough") {
      return this.placeWalkthroughComment(comment, destination.walkthroughId);
    }
    if (destination.kind === "commit") {
      await this.assertPlacementCommitAvailable(pullRequest, destination.oid, context);
    }
    const documentDestination = destination.kind === "document" ? destination.ref : null;
    const destinationOid =
      destination.kind === "commit"
        ? destination.oid
        : documentDestination?.kind === "repository-file"
          ? documentDestination.sourceOid
          : null;
    if (
      documentDestination !== null &&
      comment.pullRequestId !== documentDestination.pullRequestId
    ) {
      return { outdated: true, range: null, path: null };
    }
    if (comment.target.kind === "pull-request") return { outdated: false, range: null, path: null };
    if (comment.target.kind === "walkthrough") {
      return this.placeWalkthroughComment(comment);
    }
    if (comment.target.documentKind === "pull-request-markdown") {
      return destination.kind === "commit" || documentDestination?.kind === "pull-request-markdown"
        ? this.placePullRequestMarkdownComment(comment, pullRequest)
        : { outdated: true, range: null, path: null };
    }
    if (destinationOid === null) return { outdated: true, range: null, path: null };
    const source = comment.target;
    const resolved = await this.resolveRepositoryCommentPath(
      pullRequest,
      source,
      destinationOid,
      context,
    );
    if (resolved.deleted) return { outdated: true, range: null, path: source.path };
    if (
      documentDestination?.kind === "repository-file" &&
      resolved.path !== documentDestination.path
    ) {
      return { outdated: true, range: null, path: resolved.path };
    }
    return await this.placeRepositoryCommentAtPath(
      pullRequest,
      source,
      destinationOid,
      resolved.path,
      context,
    );
  }

  async placeCommentAtCommit(
    comment: Pick<ReviewComment, "pullRequestId" | "target">,
    destinationOid: string,
  ): Promise<CommentPlacement> {
    const pullRequest = this.getPullRequest(comment.pullRequestId);
    return await this.placeCommentForDestination(
      comment,
      pullRequest,
      { kind: "commit", oid: destinationOid },
      this.createCommentPlacementRequestContext(),
    );
  }

  async resolveCommentPlacements(
    pullRequestId: string,
    commentIds: readonly string[],
    destinations: readonly CommentPlacementDestination[],
  ): Promise<CommentPlacementBatchResult> {
    const pullRequest = this.getPullRequest(pullRequestId);
    const uniqueCommentIds = [...new Set(commentIds)];
    const comments: ReviewComment[] = [];
    const missingCommentIds: string[] = [];
    for (const commentId of uniqueCommentIds) {
      const comment = this.database.getComment(commentId);
      if (!comment) {
        missingCommentIds.push(commentId);
        continue;
      }
      if (comment.pullRequestId !== pullRequestId) {
        throw new RvwError(
          "INVALID_INPUT",
          `別のPull Requestのコメントは一括解決できません: ${commentId}`,
        );
      }
      comments.push(comment);
    }
    const context = this.createCommentPlacementRequestContext();
    return {
      comments: await mapWithConcurrency(comments, 4, async (comment) => {
        const placements = [];
        for (const destination of destinations) {
          placements.push({
            destination,
            placement: await this.placeCommentForDestination(
              comment,
              pullRequest,
              destination,
              context,
            ),
          });
        }
        return { commentId: comment.id, placements };
      }),
      missingCommentIds,
    };
  }

  async getResetPreview(pullRequestId: string): Promise<ResetPreview> {
    const pullRequest = this.getPullRequest(pullRequestId);
    const refs = await this.git.listRefsByPrefix(
      pullRequest.localRepositoryPath,
      `refs/rvw/pr/${pullRequest.number}/`,
    );
    return {
      pullRequest,
      counts: this.database.getResetCounts(pullRequest.id, refs.length),
      confirmationRequired: true,
    };
  }

  async resetPullRequest(pullRequestId: string): Promise<{
    pullRequest: PullRequest;
    commits: CommitSummary[];
    deleted: ResetCounts;
  }> {
    const preview = await this.getResetPreview(pullRequestId);
    const repository = await this.repositoryFor(preview.pullRequest);
    const github = await this.github.getPullRequest(
      preview.pullRequest.url,
      repository.worktreePath,
      { allowClosed: true },
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
    await this.git.replacePullRequestRefsForReset(
      repository.worktreePath,
      github.number,
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
      );
      return {
        pullRequest,
        commits: await this.git.commits(repository.worktreePath, comparisonBaseOid, github.headOid),
        deleted: preview.counts,
      };
    } catch (error) {
      throw new RvwError("LOCAL_STATE_INCONSISTENT", "reset中にSQLite更新が失敗しました。", {
        cause: error,
        suggestions: [`rvw pr reset ${github.url} --yes を再実行してください。`],
      });
    }
  }
}
