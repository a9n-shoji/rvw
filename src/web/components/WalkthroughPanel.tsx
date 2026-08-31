import { useState } from "react";
import type { StructureSummary, WalkthroughSummary } from "../../domain/models.js";
import { FileEntryIcon } from "./FileIcon.js";

export function WalkthroughIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
      <path
        fill="currentColor"
        d="M2.75 1.5A1.25 1.25 0 0 0 1.5 2.75v10.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25V2.75c0-.69-.56-1.25-1.25-1.25H2.75Zm.25 2h10v7.75H8.8l-2.05 1.7v-1.7H3V3.5Zm2.25 1.25a.75.75 0 1 0 0 1.5h5.5a.75.75 0 0 0 0-1.5h-5.5Zm0 2.75a.75.75 0 1 0 0 1.5h3.5a.75.75 0 0 0 0-1.5h-3.5Z"
      />
    </svg>
  );
}

export function StructureIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
      <path
        fill="currentColor"
        d="M3 1.5A1.5 1.5 0 1 0 3 4.5 1.5 1.5 0 0 0 3 1.5Zm10 0A1.5 1.5 0 1 0 13 4.5 1.5 1.5 0 0 0 13 1.5ZM8 6.5A1.5 1.5 0 1 0 8 9.5 1.5 1.5 0 0 0 8 6.5Zm-5 5A1.5 1.5 0 1 0 3 14.5 1.5 1.5 0 0 0 3 11.5Zm10 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM4.1 4.05l2.8 2.8.7-.7-2.8-2.8-.7.7Zm7.8 0-.7-.7-2.8 2.8.7.7 2.8-2.8Zm-5 5.1-2.8 2.8.7.7 2.8-2.8-.7-.7Zm2.2 0-.7.7 2.8 2.8.7-.7-2.8-2.8Z"
      />
    </svg>
  );
}

export function ReviewTreeItems({
  walkthroughs,
  structures,
  pullRequestActive,
  activeWalkthroughId,
  activeStructureId,
  onOpenPullRequest,
  onOpen,
  onOpenStructure,
}: {
  walkthroughs: WalkthroughSummary[];
  structures: StructureSummary[];
  pullRequestActive: boolean;
  activeWalkthroughId: string | null;
  activeStructureId: string | null;
  onOpenPullRequest: (openInRightPane: boolean) => void;
  onOpen: (walkthrough: WalkthroughSummary, openInRightPane: boolean) => void;
  onOpenStructure: (structure: StructureSummary, openInRightPane: boolean) => void;
}) {
  const [walkthroughsExpanded, setWalkthroughsExpanded] = useState(false);
  const [structuresExpanded, setStructuresExpanded] = useState(false);

  return (
    <nav className="review-tree-items" aria-label="レビュー文書">
      <button
        type="button"
        className={`file-tree-row review-tree-item review-tree-pull-request${pullRequestActive ? " active" : ""}`}
        onMouseDown={(event) => {
          if (!event.metaKey && !event.ctrlKey) return;
          event.preventDefault();
          onOpenPullRequest(true);
        }}
        onClick={(event) => {
          if (!event.metaKey && !event.ctrlKey) onOpenPullRequest(false);
        }}
        onContextMenu={(event) => {
          if (event.ctrlKey || event.metaKey) event.preventDefault();
        }}
        title="Pull Request.md"
        aria-label="Pull Request.md"
      >
        <span className="directory-chevron" aria-hidden="true" />
        <span className="file-tree-icon-group" aria-hidden="true">
          <FileEntryIcon path="Pull Request.md" kind="file" />
        </span>
        <span className="file-tree-label">Pull Request.md</span>
      </button>
      <button
        type="button"
        className="file-tree-row review-tree-item review-tree-walkthroughs"
        aria-expanded={walkthroughsExpanded}
        aria-label={`ウォークスルー ${walkthroughs.length}`}
        disabled={walkthroughs.length === 0}
        onClick={() => setWalkthroughsExpanded((expanded) => !expanded)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !walkthroughsExpanded) return;
          event.preventDefault();
          setWalkthroughsExpanded(false);
        }}
      >
        <span className="directory-chevron" aria-hidden="true">
          {walkthroughsExpanded ? "▾" : "▸"}
        </span>
        <span className="file-tree-icon-group review-tree-walkthrough-icon" aria-hidden="true">
          <WalkthroughIcon />
        </span>
        <span className="file-tree-label">ウォークスルー</span>
        <span className="review-tree-count">{walkthroughs.length}</span>
      </button>
      {walkthroughsExpanded && (
        <div className="review-tree-walkthrough-list">
          {walkthroughs.map((walkthrough) => (
            <button
              type="button"
              key={walkthrough.id}
              className={`file-tree-row review-tree-item review-tree-walkthrough${activeWalkthroughId === walkthrough.id ? " active" : ""}`}
              onMouseDown={(event) => {
                if (!event.metaKey && !event.ctrlKey) return;
                event.preventDefault();
                onOpen(walkthrough, true);
              }}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey) return;
                onOpen(walkthrough, false);
              }}
              onContextMenu={(event) => {
                if (event.ctrlKey || event.metaKey) event.preventDefault();
              }}
              title={`${walkthrough.title}\n${walkthrough.authorLabel ?? "Agent"} · ${walkthrough.sourceOid.slice(0, 8)}`}
              aria-label={walkthrough.title}
            >
              <span className="directory-chevron" aria-hidden="true" />
              <span
                className="file-tree-icon-group review-tree-walkthrough-icon"
                aria-hidden="true"
              >
                <WalkthroughIcon />
              </span>
              <span className="file-tree-label">{walkthrough.title}</span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="file-tree-row review-tree-item review-tree-structures"
        aria-expanded={structuresExpanded}
        aria-label={`Structure ${structures.length}`}
        disabled={structures.length === 0}
        onClick={() => setStructuresExpanded((expanded) => !expanded)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !structuresExpanded) return;
          event.preventDefault();
          setStructuresExpanded(false);
        }}
      >
        <span className="directory-chevron" aria-hidden="true">
          {structuresExpanded ? "▾" : "▸"}
        </span>
        <span className="file-tree-icon-group review-tree-structure-icon" aria-hidden="true">
          <StructureIcon />
        </span>
        <span className="file-tree-label">Structure</span>
        <span className="review-tree-count">{structures.length}</span>
      </button>
      {structuresExpanded && (
        <div className="review-tree-structure-list">
          {structures.map((structure) => (
            <button
              type="button"
              key={structure.id}
              className={`file-tree-row review-tree-item review-tree-structure${activeStructureId === structure.id ? " active" : ""}`}
              onMouseDown={(event) => {
                if (!event.metaKey && !event.ctrlKey) return;
                event.preventDefault();
                onOpenStructure(structure, true);
              }}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey) return;
                onOpenStructure(structure, false);
              }}
              title={`${structure.title}\n${structure.scope}\n${structure.sourceOid.slice(0, 8)}`}
              aria-label={structure.title}
            >
              <span className="directory-chevron" aria-hidden="true" />
              <span className="file-tree-icon-group review-tree-structure-icon" aria-hidden="true">
                <StructureIcon />
              </span>
              <span className="file-tree-label">{structure.title}</span>
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}
