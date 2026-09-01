import { useRef } from "react";
import type { StructureExportFormat } from "../structure-export.js";

export function StructureExportMenu({
  disabled,
  exporting,
  onExport,
}: {
  disabled: boolean;
  exporting: StructureExportFormat | null;
  onExport: (format: StructureExportFormat) => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const choose = (format: StructureExportFormat): void => {
    detailsRef.current?.removeAttribute("open");
    onExport(format);
  };
  return (
    <details className="structure-export-menu" ref={detailsRef}>
      <summary
        className="structure-header-action"
        aria-label="Structureをエクスポート"
        aria-disabled={disabled}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        {exporting ? `${exporting.toUpperCase()}…` : "Export"}
        <span aria-hidden="true">▾</span>
      </summary>
      <div className="structure-export-popover">
        <button type="button" disabled={disabled} onClick={() => choose("svg")}>
          <strong>SVG</strong>
          <span>全体・ベクター</span>
        </button>
        <button type="button" disabled={disabled} onClick={() => choose("png")}>
          <strong>PNG</strong>
          <span>全体・2×</span>
        </button>
        <p>現在の配置で、全Node・全Relation・全Edge labelを書き出します。</p>
      </div>
    </details>
  );
}
