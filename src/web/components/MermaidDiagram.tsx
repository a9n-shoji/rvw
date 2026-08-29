import { useState, type ReactNode } from "react";
import type { ThemePreference } from "../theme.js";
import { MermaidExpandedView, type MermaidReviewWorkspace } from "./MermaidExpandedView.js";

function ExpandIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d="M6.25 2.5H2.5v3.75M9.75 2.5h3.75v3.75M6.25 13.5H2.5V9.75M9.75 13.5h3.75V9.75"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
    </svg>
  );
}

export function MermaidDiagram({
  source,
  themePreference,
  renderIdPrefix,
  review,
  renderInline,
}: {
  source: string;
  themePreference: ThemePreference;
  renderIdPrefix: string;
  review?: MermaidReviewWorkspace | undefined;
  renderInline: (expandButton: ReactNode) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const expandButton = (
    <button
      type="button"
      className="mermaid-expand-button"
      aria-label="Mermaid diagramを拡大"
      aria-haspopup="dialog"
      title="Expand Mermaid diagram"
      onClick={() => setExpanded(true)}
    >
      <ExpandIcon />
    </button>
  );
  return (
    <>
      {renderInline(expandButton)}
      {expanded && (
        <MermaidExpandedView
          source={source}
          themePreference={themePreference}
          renderIdPrefix={renderIdPrefix}
          review={review}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  );
}
