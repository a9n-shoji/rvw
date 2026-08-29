import { useState } from "react";
import type { StructureFixture } from "../structure-spike/model.js";

export function StructureIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
      <circle cx="3" cy="3" r="1.75" fill="currentColor" />
      <circle cx="13" cy="4" r="1.75" fill="currentColor" />
      <circle cx="5" cy="13" r="1.75" fill="currentColor" />
      <circle cx="12" cy="12" r="1.75" fill="currentColor" />
      <path
        d="m4.5 3.35 6.75.45M3.7 4.55l1.9 6.75m6.25-5.7.05 4.65m-5.2 2.2 3.6-.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function categoryLabel(category: StructureFixture["category"]): string {
  if (category === "Code relationships") return "コード中心";
  if (category === "Flow comparisons") return "フロー比較";
  return "合成グラフ";
}

export function StructureFixtureTree({
  fixtures,
  activeStructureId,
  onOpen,
}: {
  fixtures: StructureFixture[];
  activeStructureId: string | null;
  onOpen: (fixture: StructureFixture, openInRightPane: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const categories = ["Code relationships", "Flow comparisons", "Synthetic"] as const;
  return (
    <>
      <button
        type="button"
        className="file-tree-row review-tree-item review-tree-structures"
        aria-expanded={expanded}
        aria-label={`Structure Spike ${fixtures.length}`}
        onClick={() => setExpanded((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !expanded) return;
          event.preventDefault();
          setExpanded(false);
        }}
      >
        <span className="directory-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="file-tree-icon-group review-tree-structure-icon" aria-hidden="true">
          <StructureIcon />
        </span>
        <span className="file-tree-label">Structure</span>
        <span className="review-tree-spike-badge">Spike</span>
        <span className="review-tree-count">{fixtures.length}</span>
      </button>
      {expanded && (
        <div className="review-tree-structure-list">
          {categories.map((category) => (
            <div key={category}>
              <span className="review-tree-structure-category">{categoryLabel(category)}</span>
              {fixtures
                .filter((fixture) => fixture.category === category)
                .map((fixture) => (
                  <button
                    type="button"
                    key={fixture.structure.id}
                    className={`file-tree-row review-tree-item review-tree-structure${activeStructureId === fixture.structure.id ? " active" : ""}`}
                    onMouseDown={(event) => {
                      if (!event.metaKey && !event.ctrlKey) return;
                      event.preventDefault();
                      onOpen(fixture, true);
                    }}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey) return;
                      onOpen(fixture, false);
                    }}
                    onContextMenu={(event) => {
                      if (event.ctrlKey || event.metaKey) event.preventDefault();
                    }}
                    title={`${fixture.structure.title}\n${fixture.structure.scope}`}
                    aria-label={fixture.structure.title}
                  >
                    <span className="directory-chevron" aria-hidden="true" />
                    <span
                      className="file-tree-icon-group review-tree-structure-icon"
                      aria-hidden="true"
                    >
                      <StructureIcon />
                    </span>
                    <span className="file-tree-label">{fixture.structure.title}</span>
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
