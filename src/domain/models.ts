export interface PullRequestIdentity {
  host: "github.com";
  owner: string;
  repository: string;
  number: number;
  url: string;
}

export interface GitHubPullRequest extends PullRequestIdentity {
  authorLogin: string | null;
  headRepositoryOwner: string | null;
  headRepositoryName: string | null;
  title: string;
  body: string;
  baseRefName: string;
  baseOid: string;
  headRefName: string;
  headOid: string;
  updatedAt: string;
  state: "OPEN";
  isDraft: boolean;
}

export interface PullRequest extends PullRequestIdentity {
  id: string;
  latestAuthorLogin: string | null;
  latestHeadRepositoryOwner: string | null;
  latestHeadRepositoryName: string | null;
  localRepositoryPath: string;
  gitCommonDir: string;
  latestTitle: string;
  latestBody: string;
  latestBaseRefName: string;
  latestHeadRefName: string;
  latestBaseOid: string;
  latestComparisonBaseOid: string;
  latestHeadOid: string;
  githubUpdatedAt: string;
  fetchedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommitSummary {
  oid: string;
  parentOids: string[];
  subject: string;
  authorName: string;
  authoredAt: string;
}

export type DocumentRef =
  | {
      kind: "pull-request-markdown";
      pullRequestId: string;
    }
  | {
      kind: "repository-file";
      pullRequestId: string;
      sourceOid: string;
      path: string;
    };

export interface DiffDocumentRef {
  kind: "diff";
  old: DocumentRef | null;
  new: DocumentRef | null;
}

export type TreeEntryKind = "file" | "symlink" | "submodule";

export interface TreeEntry {
  mode: string;
  type: "blob" | "commit";
  oid: string;
  size: number | null;
  path: string;
  kind: TreeEntryKind;
}

export type ChangeKind = "added" | "deleted" | "modified" | "renamed" | "type-changed";

export interface ChangedFile {
  kind: ChangeKind;
  status: string;
  similarity: number | null;
  oldPath: string | null;
  newPath: string | null;
}

export type DocumentAvailability = "available" | "binary" | "too-large" | "missing";

export interface DocumentContent {
  ref: DocumentRef;
  availability: DocumentAvailability;
  text: string | null;
  byteLength: number | null;
  entryKind: TreeEntryKind | "virtual";
  normalizedLineEndings: boolean;
  oid: string | null;
}

export interface SearchResult {
  document: DocumentRef;
  path: string;
  line: number;
  text: string;
  matches: SearchMatch[];
}

export interface SearchMatch {
  start: number;
  end: number;
}

export interface SearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  matchCount: number;
  truncated: boolean;
  limits: {
    queryBytes: number;
    resultCount: number;
    stdoutBytes: number;
  };
}

export interface CodeReference {
  id: string;
  label: string;
  path: string;
  startLine: number | null;
  endLine: number | null;
  description: string | null;
}

export type WalkthroughReference = CodeReference;

export interface Walkthrough {
  id: string;
  ref: string;
  pullRequestId: string;
  sourceOid: string;
  title: string;
  body: string;
  authorLabel: string | null;
  diagramBindings: Record<string, string>;
  references: WalkthroughReference[];
  createdAt: string;
}

export interface WalkthroughSummary {
  id: string;
  pullRequestId: string;
  sourceOid: string;
  title: string;
  authorLabel: string | null;
  referenceCount: number;
  createdAt: string;
}

export interface WalkthroughDeleteCounts {
  comments: number;
  posts: number;
  references: number;
}

export interface DeletedWalkthrough {
  id: string;
  ref: string;
  pullRequestId: string;
  counts: WalkthroughDeleteCounts;
}

export type CommentTarget =
  | { kind: "pull-request" }
  | {
      kind: "walkthrough";
      walkthroughId: string;
      walkthroughTitle: string;
      sourceDocumentHash: string | null;
      quotedText: string | null;
      startLine: number | null;
      endLine: number | null;
    }
  | {
      kind: "document";
      documentKind: "pull-request-markdown";
      sourceDocumentHash: string;
      quotedText: string | null;
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

export interface CommentPost {
  id: string;
  commentId: string;
  body: string;
  relatedCommitOid: string | null;
  references: CodeReference[];
  authorLabel: string | null;
  isRoot: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CommentPostEvent {
  sequence: number;
  createdAt: string;
  postId: string;
  commentRef: string;
  pullRequestUrl: string;
  deleted: boolean;
}

export interface ReviewComment {
  id: string;
  ref: string;
  pullRequestId: string;
  createdHeadOid: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  target: CommentTarget;
  posts: CommentPost[];
}

export interface MappedRange {
  startLine: number;
  endLine: number;
}

export type CommentPlacement =
  | { outdated: false; range: MappedRange | null; path: string | null }
  | { outdated: true; range: null; path: string | null };

export interface ResetCounts {
  comments: number;
  posts: number;
  commentReferences: number;
  targets: number;
  walkthroughs: number;
  walkthroughReferences: number;
  gitRefs: number;
}
