import {
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

const DEFAULT_SIDEBAR_WIDTH = 330;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 560;
const MIN_MAIN_VIEW_WIDTH = 500;
const DEFAULT_PANE_SPLIT = 50;
const MIN_PANE_WIDTH = 280;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function initialSidebarWidth(): number {
  return clamp(Math.round(window.innerWidth * 0.24), DEFAULT_SIDEBAR_WIDTH, 430);
}

export function ReviewWorkspace({
  sidebar,
  leftPane,
  rightPane,
}: {
  sidebar: ReactNode;
  leftPane: ReactNode;
  rightPane?: ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [paneSplit, setPaneSplit] = useState(DEFAULT_PANE_SPLIT);
  const [resizingSurface, setResizingSurface] = useState<"sidebar" | "panes" | null>(null);
  const rightPaneVisible = rightPane !== undefined;

  const updateSidebarWidth = (clientX: number, workspace: HTMLElement): void => {
    const bounds = workspace.getBoundingClientRect();
    const dynamicMaximum = Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(MAX_SIDEBAR_WIDTH, bounds.width - MIN_MAIN_VIEW_WIDTH),
    );
    setSidebarWidth(clamp(clientX - bounds.left, MIN_SIDEBAR_WIDTH, dynamicMaximum));
  };
  const updatePaneSplit = (clientX: number, mainView: HTMLElement): void => {
    const bounds = mainView.getBoundingClientRect();
    const minimumWidth = Math.min(MIN_PANE_WIDTH, Math.max(160, (bounds.width - 48) / 2));
    const minimumPercent = (minimumWidth / bounds.width) * 100;
    const nextPercent = ((clientX - bounds.left) / bounds.width) * 100;
    setPaneSplit(clamp(nextPercent, minimumPercent, 100 - minimumPercent));
  };
  const finishResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizingSurface(null);
  };

  return (
    <div
      className={`workspace${resizingSurface ? " is-resizing" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      {sidebar}
      <div
        className={`horizontal-resize-handle sidebar-resize-handle${resizingSurface === "sidebar" ? " active" : ""}`}
        role="separator"
        aria-label="サイドバーの幅を変更"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setResizingSurface("sidebar");
          updateSidebarWidth(event.clientX, event.currentTarget.parentElement!);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          updateSidebarWidth(event.clientX, event.currentTarget.parentElement!);
        }}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={() => setResizingSurface(null)}
        onDoubleClick={() => setSidebarWidth(initialSidebarWidth())}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setSidebarWidth((width) =>
            clamp(
              width + (event.key === "ArrowLeft" ? -16 : 16),
              MIN_SIDEBAR_WIDTH,
              MAX_SIDEBAR_WIDTH,
            ),
          );
        }}
      />
      <section
        id="review-main-content"
        tabIndex={-1}
        className={`main-view${rightPaneVisible ? " two-pane" : ""}${resizingSurface === "panes" ? " is-resizing" : ""}`}
        style={
          rightPaneVisible
            ? {
                gridTemplateColumns: `minmax(${MIN_PANE_WIDTH}px, ${paneSplit}fr) 6px minmax(${MIN_PANE_WIDTH}px, ${100 - paneSplit}fr)`,
              }
            : undefined
        }
      >
        {leftPane}
        {rightPaneVisible && (
          <div
            className={`horizontal-resize-handle pane-resize-handle${resizingSurface === "panes" ? " active" : ""}`}
            role="separator"
            aria-label="左右ペインの幅を変更"
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(paneSplit)}
            tabIndex={0}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setResizingSurface("panes");
              updatePaneSplit(event.clientX, event.currentTarget.parentElement!);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              updatePaneSplit(event.clientX, event.currentTarget.parentElement!);
            }}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onLostPointerCapture={() => setResizingSurface(null)}
            onDoubleClick={() => setPaneSplit(DEFAULT_PANE_SPLIT)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              setPaneSplit((split) => clamp(split + (event.key === "ArrowLeft" ? -2 : 2), 20, 80));
            }}
          />
        )}
        {rightPane}
      </section>
    </div>
  );
}
