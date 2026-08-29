import { changedFilePath } from "../domain/changed-file.js";
import type { ChangedFile, Walkthrough } from "../domain/models.js";
import type { ActiveDocument } from "./document-workspace.js";

type DocumentDisplayMode = "full" | "diff";
type ViewerDisplayMode = "full" | "pull-request" | "range";

export interface DocumentViewerStateContext {
  documentDisplayMode: DocumentDisplayMode;
  displayMode: ViewerDisplayMode;
  selectedOid: string;
  changedFiles: readonly ChangedFile[] | undefined;
  changedFilesLoaded: boolean;
  walkthroughDetails: ReadonlyMap<string, Walkthrough>;
  loadingWalkthroughIds: ReadonlySet<string>;
}

export interface DerivedDocumentViewerState {
  activeChange: ChangedFile | undefined;
  fullViewNotice: string | null;
  fullViewUnavailableMessage: string | null;
  effectiveDisplayMode: ViewerDisplayMode;
  viewerDocument: ActiveDocument | null;
  walkthrough: Walkthrough | undefined;
  walkthroughLoading: boolean;
}

function shortOid(oid: string): string {
  return oid.slice(0, 8);
}

export function deriveDocumentViewerState(
  document: ActiveDocument | null,
  context: DocumentViewerStateContext,
): DerivedDocumentViewerState {
  const usesSelectedRange =
    document?.kind === "repository-file" &&
    document.comparisonPolicy !== "exact-source" &&
    (document.comparisonPolicy !== "reference-target" ||
      document.referenceContext?.outcome === "latest");
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
  const showingFullFallback =
    (context.documentDisplayMode !== "full" && document?.kind === "pull-request-markdown") ||
    selectedRangeFullFallback ||
    referenceTargetFullFallback;
  const fullViewNotice = referenceSourceDiffers
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
  return {
    activeChange,
    fullViewNotice,
    fullViewUnavailableMessage,
    effectiveDisplayMode,
    viewerDocument,
    walkthrough,
    walkthroughLoading,
  };
}
