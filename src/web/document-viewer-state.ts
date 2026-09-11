import { changedFilePath } from "../domain/changed-file.js";
import type {
  ChangedFile,
  CommitSummary,
  Structure,
  TreeEntry,
  Walkthrough,
} from "../domain/models.js";
import { sourceAnchorFingerprint, structureSourceAnchor } from "../domain/source-reference.js";
import type { ActiveDocument } from "./document-workspace.js";

type DocumentDisplayMode = "full" | "diff";
type ViewerDisplayMode = "full" | "pull-request" | "range";

export interface DocumentViewerStateContext {
  documentDisplayMode: DocumentDisplayMode;
  displayMode: ViewerDisplayMode;
  selectedOid: string;
  selectedStartOid: string;
  selectedOldOid: string | null;
  latestHeadOid: string;
  commits: readonly CommitSummary[];
  changedFiles: readonly ChangedFile[] | undefined;
  changedFilesLoaded: boolean;
  changedFilesFailed: boolean;
  selectedTreeEntries: readonly TreeEntry[] | undefined;
  selectedTreeLoaded: boolean;
  selectedTreeFailed: boolean;
  walkthroughDetails: ReadonlyMap<string, Walkthrough>;
  loadingWalkthroughIds: ReadonlySet<string>;
  structureDetails?: ReadonlyMap<string, Structure>;
  loadingStructureIds?: ReadonlySet<string>;
}

export interface DerivedDocumentViewerState {
  activeChange: ChangedFile | undefined;
  fullViewNotice: string | null;
  fullViewUnavailableMessage: string | null;
  effectiveDisplayMode: ViewerDisplayMode;
  referenceDisplay: ReferenceDisplayState | null;
  referenceStaleness: ReferenceStaleness | null;
  viewerDocument: ActiveDocument | null;
  walkthrough: Walkthrough | undefined;
  walkthroughLoading: boolean;
  structure: Structure | undefined;
  structureLoading: boolean;
}

export interface ReferenceStaleness {
  headChanged: boolean;
  originChanged: boolean;
  originMissing: boolean;
  originKind: "walkthrough" | "structure";
}

export interface ReferenceDisplayState {
  referenceOid: string;
  referenceSelectionLabel: string;
  referenceComparisonLabel: string;
  globalSelectionLabel: string;
  globalSelectionOidLabel: string;
  globalComparisonLabel: string;
  actionLabel: string;
  actionAccessibleLabel: string;
  targetDocument: Extract<ActiveDocument, { kind: "repository-file" }> | null;
  targetStatus: "ready" | "loading" | "unavailable";
  targetReason: string | null;
}

function shortOid(oid: string): string {
  return oid.slice(0, 8);
}

function matchingChange(
  path: string,
  changedFiles: readonly ChangedFile[] | undefined,
): ChangedFile | undefined {
  return changedFiles?.find(
    (candidate) => candidate.oldPath === path || candidate.newPath === path,
  );
}

function selectedRangeTarget(
  document: Extract<ActiveDocument, { kind: "repository-file" }>,
  context: DocumentViewerStateContext,
): Pick<ReferenceDisplayState, "targetDocument" | "targetStatus" | "targetReason"> {
  const change = matchingChange(document.path, context.changedFiles);
  const changePath = change?.newPath ?? change?.oldPath;
  if (changePath) {
    return {
      targetDocument: { kind: "repository-file", path: changePath },
      targetStatus: "ready",
      targetReason: null,
    };
  }

  const selectedPaths = new Set(context.selectedTreeEntries?.map((entry) => entry.path) ?? []);
  if (selectedPaths.has(document.path)) {
    return {
      targetDocument: { kind: "repository-file", path: document.path },
      targetStatus: "ready",
      targetReason: null,
    };
  }

  const documentedRenamePaths = [document.oldPath, document.newPath].filter(
    (path): path is string => Boolean(path && path !== document.path),
  );
  const existingDocumentedPaths = [...new Set(documentedRenamePaths)].filter((path) =>
    selectedPaths.has(path),
  );
  if (existingDocumentedPaths.length === 1) {
    return {
      targetDocument: { kind: "repository-file", path: existingDocumentedPaths[0]! },
      targetStatus: "ready",
      targetReason: null,
    };
  }

  if (
    (!context.selectedTreeLoaded && !context.selectedTreeFailed) ||
    (!context.changedFilesLoaded && !context.changedFilesFailed)
  ) {
    return {
      targetDocument: null,
      targetStatus: "loading",
      targetReason: "選択中の範囲で同じファイルを確認しています…",
    };
  }
  if (context.selectedTreeFailed || context.changedFilesFailed) {
    return {
      targetDocument: null,
      targetStatus: "unavailable",
      targetReason: "選択中の範囲のファイルまたはrename情報を確認できませんでした。",
    };
  }
  return {
    targetDocument: null,
    targetStatus: "unavailable",
    targetReason: "選択中の範囲に同じpathのファイルがなく、確実なrename先も見つかりません。",
  };
}

interface DisplayComparison {
  kind: "full" | "diff";
  oldOid: string | null;
  newOid: string;
  path: string;
}

function comparisonsMatch(left: DisplayComparison, right: DisplayComparison): boolean {
  return (
    left.kind === right.kind &&
    left.oldOid === right.oldOid &&
    left.newOid === right.newOid &&
    left.path === right.path
  );
}

function globalSelectionPresentation(context: DocumentViewerStateContext): {
  label: string;
  oidLabel: string;
  actionLabel: string;
} {
  const startIndex = context.commits.findIndex((commit) => commit.oid === context.selectedStartOid);
  const endIndex = context.commits.findIndex((commit) => commit.oid === context.selectedOid);
  const isPullRequest =
    startIndex === 0 && endIndex === context.commits.length - 1 && endIndex >= startIndex;
  if (isPullRequest) {
    return {
      label: "PR全体",
      oidLabel: `${context.selectedStartOid} → ${context.selectedOid}`,
      actionLabel: "PR全体で開く",
    };
  }
  if (context.selectedStartOid === context.selectedOid) {
    return {
      label: "選択中のコミット",
      oidLabel: context.selectedOid,
      actionLabel: "選択中のコミットで開く",
    };
  }
  return {
    label: "選択中の範囲",
    oidLabel: `${context.selectedStartOid} → ${context.selectedOid}`,
    actionLabel: "選択中の範囲で開く",
  };
}

function deriveReferenceDisplayState(
  document: ActiveDocument | null,
  context: DocumentViewerStateContext,
  effectiveDisplayMode: ViewerDisplayMode,
): ReferenceDisplayState | null {
  if (
    document?.kind !== "repository-file" ||
    (document.comparisonPolicy !== "exact-source" &&
      document.comparisonPolicy !== "reference-target")
  ) {
    return null;
  }
  const sourceOid = document.sourceOid ?? context.selectedOid;
  const selectedChange = matchingChange(document.path, context.changedFiles);
  const target = selectedRangeTarget(document, context);
  const normalPath = target.targetDocument?.path ?? document.path;
  const normalComparison: DisplayComparison | null =
    context.documentDisplayMode === "full"
      ? { kind: "full", oldOid: null, newOid: context.selectedOid, path: normalPath }
      : selectedChange
        ? {
            kind: "diff",
            oldOid: context.selectedOldOid,
            newOid: context.selectedOid,
            path: normalPath,
          }
        : context.changedFilesLoaded
          ? { kind: "full", oldOid: null, newOid: context.selectedOid, path: normalPath }
          : null;
  const referenceContext = document.referenceContext;
  const referenceUsesSelectedComparison =
    document.comparisonPolicy === "reference-target" &&
    referenceContext?.outcome === "latest" &&
    referenceContext.latestHeadOid === context.selectedOid;
  const currentPath =
    effectiveDisplayMode === "full" ? document.path : (document.newPath ?? document.path);
  const currentComparison: DisplayComparison =
    effectiveDisplayMode === "full"
      ? { kind: "full", oldOid: null, newOid: sourceOid, path: currentPath }
      : referenceUsesSelectedComparison
        ? {
            kind: "diff",
            oldOid: context.selectedOldOid,
            newOid: context.selectedOid,
            path: currentPath,
          }
        : {
            kind: "diff",
            oldOid: referenceContext?.diffBaseOid ?? null,
            newOid: sourceOid,
            path: currentPath,
          };
  if (normalComparison && comparisonsMatch(currentComparison, normalComparison)) return null;
  if (
    !normalComparison &&
    currentComparison.newOid === context.selectedOid &&
    (currentComparison.kind === "full" || currentComparison.oldOid === context.selectedOldOid) &&
    currentComparison.path === normalPath
  ) {
    return null;
  }

  const selection = globalSelectionPresentation(context);
  const referenceSelectionLabel =
    document.comparisonPolicy === "exact-source"
      ? "exact source"
      : referenceContext?.outcome === "source-fallback"
        ? "source fallback"
        : "参照解決時の最新HEAD";
  const referenceComparisonLabel =
    currentComparison.kind === "full"
      ? `${referenceSelectionLabel}の全文`
      : `${referenceSelectionLabel}の比較 · ${currentComparison.oldOid ?? "比較元なし"} → ${currentComparison.newOid}`;
  const globalComparisonLabel =
    context.documentDisplayMode === "full"
      ? `全文 · ${context.selectedOid}`
      : `変更 · ${context.selectedOldOid ?? "比較元なし"} → ${context.selectedOid}${
          selectedChange ? "" : "（差分がなければ全文）"
        }`;
  const actionAccessibleLabel = target.targetDocument
    ? `${selection.actionLabel} · ${target.targetDocument.path}`
    : `${selection.actionLabel}（${target.targetReason ?? "移動先を確認できません"}）`;
  return {
    referenceOid: sourceOid,
    referenceSelectionLabel,
    referenceComparisonLabel,
    globalSelectionLabel: selection.label,
    globalSelectionOidLabel: selection.oidLabel,
    globalComparisonLabel,
    actionLabel: selection.actionLabel,
    actionAccessibleLabel,
    ...target,
  };
}

export function deriveDocumentViewerState(
  document: ActiveDocument | null,
  context: DocumentViewerStateContext,
): DerivedDocumentViewerState {
  const latestReferenceMatchesSelection =
    document?.kind === "repository-file" &&
    document.comparisonPolicy === "reference-target" &&
    document.referenceContext?.outcome === "latest" &&
    document.referenceContext.latestHeadOid === context.selectedOid;
  const referenceContext =
    document?.kind === "repository-file" &&
    document.comparisonPolicy === "reference-target" &&
    document.referenceContext !== undefined
      ? document.referenceContext
      : null;
  const referenceOrigin = referenceContext?.origin;
  const currentWalkthrough =
    referenceOrigin?.kind === "walkthrough"
      ? context.walkthroughDetails.get(referenceOrigin.walkthroughId)
      : undefined;
  const currentReference =
    referenceOrigin?.kind === "walkthrough"
      ? currentWalkthrough?.references.find(
          (candidate) => candidate.id === referenceOrigin.referenceId,
        )
      : undefined;
  const currentStructure =
    referenceOrigin?.kind === "structure"
      ? context.structureDetails?.get(referenceOrigin.structureId)
      : undefined;
  const currentStructureAnchor =
    referenceOrigin?.kind === "structure" && currentStructure
      ? structureSourceAnchor(currentStructure, referenceOrigin.locator)
      : undefined;
  const headChanged = referenceContext?.latestHeadOid !== context.latestHeadOid;
  const originMissing = Boolean(
    referenceContext &&
    (referenceOrigin?.kind === "walkthrough"
      ? currentWalkthrough && !currentReference
      : referenceOrigin?.kind === "structure"
        ? currentStructure && currentStructureAnchor === null
        : false),
  );
  const originChanged = Boolean(
    referenceContext &&
    (referenceOrigin?.kind === "walkthrough"
      ? currentWalkthrough &&
        (!currentReference ||
          sourceAnchorFingerprint(currentWalkthrough.sourceOid, currentReference) !==
            referenceContext.referenceFingerprint)
      : referenceOrigin?.kind === "structure"
        ? currentStructure &&
          (!currentStructureAnchor ||
            sourceAnchorFingerprint(currentStructure.sourceOid, currentStructureAnchor) !==
              referenceContext.referenceFingerprint)
        : false),
  );
  const referenceStaleness =
    referenceContext && referenceOrigin && (headChanged || originChanged)
      ? { headChanged, originChanged, originMissing, originKind: referenceOrigin.kind }
      : null;
  const referenceIsStale = referenceStaleness !== null;
  const usesSelectedRange =
    document?.kind === "repository-file" &&
    document.comparisonPolicy !== "exact-source" &&
    (document.comparisonPolicy !== "reference-target" || latestReferenceMatchesSelection);
  const usesFallbackReferenceTarget =
    document?.kind === "repository-file" &&
    document.comparisonPolicy === "reference-target" &&
    document.referenceContext?.outcome === "source-fallback";
  const activeChange = usesSelectedRange
    ? context.changedFiles?.find((candidate) => {
        const path = changedFilePath(candidate);
        return (
          path === document.path ||
          candidate.oldPath === document.path ||
          candidate.newPath === document.path
        );
      })
    : undefined;
  const forceExactSourceFullView =
    context.documentDisplayMode !== "full" &&
    document?.kind === "repository-file" &&
    document.comparisonPolicy === "exact-source";
  const referenceSourceOid = document?.kind === "repository-file" ? document.sourceOid : undefined;
  const referenceSourceDiffers =
    document?.kind === "repository-file" &&
    document.comparisonPolicy !== "reference-target" &&
    referenceSourceOid !== undefined &&
    referenceSourceOid !== context.selectedOid;
  const selectedRangeFullFallback =
    context.documentDisplayMode !== "full" &&
    usesSelectedRange &&
    context.changedFilesLoaded &&
    !activeChange;
  const referenceTargetFullFallback =
    context.documentDisplayMode !== "full" &&
    usesFallbackReferenceTarget &&
    document.referenceContext?.hasDiff === false;
  const latestReferenceFullFallback =
    context.documentDisplayMode !== "full" &&
    document?.kind === "repository-file" &&
    document.comparisonPolicy === "reference-target" &&
    document.referenceContext?.outcome === "latest" &&
    !latestReferenceMatchesSelection;
  const historicalRangeReferenceFullFallback = latestReferenceFullFallback && !referenceIsStale;
  const showingFullFallback =
    (context.documentDisplayMode !== "full" && document?.kind === "pull-request-markdown") ||
    selectedRangeFullFallback ||
    referenceTargetFullFallback ||
    latestReferenceFullFallback;
  const fullViewNotice = referenceIsStale
    ? null
    : historicalRangeReferenceFullFallback
      ? "選択中の比較範囲は最新HEADで終わっていないため · 最新の全文表示"
      : referenceSourceDiffers
        ? `参照元 ${shortOid(referenceSourceOid)} ≠ 対象 ${shortOid(context.selectedOid)}${
            forceExactSourceFullView
              ? " · 全文表示"
              : showingFullFallback
                ? " · 差分なし · 全文表示"
                : ""
          }`
        : forceExactSourceFullView
          ? "参照元commit · 全文表示"
          : showingFullFallback
            ? "差分なし · 全文表示"
            : null;
  const fullViewUnavailableMessage =
    context.documentDisplayMode === "full" && activeChange?.kind === "deleted"
      ? "このファイルは選択範囲の末尾で削除されているため、全文は利用できません。変更表示で削除前の内容を確認してください。"
      : null;
  const forceFullView = forceExactSourceFullView || showingFullFallback;
  const effectiveDisplayMode: ViewerDisplayMode = forceFullView ? "full" : context.displayMode;
  const referenceDisplay = deriveReferenceDisplayState(document, context, effectiveDisplayMode);
  const viewerDocument: ActiveDocument | null =
    document?.kind === "repository-file" && selectedRangeFullFallback
      ? { ...document, sourceOid: context.selectedOid }
      : document?.kind === "repository-file" && activeChange
        ? {
            ...document,
            path: changedFilePath(activeChange) ?? document.path,
            oldPath: activeChange.oldPath,
            newPath: activeChange.newPath,
          }
        : document;
  const walkthrough =
    viewerDocument?.kind === "walkthrough"
      ? context.walkthroughDetails.get(viewerDocument.id)
      : undefined;
  const walkthroughLoading =
    viewerDocument?.kind === "walkthrough" && context.loadingWalkthroughIds.has(viewerDocument.id);
  const structure =
    viewerDocument?.kind === "structure"
      ? context.structureDetails?.get(viewerDocument.id)
      : undefined;
  const structureLoading =
    viewerDocument?.kind === "structure" &&
    (context.loadingStructureIds?.has(viewerDocument.id) ?? false);
  return {
    activeChange,
    fullViewNotice,
    fullViewUnavailableMessage,
    effectiveDisplayMode,
    referenceDisplay,
    referenceStaleness,
    viewerDocument,
    walkthrough,
    walkthroughLoading,
    structure,
    structureLoading,
  };
}
