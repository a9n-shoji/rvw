export function MarkdownImagePlaceholder({
  alt,
  title,
  sourceAttributes,
  reason = "blocked",
}: {
  alt: string | undefined;
  title: string | undefined;
  sourceAttributes: Record<string, number>;
  reason?: "blocked" | "load-error";
}) {
  const label = alt?.trim() || title?.trim() || "説明なし";
  const description =
    reason === "load-error" ? "画像を読み込めません" : "画像を自動読み込みしません";
  return (
    <span
      {...sourceAttributes}
      className="markdown-image-placeholder"
      role="img"
      aria-label={`画像: ${label}（${reason === "load-error" ? "読み込み失敗" : "自動読み込み停止"}）`}
    >
      {description}: {label}
    </span>
  );
}
