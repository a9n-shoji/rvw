import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CommentPlacement, ReviewComment, WalkthroughReference } from "../../domain/models.js";
import {
  MAX_WALKTHROUGH_HTML_REPOSITORY_IMAGE_BYTES,
  MAX_WALKTHROUGH_HTML_REPOSITORY_IMAGES_BYTES,
  renderWalkthroughHtmlPreview,
  resolveWalkthroughRepositoryPath,
} from "../../shared/walkthrough-html.js";
import {
  HtmlPreviewOverlay,
  type HtmlPreviewOverlayAction,
  type HtmlPreviewOverlayMarker,
} from "../html-preview-overlay.js";
import { markdownAssetUrl } from "../markdown-links.js";
import type { MarkdownSourceRange } from "../markdown-source-map.js";
import type { ThemePreference } from "../theme.js";

const minimumFrameHeight = 240;
const maximumFrameHeight = 20_000;
const sourceCommentPattern = /^rvw-source:(\d+):(\d+)$/u;
const allowedImageContentTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
]);

const previewContentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src 'none'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function themeCss(themePreference: ThemePreference): string {
  const dark = `
    --rvw-bg: #161b22;
    --rvw-fg: #e6edf3;
    --rvw-muted: #8b949e;
    --rvw-border: #30363d;
    --rvw-accent: #58a6ff;
    --rvw-panel: #21262d;
    --rvw-highlight: #d29922;
    color-scheme: dark;`;
  const light = `
    --rvw-bg: #ffffff;
    --rvw-fg: #1f2328;
    --rvw-muted: #57606a;
    --rvw-border: #d8dee4;
    --rvw-accent: #0969da;
    --rvw-panel: #f6f8fa;
    --rvw-highlight: #9a6700;
    color-scheme: light;`;
  if (themePreference === "dark") return `:root {${dark}}`;
  if (themePreference === "light") return `:root {${light}}`;
  return `:root {${light} color-scheme: light dark;} @media (prefers-color-scheme: dark) { :root {${dark}} }`;
}

function previewBaseCss(themePreference: ThemePreference): string {
  return `${themeCss(themePreference)}
    *, *::before, *::after { box-sizing: border-box; }
    html { background: transparent; }
    body { margin: 0; overflow-x: auto; overflow-y: hidden; background: var(--rvw-bg); color: var(--rvw-fg); }
    body, button, input, select, textarea { font: 14px/1.5 var(--rvw-font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); }
    code, kbd, pre { font-family: var(--rvw-font-mono, "SFMono-Regular", Consolas, monospace); }
    img, svg { max-width: 100%; }
    a { color: var(--rvw-accent); cursor: pointer; }
    button, input, select, textarea { color: inherit; }
    .rvw-preview-root { min-width: 0; padding: 16px; }
    .rvw-html-image-placeholder { display: grid; min-height: 96px; place-items: center; padding: 16px; border: 1px dashed var(--rvw-border); border-radius: 6px; background: var(--rvw-panel); color: var(--rvw-muted); text-align: center; }
    [data-rvw-comment-surface="true"] { cursor: default; }
    ::highlight(rvw-pane-find-left-match), ::highlight(rvw-pane-find-right-match) { background-color: light-dark(rgb(234 179 8 / 0.42), rgb(250 204 21 / 0.38)); }
    ::highlight(rvw-pane-find-left-current), ::highlight(rvw-pane-find-right-current) { background-color: light-dark(rgb(245 139 10 / 0.82), rgb(249 115 22 / 0.78)); color: light-dark(#17120a, #fff); }
  `;
}

const previewCommentCss = `
  .rvw-html-active-comment {
    outline: 3px solid var(--rvw-highlight) !important;
    outline-offset: 3px !important;
  }
`;

function srcdoc(html: string, themePreference: ThemePreference): string {
  return `<meta http-equiv="Content-Security-Policy" content="${previewContentSecurityPolicy}">
<meta name="color-scheme" content="light dark">
<style>${previewBaseCss(themePreference)}</style>
<div class="rvw-preview-root" data-pane-find-text>${html}</div>
<style>${previewCommentCss}</style>`;
}

function rangeFromElement(element: Element | null): MarkdownSourceRange | null {
  if (!element) return null;
  const sourceElement = element as Element & { dataset: DOMStringMap };
  const startLine = Number(sourceElement.dataset.rvwSourceStartLine);
  const endLine = Number(sourceElement.dataset.rvwSourceEndLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < 1) {
    return null;
  }
  return { startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine) };
}

function eventElement(target: EventTarget | null): Element | null {
  return target && typeof target === "object" && "closest" in target ? (target as Element) : null;
}

function rangesOverlap(left: MarkdownSourceRange, right: MarkdownSourceRange): boolean {
  return left.startLine <= right.endLine && left.endLine >= right.startLine;
}

function elementDepth(element: Element): number {
  let depth = 0;
  let current: Element | null = element;
  while (current) {
    depth += 1;
    current = current.parentElement;
  }
  return depth;
}

function bestElementForRange(document: Document, range: MarkdownSourceRange): Element | null {
  const candidates = [...document.querySelectorAll<Element>("[data-rvw-source-start-line]")]
    .map((element) => ({ element, range: rangeFromElement(element) }))
    .filter(
      (candidate): candidate is { element: Element; range: MarkdownSourceRange } =>
        candidate.range !== null && rangesOverlap(candidate.range, range),
    );
  candidates.sort((left, right) => {
    const leftContains =
      left.range.startLine <= range.startLine && left.range.endLine >= range.endLine ? 0 : 1;
    const rightContains =
      right.range.startLine <= range.startLine && right.range.endLine >= range.endLine ? 0 : 1;
    return (
      leftContains - rightContains ||
      left.range.endLine - left.range.startLine - (right.range.endLine - right.range.startLine) ||
      elementDepth(right.element) - elementDepth(left.element)
    );
  });
  return candidates[0]?.element ?? null;
}

function bytesToDataUrl(bytes: Uint8Array, contentType: string): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${contentType};base64,${window.btoa(binary)}`;
}

async function resolveImages(
  pullRequestId: string,
  sourceOid: string,
  paths: string[],
  signal: AbortSignal,
): Promise<Map<string, string | null>> {
  const uniquePaths = [...new Set(paths)];
  const result = new Map<string, string | null>();
  let totalBytes = 0;
  for (const path of uniquePaths) {
    if (totalBytes >= MAX_WALKTHROUGH_HTML_REPOSITORY_IMAGES_BYTES) {
      result.set(path, null);
      continue;
    }
    try {
      const response = await fetch(markdownAssetUrl(pullRequestId, sourceOid, path), { signal });
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
      const declaredBytes = Number(response.headers.get("content-length"));
      if (
        !response.ok ||
        !contentType ||
        !allowedImageContentTypes.has(contentType) ||
        (Number.isFinite(declaredBytes) &&
          (declaredBytes > MAX_WALKTHROUGH_HTML_REPOSITORY_IMAGE_BYTES ||
            totalBytes + declaredBytes > MAX_WALKTHROUGH_HTML_REPOSITORY_IMAGES_BYTES))
      ) {
        await response.body?.cancel();
        result.set(path, null);
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (
        bytes.byteLength > MAX_WALKTHROUGH_HTML_REPOSITORY_IMAGE_BYTES ||
        totalBytes + bytes.byteLength > MAX_WALKTHROUGH_HTML_REPOSITORY_IMAGES_BYTES
      ) {
        result.set(path, null);
        continue;
      }
      totalBytes += bytes.byteLength;
      result.set(path, bytesToDataUrl(bytes, contentType));
    } catch (error) {
      if (signal.aborted) throw error;
      result.set(path, null);
    }
  }
  return result;
}

export function WalkthroughHtmlPreview({
  source,
  fenceRange,
  pullRequestId,
  sourceOid,
  references,
  placedComments,
  activeCommentId,
  navigationLine,
  themePreference,
  commentComposer,
  onOpenReference,
  onOpenRepositoryLink,
  onCommentRange,
  onActivateComment,
}: {
  source: string;
  fenceRange: MarkdownSourceRange;
  pullRequestId: string;
  sourceOid: string;
  references: ReadonlyMap<string, WalkthroughReference>;
  placedComments: Array<{ comment: ReviewComment; placement: CommentPlacement }>;
  activeCommentId: string | null;
  navigationLine: number | null;
  themePreference: ThemePreference;
  commentComposer: (label: string) => ReactNode;
  onOpenReference: (reference: WalkthroughReference, openInRightPane: boolean) => void;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInRightPane: boolean) => void;
  onCommentRange: (range: MarkdownSourceRange) => void;
  onActivateComment: (commentId: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameShellRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const textRangesRef = useRef(new WeakMap<Text, MarkdownSourceRange>());
  const [resolvedImages, setResolvedImages] = useState<Map<string, string | null>>(new Map());
  const [frameHeight, setFrameHeight] = useState(minimumFrameHeight);
  const [overlayAction, setOverlayAction] = useState<HtmlPreviewOverlayAction | null>(null);
  const [composerAnchor, setComposerAnchor] = useState<HtmlPreviewOverlayAction | null>(null);
  const [markers, setMarkers] = useState<HtmlPreviewOverlayMarker[]>([]);
  const rendered = useMemo(() => {
    try {
      return { value: renderWalkthroughHtmlPreview(source, fenceRange.startLine, resolvedImages) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "HTML previewを表示できません。" };
    }
  }, [fenceRange.startLine, resolvedImages, source]);
  const authoredRepositoryImages = useMemo(() => {
    try {
      return renderWalkthroughHtmlPreview(source, fenceRange.startLine).repositoryImages;
    } catch {
      return [];
    }
  }, [fenceRange.startLine, source]);

  useEffect(() => {
    const controller = new AbortController();
    setResolvedImages(new Map());
    if (authoredRepositoryImages.length > 0) {
      void resolveImages(
        pullRequestId,
        sourceOid,
        authoredRepositoryImages,
        controller.signal,
      ).then(
        (images) => {
          if (!controller.signal.aborted) setResolvedImages(images);
        },
        () => undefined,
      );
    }
    return () => controller.abort();
  }, [authoredRepositoryImages, pullRequestId, sourceOid]);

  const updateLayout = useCallback((): void => {
    const iframe = iframeRef.current;
    const host = hostRef.current;
    const frameShell = frameShellRef.current;
    const document = iframe?.contentDocument;
    if (!iframe || !host || !frameShell || !document) return;
    const contentHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
    );
    const nextHeight = Math.min(maximumFrameHeight, Math.max(minimumFrameHeight, contentHeight));
    setFrameHeight((current) => (Math.abs(current - nextHeight) < 1 ? current : nextHeight));
    if (document.body)
      document.body.style.overflowY = contentHeight > maximumFrameHeight ? "auto" : "hidden";
    const iframeRect = iframe.getBoundingClientRect();
    const frameShellRect = frameShell.getBoundingClientRect();
    setMarkers(
      placedComments.flatMap(({ comment, placement }) => {
        if (placement.outdated || !placement.range) return [];
        const element = bestElementForRange(document, placement.range);
        if (!element) return [];
        const rect = element.getBoundingClientRect();
        return [
          {
            id: comment.id,
            left: iframeRect.left - frameShellRect.left + rect.right,
            top: iframeRect.top - frameShellRect.top + rect.top,
            active: comment.id === activeCommentId,
            label: `${comment.id}のコメントを開く`,
          },
        ];
      }),
    );
  }, [activeCommentId, placedComments]);

  useLayoutEffect(() => {
    updateLayout();
  }, [frameHeight, updateLayout]);

  useEffect(() => {
    const iframe = iframeRef.current;
    const host = hostRef.current;
    const frameShell = frameShellRef.current;
    if (!iframe || !host || !frameShell || !rendered.value) return;
    let detachDocument = (): void => undefined;
    const onLoad = (): void => {
      detachDocument();
      const document = iframe.contentDocument;
      if (!document) return;
      const textRanges = new WeakMap<Text, MarkdownSourceRange>();
      const commentWalker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
      let comment = commentWalker.nextNode();
      while (comment) {
        const match = sourceCommentPattern.exec(comment.nodeValue ?? "");
        const text = comment.nextSibling;
        if (match && text?.nodeType === Node.TEXT_NODE) {
          textRanges.set(text as Text, {
            startLine: Number(match[1]),
            endLine: Number(match[2]),
          });
        }
        comment = commentWalker.nextNode();
      }
      textRangesRef.current = textRanges;

      const actionLeft = (desired: number): number =>
        Math.max(48, Math.min(frameShell.clientWidth - 48, desired));

      const selectionRange = (): { range: MarkdownSourceRange; rect: DOMRect } | null => {
        const selection = document.getSelection();
        if (
          !selection ||
          selection.rangeCount === 0 ||
          selection.isCollapsed ||
          !selection.toString().trim()
        ) {
          return null;
        }
        const domRange = selection.getRangeAt(0);
        const textWalker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
        const ranges: MarkdownSourceRange[] = [];
        let text = textWalker.nextNode();
        while (text) {
          if (domRange.intersectsNode(text)) {
            const mapped = textRanges.get(text as Text);
            if (mapped) ranges.push(mapped);
          }
          text = textWalker.nextNode();
        }
        if (ranges.length === 0) {
          const element =
            domRange.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
              ? (domRange.commonAncestorContainer as Element)
              : domRange.commonAncestorContainer.parentElement;
          const mapped = rangeFromElement(element?.closest("[data-rvw-source-start-line]") ?? null);
          if (mapped) ranges.push(mapped);
        }
        if (ranges.length === 0) return null;
        return {
          range: {
            startLine: Math.min(...ranges.map((range) => range.startLine)),
            endLine: Math.max(...ranges.map((range) => range.endLine)),
          },
          rect: domRange.getBoundingClientRect(),
        };
      };

      const setSelectionAction = (): void => {
        const selected = selectionRange();
        if (!selected) {
          setOverlayAction(null);
          return;
        }
        const iframeRect = iframe.getBoundingClientRect();
        const frameShellRect = frameShell.getBoundingClientRect();
        setOverlayAction({
          range: selected.range,
          left: actionLeft(
            iframeRect.left - frameShellRect.left + selected.rect.left + selected.rect.width / 2,
          ),
          top: iframeRect.top - frameShellRect.top + selected.rect.bottom + 8,
          label: "選択したテキストへコメント",
        });
      };

      const onPointerMove = (event: PointerEvent): void => {
        if (document.getSelection()?.toString().trim()) return;
        const target = eventElement(event.target);
        const surface = target?.closest("[data-rvw-comment-surface='true']") ?? null;
        const range = rangeFromElement(surface);
        if (!surface || !range) {
          setOverlayAction(null);
          return;
        }
        const rect = surface.getBoundingClientRect();
        const iframeRect = iframe.getBoundingClientRect();
        const frameShellRect = frameShell.getBoundingClientRect();
        setOverlayAction({
          range,
          left: actionLeft(iframeRect.left - frameShellRect.left + rect.right),
          top: iframeRect.top - frameShellRect.top + rect.top,
          label: "このvisualへコメント",
        });
      };

      const onKeyDown = (event: KeyboardEvent): void => {
        if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        const isPaneFind = key === "f" && !event.shiftKey;
        const isQuickOpen = key === "p" && !event.shiftKey;
        const isFullTextSearch = key === "f" && event.shiftKey;
        if (!isPaneFind && !isQuickOpen && !isFullTextSearch) return;
        const relayed = new KeyboardEvent("keydown", {
          key: event.key,
          code: event.code,
          location: event.location,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          repeat: event.repeat,
          bubbles: true,
          cancelable: true,
        });
        if (!window.document.dispatchEvent(relayed)) event.preventDefault();
      };

      const onClick = (event: MouseEvent): void => {
        const target = eventElement(event.target);
        const anchor = target?.closest<HTMLAnchorElement>("a[href]");
        if (!anchor) return;
        event.preventDefault();
        event.stopPropagation();
        const href = anchor.getAttribute("href")?.trim() ?? "";
        const openInRightPane = event.metaKey || event.ctrlKey;
        if (href.startsWith("rvw-ref:")) {
          const reference = references.get(href.slice("rvw-ref:".length));
          if (reference) onOpenReference(reference, openInRightPane);
          return;
        }
        if (href.startsWith("#")) {
          document.getElementById(href.slice(1))?.scrollIntoView({ block: "center" });
          return;
        }
        if (/^https?:/iu.test(href)) {
          window.open(href, "_blank", "noopener,noreferrer");
          return;
        }
        const repositoryPath = resolveWalkthroughRepositoryPath(href);
        if (repositoryPath) onOpenRepositoryLink(repositoryPath, sourceOid, openInRightPane);
      };

      document.addEventListener("selectionchange", setSelectionAction);
      document.addEventListener("pointerup", setSelectionAction);
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("keydown", onKeyDown);
      document.addEventListener("click", onClick, true);
      document.addEventListener("toggle", updateLayout, true);
      let layoutFrame: number | null = null;
      const scheduleLayout = (): void => {
        if (layoutFrame !== null) return;
        layoutFrame = window.requestAnimationFrame(() => {
          layoutFrame = null;
          updateLayout();
        });
      };
      document.addEventListener("scroll", scheduleLayout, true);
      const images = [...document.images];
      for (const image of images) {
        image.addEventListener("load", updateLayout);
        image.addEventListener("error", updateLayout);
      }
      const documentResizeObserver = new ResizeObserver(updateLayout);
      documentResizeObserver.observe(document.documentElement);
      if (document.body) documentResizeObserver.observe(document.body);
      const hostResizeObserver = new ResizeObserver(updateLayout);
      hostResizeObserver.observe(host);
      updateLayout();
      detachDocument = () => {
        document.removeEventListener("selectionchange", setSelectionAction);
        document.removeEventListener("pointerup", setSelectionAction);
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("toggle", updateLayout, true);
        document.removeEventListener("scroll", scheduleLayout, true);
        if (layoutFrame !== null) window.cancelAnimationFrame(layoutFrame);
        for (const image of images) {
          image.removeEventListener("load", updateLayout);
          image.removeEventListener("error", updateLayout);
        }
        documentResizeObserver.disconnect();
        hostResizeObserver.disconnect();
      };
    };
    iframe.addEventListener("load", onLoad);
    if (iframe.contentDocument?.readyState === "complete") onLoad();
    return () => {
      iframe.removeEventListener("load", onLoad);
      detachDocument();
    };
  }, [onOpenReference, onOpenRepositoryLink, references, rendered.value, sourceOid, updateLayout]);

  useEffect(() => {
    const document = iframeRef.current?.contentDocument;
    if (!document) return;
    for (const element of document.querySelectorAll(".rvw-html-active-comment")) {
      element.classList.remove("rvw-html-active-comment");
    }
    const activePlacement = placedComments.find(
      ({ comment, placement }) =>
        comment.id === activeCommentId && !placement.outdated && placement.range,
    )?.placement;
    if (!activePlacement?.range) return;
    const element = bestElementForRange(document, activePlacement.range);
    if (!element) return;
    element.classList.add("rvw-html-active-comment");
    hostRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    element.scrollIntoView({ block: "center", inline: "nearest" });
    updateLayout();
  }, [activeCommentId, placedComments, updateLayout]);

  useEffect(() => {
    if (navigationLine === null) return;
    const document = iframeRef.current?.contentDocument;
    if (!document) return;
    const element = bestElementForRange(document, {
      startLine: navigationLine,
      endLine: navigationLine,
    });
    if (!element) return;
    hostRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
    element.scrollIntoView({ block: "center", inline: "nearest" });
  }, [navigationLine, rendered.value]);

  if (rendered.error) {
    return (
      <div className="walkthrough-html-preview-error" role="alert">
        {rendered.error}
      </div>
    );
  }

  return (
    <div
      className="walkthrough-html-preview-shell"
      ref={hostRef}
      data-rvw-navigation-start-line={fenceRange.startLine}
      data-rvw-navigation-end-line={fenceRange.endLine}
    >
      <div className="walkthrough-html-preview-toolbar" data-pane-find-ignore>
        <span>HTML preview</span>
        <span>textまたはvisualを選択してコメント</span>
      </div>
      <div
        className="walkthrough-html-preview-frame-shell"
        ref={frameShellRef}
        onPointerLeave={() => setOverlayAction(null)}
      >
        <iframe
          ref={iframeRef}
          title={`Walkthrough HTML preview L${fenceRange.startLine}`}
          data-pane-find-child-document
          sandbox="allow-same-origin"
          srcDoc={srcdoc(rendered.value?.html ?? "", themePreference)}
          style={{ height: frameHeight }}
        />
        <HtmlPreviewOverlay
          action={overlayAction}
          markers={markers}
          composer={composerAnchor ? commentComposer(composerAnchor.label) : null}
          composerAnchor={composerAnchor}
          onComment={(action) => {
            iframeRef.current?.contentDocument?.getSelection()?.removeAllRanges();
            setOverlayAction(null);
            const hostWidth = hostRef.current?.clientWidth ?? 0;
            const composerWidth = Math.min(420, Math.max(0, hostWidth - 24));
            const halfWidth = composerWidth / 2;
            const left =
              hostWidth > 0
                ? Math.max(12 + halfWidth, Math.min(hostWidth - 12 - halfWidth, action.left))
                : action.left;
            setComposerAnchor({ ...action, left });
            onCommentRange(action.range);
          }}
          onActivateComment={onActivateComment}
        />
      </div>
    </div>
  );
}
