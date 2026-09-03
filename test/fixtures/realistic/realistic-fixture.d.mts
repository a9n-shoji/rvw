import type {
  ChangedFile,
  CommitSummary,
  DocumentAvailability,
  PullRequest,
  ReviewComment,
  Structure,
  TreeEntry,
  TreeEntryKind,
  Walkthrough,
} from "../../../src/domain/models.js";

export const realisticPullRequestId: string;

export interface RealisticFixtureManifest {
  commitCount: number;
  repositoryFileCount: number;
  changedFileCount: number;
  changeKinds: Record<"added" | "modified" | "renamed" | "deleted" | "type-changed", number>;
  changedDirectories: string[];
  layers: string[];
  commentCount: number;
  unresolvedCommentCount: number;
  resolvedCommentCount: number;
  repliedThreadCount: number;
  walkthroughCount: number;
  structureCount: number;
  rename: { oldPath: string; newPath: string; commentId: string };
  deleted: { path: string; commentId: string };
  multiStructurePath: string;
  originKinds: { entry: string; hub: string; terminal: string };
}

export interface RealisticRepositoryDocument {
  availability: DocumentAvailability;
  text: string | null;
  byteLength: number | null;
  entryKind: TreeEntryKind;
  normalizedLineEndings: boolean;
  oid: string | null;
}

export interface RealisticFixture {
  scenario: "realistic";
  pullRequestId: string;
  baseOid: string;
  headOid: string;
  commits: CommitSummary[];
  pullRequest: PullRequest;
  comments: ReviewComment[];
  walkthroughs: Walkthrough[];
  structures: Structure[];
  manifest: RealisticFixtureManifest;
  repositoryRoot: string;
  repositoryEntriesAt(oid: string): TreeEntry[];
  repositoryDocumentAt(oid: string, filePath: string): RealisticRepositoryDocument;
  changedFiles(oldOid: string, newOid: string): ChangedFile[];
  resolvePathAt(sourceOid: string, sourcePath: string, targetOid: string): string | null;
  resolveLineRangeAt(
    sourceOid: string,
    sourcePath: string,
    startLine: number,
    endLine: number,
    targetOid: string,
  ): { startLine: number; endLine: number } | null;
  cleanup(): void;
}

export function createRealisticFixture(): RealisticFixture;
export function validateRealisticFixture(fixture: RealisticFixture): void;
export function readRealisticFixtureManifest(): RealisticFixtureManifest;
