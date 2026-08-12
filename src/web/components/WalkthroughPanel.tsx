import type { WalkthroughSummary } from "../../domain/models.js";

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

function shortOid(oid: string): string {
  return oid.slice(0, 8);
}

export function WalkthroughPanel({
  walkthroughs,
  activeWalkthroughId,
  onOpen,
}: {
  walkthroughs: WalkthroughSummary[];
  activeWalkthroughId: string | null;
  onOpen: (walkthrough: WalkthroughSummary, openInRightPane: boolean) => void;
}) {
  if (walkthroughs.length === 0) {
    return <p className="walkthrough-panel-empty">Agentからのwalkthroughはまだありません。</p>;
  }
  return (
    <div className="walkthrough-panel-list">
      {walkthroughs.map((walkthrough) => (
        <button
          key={walkthrough.id}
          className={`walkthrough-panel-item${activeWalkthroughId === walkthrough.id ? " active" : ""}`}
          onMouseDown={(event) => {
            if (!event.metaKey && !event.ctrlKey) return;
            event.preventDefault();
            onOpen(walkthrough, true);
          }}
          onClick={(event) => {
            if (!event.metaKey && !event.ctrlKey) onOpen(walkthrough, false);
          }}
          onContextMenu={(event) => {
            if (event.ctrlKey || event.metaKey) event.preventDefault();
          }}
          aria-label={walkthrough.title}
        >
          <span className="walkthrough-panel-item-icon">
            <WalkthroughIcon />
          </span>
          <span className="walkthrough-panel-item-copy">
            <strong>{walkthrough.title}</strong>
            <span>
              {walkthrough.authorLabel ?? "Agent"} · {shortOid(walkthrough.sourceOid)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
