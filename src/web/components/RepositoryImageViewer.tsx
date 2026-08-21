import { useEffect, useState, type ReactNode } from "react";

export interface RepositoryImageSide {
  label: "変更前" | "変更後" | "全文";
  path: string | null;
  sourceUrl: string | null;
  emptyMessage: string | null;
  action?: ReactNode;
  comments?: ReactNode;
}

type ImageLoadState = "checking" | "loading" | "loaded" | "error" | "too-large" | "unsupported";

function RepositoryImageAsset({ side }: { side: RepositoryImageSide }) {
  const [state, setState] = useState<ImageLoadState>(side.sourceUrl ? "checking" : "error");

  useEffect(() => {
    if (!side.sourceUrl) return;
    const controller = new AbortController();
    let current = true;
    setState("checking");
    void fetch(side.sourceUrl, { method: "HEAD", signal: controller.signal })
      .then((response) => {
        if (!current) return;
        if (response.status === 413) setState("too-large");
        else if (response.status === 415) setState("unsupported");
        else if (!response.ok) setState("error");
        else setState("loading");
      })
      .catch(() => {
        if (current && !controller.signal.aborted) setState("error");
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [side.sourceUrl]);

  if (!side.sourceUrl) {
    return (
      <div className="repository-image-empty">{side.emptyMessage ?? "画像がありません。"}</div>
    );
  }

  const errorMessage =
    state === "too-large"
      ? "5 MiBを超えるため画像を表示できません。"
      : state === "unsupported"
        ? "画像形式が未対応か、内容が破損しています。"
        : state === "error"
          ? "画像を読み込めませんでした。"
          : null;

  return (
    <div className="repository-image-asset">
      {state === "checking" && <div className="repository-image-status">画像を確認しています…</div>}
      {state === "loading" && (
        <div className="repository-image-status">画像を読み込んでいます…</div>
      )}
      {errorMessage && (
        <div className="repository-image-status repository-image-status--error" role="alert">
          {errorMessage}
        </div>
      )}
      {(state === "loading" || state === "loaded") && (
        <img
          src={side.sourceUrl}
          alt={`${side.label}: ${side.path ?? "画像"}`}
          onLoad={() => setState("loaded")}
          onError={() => setState("error")}
        />
      )}
    </div>
  );
}

function RepositoryImagePane({ side }: { side: RepositoryImageSide }) {
  return (
    <section className="repository-image-pane" aria-label={side.label}>
      <header>
        <strong>{side.label}</strong>
        <code>{side.path ?? "—"}</code>
        {side.action}
      </header>
      <RepositoryImageAsset side={side} />
      {side.comments}
    </section>
  );
}

export function RepositoryImageViewer({
  mode,
  oldSide,
  newSide,
}: {
  mode: "full" | "split";
  oldSide: RepositoryImageSide | null;
  newSide: RepositoryImageSide;
}) {
  return (
    <div className={`repository-image-viewer repository-image-viewer--${mode}`}>
      <div className="repository-image-grid">
        {oldSide && <RepositoryImagePane side={oldSide} />}
        <RepositoryImagePane side={newSide} />
      </div>
    </div>
  );
}
