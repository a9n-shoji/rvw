import { changedFilePath } from "../domain/changed-file.js";
import type { ChangedFile, Structure, Walkthrough } from "../domain/models.js";
import { walkthroughReferenceFingerprint } from "../domain/walkthrough-reference.js";
import type { ActiveDocument } from "./document-workspace.js";

type DocumentDisplayMode = "full" | "diff";
type ViewerDisplayMode = "full" | "pull-request" | "range";

export interface DocumentViewerStateContext {
  documentDisplayMode: DocumentDisplayMode;
  displayMode: ViewerDisplayMode;
  selectedOid: string;
  latestHeadOid: string;
  changedFiles: readonly ChangedFile[] | undefined;
  changedFilesLoaded: boolean;
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
  referenceStaleness: ReferenceStaleness | null;
  viewerDocument: ActiveDocument | null;
  walkthrough: Walkthrough | undefined;
  walkthroughLoading: boolean;
  structure: Structure | undefined;
  structureLoading: boolean;
}

export interface ReferenceStaleness {
  headChanged: boolean;
  walkthroughChanged: boolean;
}

function shortOid(oid: string): string {
  return oid.slice(0, 8);
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
  const currentWalkthrough = referenceContext
    ? context.walkthroughDetails.get(referenceContext.walkthroughId)
    : undefined;
  const currentReference = currentWalkthrough?.references.find(
    (candidate) => candidate.id === referenceContext?.referenceId,
  );
  const headChanged = referenceContext?.latestHeadOid !== context.latestHeadOid;
  const walkthroughChanged = Boolean(
    referenceContext &&
    currentWalkthrough &&
    (!currentReference ||
      walkthroughReferenceFingerprint(currentWalkthrough.sourceOid, currentReference) !==
        referenceContext.referenceFingerprint),
  );
  const referenceStaleness =
    referenceContext && (headChanged || walkthroughChanged)
      ? { headChanged, walkthroughChanged }
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
    referenceStaleness,
    viewerDocument,
    walkthrough,
    walkthroughLoading,
    structure,
    structureLoading,
  };
}
