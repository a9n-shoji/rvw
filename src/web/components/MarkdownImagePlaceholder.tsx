export function MarkdownImagePlaceholder({
  alt,
  title,
  sourceAttributes,
}: {
  alt: string | undefined;
  title: string | undefined;
  sourceAttributes: Record<string, number>;
}) {
  const label = alt?.trim() || title?.trim() || "説明なし";
  return (
    <span
      {...sourceAttributes}
      className="markdown-image-placeholder"
      role="img"
      aria-label={`画像: ${label}（自動読み込み停止）`}
    >
      画像を自動読み込みしません: {label}
    </span>
  );
}
