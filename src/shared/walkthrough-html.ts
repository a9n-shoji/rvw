import { fromHtml } from "hast-util-from-html";
import { sanitize, type Schema } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import { fromMarkdown } from "mdast-util-from-markdown";
import { RvwError } from "./errors.js";

export const MAX_WALKTHROUGH_HTML_IMAGES = 32;
export const MAX_WALKTHROUGH_HTML_REPOSITORY_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_WALKTHROUGH_HTML_REPOSITORY_IMAGES_BYTES = 20 * 1024 * 1024;

const codeReferencePrefix = "rvw-ref:";
const sourceCommentPrefix = "rvw-source:";
const urlScheme = /^[A-Za-z][A-Za-z\d+.-]*:/u;
const dataImagePattern = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z\d+/=\s]+$/u;
const documentElementPattern = /<\s*\/?\s*(?:html|head|body)(?:\s|>)/iu;

const allowedHtmlTags = new Set([
  "a",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "button",
  "caption",
  "code",
  "col",
  "colgroup",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "input",
  "kbd",
  "label",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "option",
  "p",
  "pre",
  "section",
  "select",
  "small",
  "span",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const allowedSvgTags = new Set([
  "circle",
  "clipPath",
  "defs",
  "ellipse",
  "g",
  "line",
  "linearGradient",
  "mask",
  "path",
  "polygon",
  "polyline",
  "radialGradient",
  "rect",
  "stop",
  "svg",
  "text",
  "tspan",
]);

const forbiddenTags = new Set([
  "audio",
  "base",
  "canvas",
  "embed",
  "frame",
  "iframe",
  "link",
  "meta",
  "object",
  "script",
  "video",
  "foreignobject",
]);

const automaticCommentSurfaceTags = new Set([
  "article",
  "aside",
  "details",
  "figure",
  "img",
  "section",
  "svg",
  "table",
]);

const globalProperties = new Set([
  "ariaDescribedBy",
  "ariaLabel",
  "ariaLabelledBy",
  "className",
  "dir",
  "hidden",
  "id",
  "lang",
  "role",
  "style",
  "tabIndex",
  "title",
]);

const htmlProperties = new Map<string, Set<string>>([
  ["a", new Set(["href", "hrefLang"])],
  ["blockquote", new Set(["cite"])],
  ["button", new Set(["disabled", "name", "type", "value"])],
  ["col", new Set(["span", "width"])],
  ["details", new Set(["open"])],
  ["img", new Set(["alt", "decoding", "height", "loading", "src", "width"])],
  [
    "input",
    new Set([
      "accept",
      "autoComplete",
      "checked",
      "disabled",
      "max",
      "maxLength",
      "min",
      "minLength",
      "multiple",
      "name",
      "placeholder",
      "readOnly",
      "required",
      "size",
      "step",
      "type",
      "value",
    ]),
  ],
  ["label", new Set(["htmlFor"])],
  ["li", new Set(["value"])],
  ["ol", new Set(["reversed", "start", "type"])],
  ["option", new Set(["disabled", "label", "selected", "value"])],
  ["select", new Set(["disabled", "multiple", "name", "required", "size"])],
  ["td", new Set(["colSpan", "headers", "rowSpan"])],
  [
    "textarea",
    new Set([
      "cols",
      "disabled",
      "maxLength",
      "minLength",
      "name",
      "placeholder",
      "readOnly",
      "required",
      "rows",
      "wrap",
    ]),
  ],
  ["th", new Set(["abbr", "colSpan", "headers", "rowSpan", "scope"])],
]);

const svgProperties = new Set([
  "alignmentBaseline",
  "clipPath",
  "clipPathUnits",
  "cx",
  "cy",
  "d",
  "dominantBaseline",
  "dx",
  "dy",
  "fill",
  "fillOpacity",
  "fillRule",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "gradientTransform",
  "gradientUnits",
  "height",
  "href",
  "lengthAdjust",
  "markerEnd",
  "markerMid",
  "markerStart",
  "mask",
  "maskContentUnits",
  "maskUnits",
  "offset",
  "opacity",
  "pathLength",
  "points",
  "preserveAspectRatio",
  "r",
  "rx",
  "ry",
  "spreadMethod",
  "stopColor",
  "stopOpacity",
  "stroke",
  "strokeDasharray",
  "strokeDashoffset",
  "strokeLinecap",
  "strokeLinejoin",
  "strokeMiterlimit",
  "strokeOpacity",
  "strokeWidth",
  "textAnchor",
  "textLength",
  "transform",
  "vectorEffect",
  "viewBox",
  "width",
  "x",
  "x1",
  "x2",
  "xmlns",
  "y",
  "y1",
  "y2",
]);

const svgResourceProperties = new Set([
  "clipPath",
  "fill",
  "markerEnd",
  "markerMid",
  "markerStart",
  "mask",
  "stroke",
]);

interface SourcePoint {
  line: number;
  column?: number;
  offset?: number;
}

interface SourcePosition {
  start: SourcePoint;
  end: SourcePoint;
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: SourcePosition;
}

export interface HtmlPreviewAnalysis {
  startLine: number;
  endLine: number;
  imageCount: number;
  referenceIds: string[];
  repositoryImages: string[];
}

export interface RenderedHtmlPreview extends HtmlPreviewAnalysis {
  html: string;
}

export type HtmlPreviewResolvedImages = ReadonlyMap<string, string | null>;

export interface WalkthroughHtmlPreviewSourceRange {
  startLine: number;
  endLine: number;
}

interface MarkdownNode {
  type: string;
  lang?: string | null;
  value?: string;
  children?: MarkdownNode[];
  position?: SourcePosition;
}

export function walkthroughHtmlPreviewSourceRanges(
  markdown: string,
): WalkthroughHtmlPreviewSourceRange[] {
  const root = fromMarkdown(markdown) as MarkdownNode;
  const ranges: WalkthroughHtmlPreviewSourceRange[] = [];
  const visit = (node: MarkdownNode): void => {
    if (
      node.type === "code" &&
      node.lang === "html-preview" &&
      typeof node.value === "string" &&
      node.position
    ) {
      const startLine = node.position.start.line + 1;
      ranges.push({
        startLine,
        endLine: startLine + Math.max(1, node.value.split("\n").length) - 1,
      });
    }
    node.children?.forEach(visit);
  };
  visit(root);
  return ranges;
}

function absoluteLine(position: SourcePosition | undefined, fenceStartLine: number): number {
  return fenceStartLine + (position?.start.line ?? 1);
}

function lineError(line: number, message: string): never {
  throw new RvwError("INVALID_INPUT", `html-preview L${line}: ${message}`);
}

function decodeCssEscapes(value: string): string {
  return value.replace(/\\([\da-f]{1,6}\s?|.)/giu, (_match, escaped: string) => {
    const hexadecimal = escaped.trim();
    if (/^[\da-f]{1,6}$/iu.test(hexadecimal)) {
      const codePoint = Number.parseInt(hexadecimal, 16);
      return codePoint === 0 || codePoint > 0x10ffff ? "�" : String.fromCodePoint(codePoint);
    }
    return escaped;
  });
}

function validateCss(value: string, line: number): void {
  const normalized = decodeCssEscapes(value.replace(/\/\*[\s\S]*?\*\//gu, " ")).toLowerCase();
  const withoutInternalFragments = normalized.replace(
    /url\s*\(\s*(["']?)#[a-z_][\w:.-]*\1\s*\)/giu,
    "internal-fragment",
  );
  if (
    /@import\b|@font-face\b|(?:^|[^-])url\s*\(|image-set\s*\(|(?:^|[^-])image\s*\(|expression\s*\(|-moz-binding\s*:|behavior\s*:/u.test(
      withoutInternalFragments,
    ) ||
    /(?:https?|file|blob|data):|\/\//u.test(withoutInternalFragments)
  ) {
    lineError(line, "network resourceを参照するCSSは使用できません。");
  }
}

export function resolveWalkthroughRepositoryPath(value: string): string | null {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("?") ||
    trimmed.startsWith("//") ||
    urlScheme.test(trimmed)
  ) {
    return null;
  }
  const encodedPath = trimmed.split(/[?#]/u, 1)[0];
  if (!encodedPath) return null;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (decodedPath.includes("\\") || decodedPath.includes("\0")) return null;
  const segments: string[] = [];
  for (const segment of decodedPath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

function propertyAllowed(tagName: string, propertyName: string, inSvg: boolean): boolean {
  if (globalProperties.has(propertyName) || /^aria[A-Z]/u.test(propertyName)) return true;
  if (propertyName === "dataRvwCommentable") return true;
  if (inSvg && svgProperties.has(propertyName)) return true;
  return htmlProperties.get(tagName)?.has(propertyName) ?? false;
}

function stringProperty(node: HastNode, name: string): string | null {
  const value = node.properties?.[name];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .filter(
        (item): item is string | number | boolean | bigint =>
          typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean" ||
          typeof item === "bigint",
      )
      .map(String)
      .join(" ");
  }
  return null;
}

function validateHref(value: string, line: number, inSvg: boolean, referenceIds: string[]): void {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith(codeReferencePrefix)) {
    if (inSvg) lineError(line, "inline SVGのhrefはfragmentだけを使用できます。");
    referenceIds.push(trimmed.slice(codeReferencePrefix.length));
    return;
  }
  if (trimmed.startsWith("#")) return;
  if (!inSvg && (/^https?:/iu.test(trimmed) || resolveWalkthroughRepositoryPath(trimmed))) return;
  if (/^javascript:/iu.test(trimmed)) lineError(line, "javascript: URLは使用できません。");
  lineError(
    line,
    inSvg ? "inline SVGのexternal hrefは使用できません。" : `link ${trimmed} は使用できません。`,
  );
}

function validateAndCollect(
  root: HastNode,
  fenceStartLine: number,
): {
  referenceIds: string[];
  repositoryImages: string[];
  propertyNames: Set<string>;
  imageCount: number;
} {
  const referenceIds: string[] = [];
  const repositoryImages: string[] = [];
  const propertyNames = new Set<string>();
  let imageCount = 0;

  const visit = (node: HastNode, inSvg: boolean): void => {
    if (node.type === "comment") {
      if (node.value?.startsWith(sourceCommentPrefix)) {
        lineError(
          absoluteLine(node.position, fenceStartLine),
          "内部source markerは指定できません。",
        );
      }
      return;
    }
    if (node.type === "doctype") {
      lineError(
        absoluteLine(node.position, fenceStartLine),
        "doctypeはfragment内で使用できません。",
      );
    }
    if (node.type !== "element" || !node.tagName) {
      node.children?.forEach((child) => visit(child, inSvg));
      return;
    }
    const tagName = node.tagName;
    const lowerTagName = tagName.toLowerCase();
    const line = absoluteLine(node.position, fenceStartLine);
    const nextInSvg = inSvg || lowerTagName === "svg";
    if (forbiddenTags.has(lowerTagName)) lineError(line, `<${tagName}> は使用できません。`);
    if (!allowedHtmlTags.has(tagName) && !allowedSvgTags.has(tagName)) {
      lineError(line, `<${tagName}> は使用できません。`);
    }
    for (const propertyName of Object.keys(node.properties ?? {})) {
      if (/^on/iu.test(propertyName)) {
        lineError(line, `${propertyName.toLowerCase()} attribute は使用できません。`);
      }
      if (propertyName === "srcDoc") lineError(line, "srcdoc attribute は使用できません。");
      if (
        /^dataRvwSource/iu.test(propertyName) ||
        /^dataRvw(?:Node|Text|CommentSurface)/iu.test(propertyName)
      ) {
        lineError(line, "内部data-rvw-source-* attributeは指定できません。");
      }
      if (!propertyAllowed(tagName, propertyName, nextInSvg)) {
        lineError(line, `<${tagName}>の${propertyName} attribute は使用できません。`);
      }
      propertyNames.add(propertyName);
    }
    const style = stringProperty(node, "style");
    if (style !== null) validateCss(style, line);
    if (tagName === "style") {
      validateCss(node.children?.map((child) => child.value ?? "").join("") ?? "", line);
    }
    const href = stringProperty(node, "href");
    if (href !== null) validateHref(href, line, nextInSvg, referenceIds);
    if (nextInSvg) {
      for (const propertyName of svgResourceProperties) {
        const value = stringProperty(node, propertyName);
        if (value !== null) validateCss(value, line);
      }
    }
    if (tagName === "img") {
      imageCount += 1;
      const src = stringProperty(node, "src");
      if (!src) lineError(line, "<img>にはsrcが必要です。");
      if (src.startsWith("data:")) {
        if (!dataImagePattern.test(src)) {
          lineError(line, "inline imageは対応するbase64 data:imageだけを使用できます。");
        }
      } else {
        const repositoryPath = resolveWalkthroughRepositoryPath(src);
        if (!repositoryPath) {
          lineError(line, `外部画像 ${src} は使用できません。`);
        }
        repositoryImages.push(repositoryPath);
      }
    }
    node.children?.forEach((child) => visit(child, nextInSvg));
  };
  visit(root, false);
  if (imageCount > MAX_WALKTHROUGH_HTML_IMAGES) {
    lineError(
      fenceStartLine,
      `画像はWalkthrough全体で${MAX_WALKTHROUGH_HTML_IMAGES}件以下にしてください。`,
    );
  }
  return { referenceIds, repositoryImages, propertyNames, imageCount };
}

function sanitizeSchema(propertyNames: ReadonlySet<string>): Schema {
  return {
    allowComments: true,
    allowDoctypes: false,
    ancestors: {},
    attributes: { "*": [...propertyNames] },
    clobber: [],
    protocols: { href: ["http", "https", "rvw-ref"], src: ["data"] },
    required: {},
    strip: [...forbiddenTags],
    tagNames: [...allowedHtmlTags, ...allowedSvgTags],
  };
}

function sourceRange(
  node: HastNode,
  fenceStartLine: number,
): { startLine: number; endLine: number } | null {
  if (!node.position) return null;
  return {
    startLine: fenceStartLine + node.position.start.line,
    endLine: fenceStartLine + node.position.end.line,
  };
}

function missingImage(node: HastNode, repositoryPath: string): void {
  const alt = stringProperty(node, "alt")?.trim();
  const title = stringProperty(node, "title")?.trim();
  node.tagName = "span";
  node.properties = {
    className: ["rvw-html-image-placeholder"],
    dataRvwImagePath: repositoryPath,
    role: "img",
    ariaLabel: alt || title || `Missing image: ${repositoryPath}`,
    ...(title ? { title } : {}),
  };
  node.children = [{ type: "text", value: alt || title || `Image unavailable: ${repositoryPath}` }];
}

function instrumentAndResolve(
  root: HastNode,
  fenceStartLine: number,
  resolvedImages: HtmlPreviewResolvedImages,
): void {
  const visit = (node: HastNode, suppressTextMarkers = false): void => {
    if (node.type !== "element" || !node.tagName) {
      if (node.children) {
        const children: HastNode[] = [];
        for (const child of node.children) {
          const range =
            !suppressTextMarkers && child.type === "text"
              ? sourceRange(child, fenceStartLine)
              : null;
          if (range && child.value?.trim()) {
            children.push({
              type: "comment",
              value: `${sourceCommentPrefix}${range.startLine}:${range.endLine}`,
            });
          }
          visit(child, suppressTextMarkers);
          children.push(child);
        }
        node.children = children;
      }
      return;
    }
    const range = sourceRange(node, fenceStartLine);
    node.properties ??= {};
    if (range) {
      node.properties.dataRvwSourceStartLine = range.startLine;
      node.properties.dataRvwSourceEndLine = range.endLine;
    }
    if (
      automaticCommentSurfaceTags.has(node.tagName) ||
      Object.hasOwn(node.properties, "dataRvwCommentable")
    ) {
      node.properties.dataRvwCommentSurface = "true";
    }
    if (node.tagName === "img") {
      const src = stringProperty(node, "src");
      if (src && !src.startsWith("data:")) {
        const repositoryPath = resolveWalkthroughRepositoryPath(src);
        const resolved = repositoryPath ? resolvedImages.get(repositoryPath) : null;
        if (repositoryPath && resolved) {
          node.properties.src = resolved;
          node.properties.dataRvwImagePath = repositoryPath;
        } else if (repositoryPath) {
          missingImage(node, repositoryPath);
        }
      }
    }
    if (node.children) {
      const children: HastNode[] = [];
      for (const child of node.children) {
        const range =
          node.tagName !== "style" && child.type === "text"
            ? sourceRange(child, fenceStartLine)
            : null;
        if (range && child.value?.trim()) {
          children.push({
            type: "comment",
            value: `${sourceCommentPrefix}${range.startLine}:${range.endLine}`,
          });
        }
        visit(child, node.tagName === "style");
        children.push(child);
      }
      node.children = children;
    }
  };
  visit(root);
}

export function renderWalkthroughHtmlPreview(
  source: string,
  fenceStartLine: number,
  resolvedImages: HtmlPreviewResolvedImages = new Map(),
): RenderedHtmlPreview {
  if (documentElementPattern.test(source)) {
    lineError(fenceStartLine + 1, "<html>、<head>、<body>はfragment内で使用できません。");
  }
  const parsed = fromHtml(source, { fragment: true }) as unknown as HastNode;
  const collected = validateAndCollect(parsed, fenceStartLine);
  const safe = sanitize(
    parsed as Parameters<typeof sanitize>[0],
    sanitizeSchema(collected.propertyNames),
  ) as unknown as HastNode;
  instrumentAndResolve(safe, fenceStartLine, resolvedImages);
  const lineCount = Math.max(1, source.split("\n").length);
  return {
    startLine: fenceStartLine + 1,
    endLine: fenceStartLine + lineCount,
    imageCount: collected.imageCount,
    referenceIds: collected.referenceIds,
    repositoryImages: collected.repositoryImages,
    html: toHtml(safe as Parameters<typeof toHtml>[0]),
  };
}

export function analyzeWalkthroughHtmlPreview(
  source: string,
  fenceStartLine: number,
): HtmlPreviewAnalysis {
  const rendered = renderWalkthroughHtmlPreview(source, fenceStartLine);
  return {
    startLine: rendered.startLine,
    endLine: rendered.endLine,
    imageCount: rendered.imageCount,
    referenceIds: rendered.referenceIds,
    repositoryImages: rendered.repositoryImages,
  };
}
