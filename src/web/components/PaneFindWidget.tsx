import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DocumentPaneId } from "../document-workspace.js";
import { findPaneRanges, paneFindShadowRoots, type PaneFindOptions } from "../pane-find.js";

interface PaneFindWidgetProps {
  paneId: DocumentPaneId;
  paneElement: HTMLElement | null;
  documentKey: string | null;
  visible: boolean;
  openRequestId: number;
  onClose: () => void;
}

const initialOptions: PaneFindOptions = {
  matchCase: false,
  wholeWord: false,
  useRegularExpression: false,
};

function PreviousMatchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="m4 9 4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function NextMatchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function CloseFindIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

function nodeIsWithin(node: Node, container: Element): boolean {
  let current: Node | null = node;
  while (current) {
    if (current === container) return true;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : current.parentNode;
  }
  return false;
}

function selectionSeed(surface: HTMLElement | null): string | null {
  const selection = window.getSelection();
  if (!surface || !selection || selection.isCollapsed || !selection.anchorNode) return null;
  if (!nodeIsWithin(selection.anchorNode, surface)) return null;
  const value = selection.toString();
  return value && value.length <= 200 && !/[\r\n]/u.test(value) ? value : null;
}

function scrollToRange(range: Range | undefined): void {
  if (!range) return;
  const element =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const target = element?.closest<HTMLElement>("[data-line]") ?? element;
  target?.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
}

export function PaneFindWidget({
  paneId,
  paneElement,
  documentKey,
  visible,
  openRequestId,
  onClose,
}: PaneFindWidgetProps) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState(initialOptions);
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [invalidRegularExpression, setInvalidRegularExpression] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const currentIndexRef = useRef(0);
  const refreshFrameRef = useRef<number | null>(null);
  const allHighlightName = `rvw-pane-find-${paneId}-match`;
  const currentHighlightName = `rvw-pane-find-${paneId}-current`;

  const clearHighlights = useCallback((): void => {
    CSS.highlights?.delete(allHighlightName);
    CSS.highlights?.delete(currentHighlightName);
  }, [allHighlightName, currentHighlightName]);

  const paintHighlights = useCallback(
    (ranges: Range[], index: number): void => {
      clearHighlights();
      if (!CSS.highlights || ranges.length === 0) return;
      CSS.highlights.set(allHighlightName, new Highlight(...ranges));
      const current = ranges[index];
      if (current) CSS.highlights.set(currentHighlightName, new Highlight(current));
    },
    [allHighlightName, clearHighlights, currentHighlightName],
  );

  const refreshMatches = useCallback(
    (navigate: boolean): void => {
      const surface = paneElement?.querySelector<HTMLElement>("[data-pane-find-surface]") ?? null;
      const result =
        visible && surface
          ? findPaneRanges(surface, query, options)
          : { ranges: [], invalidRegularExpression: false };
      rangesRef.current = result.ranges;
      const nextIndex =
        result.ranges.length === 0
          ? 0
          : Math.min(currentIndexRef.current, result.ranges.length - 1);
      currentIndexRef.current = nextIndex;
      setCurrentIndex(nextIndex);
      setMatchCount(result.ranges.length);
      setInvalidRegularExpression(result.invalidRegularExpression);
      paintHighlights(result.ranges, nextIndex);
      if (visible) {
        paneElement?.setAttribute("data-pane-find-match-count", String(result.ranges.length));
        paneElement?.setAttribute(
          "data-pane-find-current-index",
          result.ranges.length === 0 ? "0" : String(nextIndex + 1),
        );
      } else {
        paneElement?.removeAttribute("data-pane-find-match-count");
        paneElement?.removeAttribute("data-pane-find-current-index");
      }
      if (navigate) scrollToRange(result.ranges[nextIndex]);
    },
    [options, paintHighlights, paneElement, query, visible],
  );

  const scheduleRefresh = useCallback(
    (navigate: boolean): void => {
      if (refreshFrameRef.current !== null) window.cancelAnimationFrame(refreshFrameRef.current);
      refreshFrameRef.current = window.requestAnimationFrame(() => {
        refreshFrameRef.current = null;
        refreshMatches(navigate);
      });
    },
    [refreshMatches],
  );

  useLayoutEffect(() => {
    currentIndexRef.current = 0;
    setCurrentIndex(0);
    scheduleRefresh(Boolean(query));
  }, [documentKey, options, query, scheduleRefresh, visible]);

  useEffect(() => {
    if (!visible || !paneElement) return;
    const observedShadowRoots = new WeakSet<ShadowRoot>();
    const observeShadowRoots = (): void => {
      const surface = paneElement.querySelector<HTMLElement>("[data-pane-find-surface]");
      if (!surface) return;
      for (const root of paneFindShadowRoots(surface)) {
        if (observedShadowRoots.has(root)) continue;
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        observedShadowRoots.add(root);
      }
    };
    const observer = new MutationObserver(() => {
      observeShadowRoots();
      scheduleRefresh(false);
    });
    observer.observe(paneElement, { childList: true, subtree: true, characterData: true });
    observeShadowRoots();
    return () => observer.disconnect();
  }, [paneElement, scheduleRefresh, visible]);

  useEffect(() => {
    if (!visible) {
      clearHighlights();
      paneElement?.removeAttribute("data-pane-find-match-count");
      paneElement?.removeAttribute("data-pane-find-current-index");
      return;
    }
    const surface = paneElement?.querySelector<HTMLElement>("[data-pane-find-surface]") ?? null;
    const seed = selectionSeed(surface);
    if (seed) setQuery(seed);
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [clearHighlights, openRequestId, paneElement, visible]);

  useEffect(
    () => () => {
      if (refreshFrameRef.current !== null) window.cancelAnimationFrame(refreshFrameRef.current);
      clearHighlights();
    },
    [clearHighlights],
  );

  const move = useCallback(
    (direction: 1 | -1): void => {
      const ranges = rangesRef.current;
      if (ranges.length === 0) return;
      const nextIndex = (currentIndexRef.current + direction + ranges.length) % ranges.length;
      currentIndexRef.current = nextIndex;
      setCurrentIndex(nextIndex);
      paintHighlights(ranges, nextIndex);
      paneElement?.setAttribute("data-pane-find-current-index", String(nextIndex + 1));
      scrollToRange(ranges[nextIndex]);
      inputRef.current?.focus({ preventScroll: true });
    },
    [paintHighlights, paneElement],
  );

  useEffect(() => {
    if (!visible) return;
    const handleFindNavigation = (event: KeyboardEvent): void => {
      if (event.key !== "F3" || !paneElement?.classList.contains("active")) return;
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    };
    document.addEventListener("keydown", handleFindNavigation);
    return () => document.removeEventListener("keydown", handleFindNavigation);
  }, [move, visible]);

  if (!visible) return null;
  const status = invalidRegularExpression
    ? "正規表現が無効です"
    : query
      ? matchCount === 0
        ? "0/0"
        : `${currentIndex + 1}/${matchCount}`
      : "";
  const toggleOption = (key: keyof PaneFindOptions): void =>
    setOptions((current) => ({ ...current, [key]: !current[key] }));

  return (
    <div className="pane-find-layer" data-pane-find-ignore>
      <div
        className="pane-find-widget"
        role="search"
        aria-label={`${paneId === "left" ? "左" : "右"}ペイン内を検索`}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          onClose();
        }}
      >
        <div className={`pane-find-input-shell${invalidRegularExpression ? " invalid" : ""}`}>
          <input
            ref={inputRef}
            value={query}
            aria-label="ペイン内を検索"
            aria-invalid={invalidRegularExpression}
            placeholder="検索"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                move(event.shiftKey ? -1 : 1);
                return;
              }
              if (!event.altKey) return;
              const key = event.key.toLowerCase();
              const option =
                key === "c"
                  ? "matchCase"
                  : key === "w"
                    ? "wholeWord"
                    : key === "r"
                      ? "useRegularExpression"
                      : null;
              if (!option) return;
              event.preventDefault();
              toggleOption(option);
            }}
          />
          <button
            type="button"
            className={options.matchCase ? "active" : ""}
            aria-label="大文字と小文字を区別"
            aria-pressed={options.matchCase}
            title="大文字と小文字を区別 (Alt+C)"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => toggleOption("matchCase")}
          >
            Aa
          </button>
          <button
            type="button"
            className={options.wholeWord ? "active" : ""}
            aria-label="単語単位で検索"
            aria-pressed={options.wholeWord}
            title="単語単位で検索 (Alt+W)"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => toggleOption("wholeWord")}
          >
            <span className="pane-find-whole-word">ab</span>
          </button>
          <button
            type="button"
            className={options.useRegularExpression ? "active" : ""}
            aria-label="正規表現を使用"
            aria-pressed={options.useRegularExpression}
            title="正規表現を使用 (Alt+R)"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => toggleOption("useRegularExpression")}
          >
            .*
          </button>
        </div>
        <span
          className={`pane-find-status${invalidRegularExpression ? " invalid" : ""}`}
          role="status"
          aria-live="polite"
          title={status}
        >
          {status}
        </span>
        <button
          type="button"
          className="pane-find-action"
          aria-label="前の一致項目"
          title="前の一致項目 (Shift+Enter)"
          disabled={matchCount === 0}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => move(-1)}
        >
          <PreviousMatchIcon />
        </button>
        <button
          type="button"
          className="pane-find-action"
          aria-label="次の一致項目"
          title="次の一致項目 (Enter)"
          disabled={matchCount === 0}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => move(1)}
        >
          <NextMatchIcon />
        </button>
        <button
          type="button"
          className="pane-find-action"
          aria-label="検索を閉じる"
          title="閉じる (Escape)"
          onClick={onClose}
        >
          <CloseFindIcon />
        </button>
      </div>
    </div>
  );
}
