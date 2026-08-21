import type { ReactNode } from "react";
import { FileEntryIcon } from "./FileIcon.js";

function SidebarCommentIcon() {
  return (
    <svg className="sidebar-stack-icon" aria-hidden="true" viewBox="0 0 16 16">
      <path
        fill="currentColor"
        d="M2.75 2A1.75 1.75 0 0 0 1 3.75v6.5C1 11.22 1.78 12 2.75 12H5v2.25a.75.75 0 0 0 1.2.6L10 12h3.25A1.75 1.75 0 0 0 15 10.25v-6.5A1.75 1.75 0 0 0 13.25 2H2.75Zm-.25 1.75a.25.25 0 0 1 .25-.25h10.5a.25.25 0 0 1 .25.25v6.5a.25.25 0 0 1-.25.25H9.5l-3 2.25V10.5H2.75a.25.25 0 0 1-.25-.25v-6.5Z"
      />
    </svg>
  );
}

function SidebarChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg className="sidebar-stack-chevron" aria-hidden="true" viewBox="0 0 16 16">
      <path
        fill="currentColor"
        d={
          expanded
            ? "M3.72 5.97a.75.75 0 0 1 1.06 0L8 9.19l3.22-3.22a.75.75 0 1 1 1.06 1.06l-3.75 3.75a.75.75 0 0 1-1.06 0L3.72 7.03a.75.75 0 0 1 0-1.06Z"
            : "M5.97 3.72a.75.75 0 0 1 1.06 0l3.75 3.75a.75.75 0 0 1 0 1.06l-3.75 3.75a.75.75 0 1 1-1.06-1.06L9.19 8 5.97 4.78a.75.75 0 0 1 0-1.06Z"
        }
      />
    </svg>
  );
}

function SidebarSearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        fill="currentColor"
        d="M6.5 2a4.5 4.5 0 1 0 2.73 8.08l3.35 3.35a.75.75 0 1 0 1.06-1.06l-3.35-3.35A4.5 4.5 0 0 0 6.5 2Zm-3 4.5a3 3 0 1 1 6 0 3 3 0 0 1-6 0Z"
      />
    </svg>
  );
}

function SidebarBackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        fill="currentColor"
        d="M6.78 3.72a.75.75 0 0 1 0 1.06L4.56 7H13a.75.75 0 0 1 0 1.5H4.56l2.22 2.22a.75.75 0 1 1-1.06 1.06l-3.5-3.5a.75.75 0 0 1 0-1.06l3.5-3.5a.75.75 0 0 1 1.06 0Z"
      />
    </svg>
  );
}

export type ReviewSidebarMode = "files" | "search";

export function ReviewSidebar({
  explorer,
  search,
  comments,
  unresolvedCommentCount,
  codeExpanded,
  commentsExpanded,
  mode,
  onOpenSearch,
  onCodeExpandedChange,
  onCommentsExpandedChange,
  onModeChange,
}: {
  explorer: ReactNode;
  search: ReactNode;
  comments: ReactNode;
  unresolvedCommentCount: number;
  codeExpanded: boolean;
  commentsExpanded: boolean;
  mode: ReviewSidebarMode;
  onOpenSearch: () => void;
  onCodeExpandedChange: (expanded: boolean) => void;
  onCommentsExpandedChange: (expanded: boolean) => void;
  onModeChange: (mode: ReviewSidebarMode) => void;
}) {
  return (
    <aside className="sidebar" aria-label="レビューサイドバー">
      <section className={`sidebar-stack sidebar-stack--code${codeExpanded ? " is-expanded" : ""}`}>
        <div className="sidebar-stack-header">
          <button
            type="button"
            className="sidebar-stack-toggle"
            aria-expanded={codeExpanded}
            onClick={() => onCodeExpandedChange(!codeExpanded)}
          >
            <FileEntryIcon kind="file" />
            <span>{mode === "search" ? "コード検索" : "エクスプローラー"}</span>
            <SidebarChevron expanded={codeExpanded} />
          </button>
          <button
            type="button"
            className={`sidebar-stack-action${mode === "search" ? " active" : ""}`}
            aria-label={mode === "search" ? "ファイルツリーに戻る" : "コード検索を開く"}
            aria-pressed={mode === "search"}
            title={mode === "search" ? "ファイルツリーに戻る" : "コード検索 (⌘ / Ctrl Shift F)"}
            onClick={() => {
              if (mode === "search") onModeChange("files");
              else onOpenSearch();
            }}
          >
            {mode === "search" ? <SidebarBackIcon /> : <SidebarSearchIcon />}
          </button>
        </div>
        <div
          className="sidebar-stack-body sidebar-code-body"
          hidden={!codeExpanded || mode !== "files"}
        >
          {explorer}
        </div>
        <div
          className="sidebar-stack-body sidebar-code-body"
          hidden={!codeExpanded || mode !== "search"}
        >
          {search}
        </div>
      </section>
      <section
        className={`sidebar-stack sidebar-stack--comments${commentsExpanded ? " is-expanded" : ""}`}
      >
        <button
          type="button"
          className="sidebar-stack-toggle"
          aria-expanded={commentsExpanded}
          onClick={() => onCommentsExpandedChange(!commentsExpanded)}
        >
          <SidebarCommentIcon />
          <span>コメント</span>
          <span className="sidebar-stack-count">{unresolvedCommentCount}</span>
          <SidebarChevron expanded={commentsExpanded} />
        </button>
        <div className="sidebar-stack-body" hidden={!commentsExpanded}>
          {comments}
        </div>
      </section>
    </aside>
  );
}
