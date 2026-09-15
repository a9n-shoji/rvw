import { createContext, useContext, type ComponentPropsWithoutRef, type ReactNode } from "react";

export type RenderMarkdownCommentContainer = (
  props: ComponentPropsWithoutRef<"div"> & { node?: unknown },
) => ReactNode;

export const MarkdownCommentContainerContext = createContext<RenderMarkdownCommentContainer | null>(
  null,
);

// Keep the ReactMarkdown component type stable when comments change. Passing the
// render callback itself as `components.div` remounts threads and loses edit drafts.
export function MarkdownCommentContainer(
  props: ComponentPropsWithoutRef<"div"> & { node?: unknown },
) {
  const render = useContext(MarkdownCommentContainerContext);
  if (!render) throw new Error("Markdown comment container requires a render context");
  return render(props);
}
