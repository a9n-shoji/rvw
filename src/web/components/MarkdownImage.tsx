import { useEffect, useState, type ComponentPropsWithoutRef } from "react";
import { MarkdownImagePlaceholder } from "./MarkdownImagePlaceholder.js";

export function MarkdownImage({
  src,
  alt,
  title,
  sourceAttributes,
  ...props
}: Omit<ComponentPropsWithoutRef<"img">, "src" | "alt" | "title" | "onError"> & {
  src: string;
  alt: string | undefined;
  title: string | undefined;
  sourceAttributes: Record<string, number>;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const failed = failedSource === src;
  useEffect(() => {
    if (failedSource !== null && failedSource !== src) setFailedSource(null);
  }, [failedSource, src]);
  return failed ? (
    <MarkdownImagePlaceholder
      alt={alt}
      title={title}
      sourceAttributes={sourceAttributes}
      reason="load-error"
    />
  ) : (
    <img
      {...sourceAttributes}
      {...props}
      src={src}
      alt={alt ?? ""}
      title={title}
      onError={() => setFailedSource(src)}
    />
  );
}
