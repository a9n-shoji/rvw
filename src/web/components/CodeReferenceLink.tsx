import type { ReactNode } from "react";
import { defaultSchema } from "rehype-sanitize";
import type { CodeReference } from "../../domain/models.js";
import { FileEntryIcon } from "./FileIcon.js";

const pointerStarts = new Map<number, { x: number; y: number }>();

export const codeReferenceMarkdownSanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "rvw-ref"],
  },
};

export function codeReferenceIdFromHref(href: string | undefined): string | null {
  if (!href?.startsWith("rvw-ref:")) return null;
  return href.slice("rvw-ref:".length);
}

export function codeReferenceLineLabel(reference: CodeReference): string | null {
  if (reference.startLine === null || reference.endLine === null) return null;
  return reference.startLine === reference.endLine
    ? `L${reference.startLine}`
    : `L${reference.startLine}–${reference.endLine}`;
}

export function codeReferenceLocation(reference: CodeReference): string {
  const lineLabel = codeReferenceLineLabel(reference);
  return lineLabel ? `${reference.path}:${lineLabel}` : reference.path;
}

export function CodeReferenceLink({
  reference,
  children,
  className,
  onOpen,
}: {
  reference: CodeReference;
  children: ReactNode;
  className?: string;
  onOpen: (reference: CodeReference, openInOtherPane: boolean) => void;
}) {
  return (
    <button
      className={["code-inline-reference", className].filter(Boolean).join(" ")}
      title={codeReferenceLocation(reference)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        pointerStarts.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }}
      onPointerUp={(event) => {
        const start = pointerStarts.get(event.pointerId);
        pointerStarts.delete(event.pointerId);
        if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
        event.preventDefault();
        event.stopPropagation();
        onOpen(reference, event.metaKey || event.ctrlKey);
      }}
      onPointerCancel={(event) => {
        pointerStarts.delete(event.pointerId);
      }}
      onClick={(event) => {
        event.preventDefault();
        if (event.detail === 0) onOpen(reference, false);
      }}
      onContextMenu={(event) => {
        if (event.ctrlKey || event.metaKey) event.preventDefault();
      }}
    >
      <FileEntryIcon path={reference.path} kind="file" />
      <span>{children}</span>
      <small>{codeReferenceLineLabel(reference) ?? "File"}</small>
    </button>
  );
}
