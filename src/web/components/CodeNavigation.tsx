import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { TokenEventBase } from "@pierre/diffs";
import type { DocumentRef } from "../../domain/models.js";
import {
  supportsCodeNavigation,
  type DefinitionResult,
  type NavigationDocument,
  type NavigationIssue,
  type NavigationTarget,
} from "../../domain/code-navigation.js";
import { api } from "../api.js";
import { ErrorNotice } from "./ErrorNotice.js";

interface Lookup {
  document: NavigationDocument;
  line: number;
  column: number;
}

function isIdentifier(token: TokenEventBase): boolean {
  return /^[\p{L}_$][\p{L}\p{N}\p{M}_$]*[!?=]?$/u.test(token.tokenText.trim());
}

const issueLabels: Record<NavigationIssue, string> = {
  "syntax-error": "構文エラーを含むfileがあります。",
  "parse-limit": "解析の時間・件数上限に達した箇所があります。",
  "file-limit": "索引の対象file数の上限に達しました。",
  "byte-limit": "索引の対象サイズの上限に達しました。",
  "definition-limit": "索引の定義数の上限に達しました。",
  "unavailable-file": "binary・大きいfile等、解析できないfileがあります。",
  "index-timeout": "索引の作成時間の上限に達しました。再試行すると解析済みの結果を再利用します。",
};

export function useCodeNavigation(onOpen: (target: NavigationTarget, right: boolean) => void) {
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 480, maxHeight: 360 });
  const [sideLabel, setSideLabel] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const hovered = useRef<{ element: HTMLElement; cursor: string } | null>(null);
  const onTokenLeave = useCallback(() => {
    if (hovered.current) hovered.current.element.style.cursor = hovered.current.cursor;
    hovered.current = null;
  }, []);
  const onTokenEnter = useCallback(
    (token: TokenEventBase, event: PointerEvent) => {
      onTokenLeave();
      if (!isIdentifier(token)) return;
      hovered.current = { element: token.tokenElement, cursor: token.tokenElement.style.cursor };
      if (event.metaKey || event.ctrlKey) token.tokenElement.style.cursor = "pointer";
    },
    [onTokenLeave],
  );
  useEffect(() => {
    const modifier = (event: KeyboardEvent) => {
      if (hovered.current)
        hovered.current.element.style.cursor =
          event.metaKey || event.ctrlKey ? "pointer" : hovered.current.cursor;
    };
    window.addEventListener("keydown", modifier);
    window.addEventListener("keyup", modifier);
    window.addEventListener("blur", onTokenLeave);
    return () => {
      window.removeEventListener("keydown", modifier);
      window.removeEventListener("keyup", modifier);
      window.removeEventListener("blur", onTokenLeave);
      onTokenLeave();
    };
  }, [onTokenLeave]);
  const query = useQuery<DefinitionResult>({
    queryKey: ["definitions", lookup],
    enabled: lookup !== null,
    retry: false,
    staleTime: (query) => (query.state.data?.partial ? 0 : Infinity),
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) => {
      if (!lookup) throw new Error("定義候補の位置がありません。");
      const params = new URLSearchParams({
        sourceOid: lookup.document.sourceOid,
        path: lookup.document.path,
        line: String(lookup.line),
        column: String(lookup.column),
      });
      return api<DefinitionResult>(
        `/api/pull-requests/${lookup.document.pullRequestId}/definitions?${params}`,
        { signal },
      );
    },
  });
  useEffect(() => {
    if (!lookup) return;
    panel.current?.focus({ preventScroll: true });
    const dismiss = () => setLookup(null);
    const outside = (event: Event) => {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      dismiss();
    };
    window.addEventListener("popstate", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("popstate", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("pointerdown", outside, true);
    };
  }, [lookup]);
  const onTokenClick = useCallback(
    (document: DocumentRef | null, token: TokenEventBase, event: MouseEvent): void => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.button !== 0 ||
        document?.kind !== "repository-file" ||
        !supportsCodeNavigation(document.path)
      )
        return;
      if (!isIdentifier(token)) return;
      event.preventDefault();
      const root = token.tokenElement.getRootNode();
      const host = root instanceof ShadowRoot ? root.host : token.tokenElement;
      const pane = host.closest<HTMLElement>("[data-pane]");
      returnFocus.current = pane;
      const bounds = pane?.getBoundingClientRect();
      const width = Math.min(480, (bounds?.width ?? window.innerWidth) - 24);
      const maxHeight = Math.min(360, window.innerHeight - 24);
      setPosition({
        width,
        maxHeight,
        left: Math.max(
          12,
          Math.min(event.clientX, (bounds?.right ?? window.innerWidth) - width - 12),
        ),
        top:
          event.clientY + 12 + maxHeight < window.innerHeight
            ? event.clientY + 12
            : Math.max(12, event.clientY - maxHeight - 12),
      });
      setSideLabel("side" in token ? (token.side === "deletions" ? "変更前" : "変更後") : "全文");
      setLookup({
        document,
        line: token.lineNumber,
        column:
          token.lineCharStart + token.tokenText.length - token.tokenText.trimStart().length + 1,
      });
    },
    [],
  );
  const closePanel = () => {
    returnFocus.current?.focus({ preventScroll: true });
    setLookup(null);
  };
  const data = query.data;
  const retryablePartial = data?.issues.some(
    (issue) => issue === "parse-limit" || issue === "index-timeout",
  );
  return {
    onTokenClick,
    onTokenEnter,
    onTokenLeave,
    panel: lookup
      ? createPortal(
          <div
            className="code-navigation"
            style={position}
            role="dialog"
            aria-label="定義候補"
            aria-busy={query.isFetching}
            tabIndex={-1}
            ref={panel}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closePanel();
              }
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                const candidates = [
                  ...(panel.current?.querySelectorAll<HTMLButtonElement>(
                    "[data-navigation-candidate]",
                  ) ?? []),
                ];
                if (!candidates.length) return;
                event.preventDefault();
                event.stopPropagation();
                const current = candidates.indexOf(
                  window.document.activeElement as HTMLButtonElement,
                );
                const index =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? candidates.length - 1
                      : event.key === "ArrowDown"
                        ? (current + 1) % candidates.length
                        : (current - 1 + candidates.length) % candidates.length;
                candidates[index]?.focus();
              }
            }}
          >
            <div className="code-navigation-heading">
              <strong>定義候補{data?.symbol ? `: ${data.symbol}` : ""}</strong>
              <button type="button" aria-label="定義候補を閉じる" onClick={closePanel}>
                ×
              </button>
            </div>
            <p className="code-navigation-origin">
              {lookup.document.path}:{lookup.line} · {sideLabel}
            </p>
            {query.isFetching && <p role="status">定義を調べています…</p>}
            <ErrorNotice error={query.error} />
            {(query.isError || retryablePartial) && (
              <button
                type="button"
                disabled={query.isFetching}
                onClick={() => {
                  panel.current?.focus({ preventScroll: true });
                  void query.refetch();
                }}
              >
                再試行
              </button>
            )}
            {data?.partial && (
              <div className="code-navigation-warning" role="status">
                <strong>一部の候補が含まれていません</strong>
                {data.issues.map((issue) => (
                  <p key={issue}>{issueLabels[issue]}</p>
                ))}
                {data.skippedFiles > 0 && <p>対象外: {data.skippedFiles} files</p>}
              </div>
            )}
            {data?.status === "unsupported" && <p>この言語の定義探索は未対応です。</p>}
            {data?.status === "unavailable" && <p>このfileを解析できません。</p>}
            {data?.status === "none" && <p>定義候補が見つかりませんでした。</p>}
            {data?.truncated && <p>候補の先頭100件を表示しています。</p>}
            <ul aria-label="定義の候補一覧">
              {data?.targets.map((target) => (
                <li key={`${target.document.path}:${target.line}:${target.column}`}>
                  <button
                    type="button"
                    data-navigation-candidate
                    onClick={(event) => {
                      setLookup(null);
                      onOpen(target, event.metaKey || event.ctrlKey);
                    }}
                  >
                    <span>
                      <strong>{target.name}</strong> <small>{target.kind}</small>
                    </span>
                    <span>
                      {target.document.path}:{target.line}
                    </span>
                    <code>{target.preview}</code>
                  </button>
                </li>
              ))}
            </ul>
            <p className="code-navigation-help">
              ↑↓ で選択 · Enter で開く · ⌘ / Ctrl + clickで右へ · Esc で閉じる
            </p>
          </div>,
          window.document.body,
        )
      : null,
  };
}
