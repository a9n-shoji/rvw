import { useCallback, useEffect, type RefObject } from "react";
import type { ReviewSidebarMode } from "./components/ReviewSidebar.js";

export function useReviewSidebarSearch({
  searchInputRef,
  onCodeExpandedChange,
  onModeChange,
}: {
  searchInputRef: RefObject<HTMLInputElement | null>;
  onCodeExpandedChange: (expanded: boolean) => void;
  onModeChange: (mode: ReviewSidebarMode) => void;
}): () => void {
  const openSearch = useCallback((): void => {
    onCodeExpandedChange(true);
    onModeChange("search");
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [onCodeExpandedChange, onModeChange, searchInputRef]);

  useEffect(() => {
    const focusFullTextSearch = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "f") {
        return;
      }
      event.preventDefault();
      openSearch();
    };
    document.addEventListener("keydown", focusFullTextSearch);
    return () => document.removeEventListener("keydown", focusFullTextSearch);
  }, [openSearch]);

  return openSearch;
}
