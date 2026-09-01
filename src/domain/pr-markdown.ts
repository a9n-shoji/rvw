import { createHash } from "node:crypto";

export function normalizeLf(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function buildPullRequestMarkdown(title: string, body: string): string {
  return `# ${normalizeLf(title)}\n\n${normalizeLf(body)}`;
}

export function hashDocument(value: string): string {
  return createHash("sha256").update(normalizeLf(value), "utf8").digest("hex");
}

export function pullRequestContentFingerprint(title: string, body: string): string {
  return hashDocument(buildPullRequestMarkdown(title, body));
}

export function selectedLineText(value: string, startLine: number, endLine: number): string | null {
  const lines = normalizeLf(value).split("\n");
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return null;
  return lines.slice(startLine - 1, endLine).join("\n");
}
