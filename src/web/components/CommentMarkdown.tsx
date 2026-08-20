import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { CodeReference } from "../../domain/models.js";
import {
  isExternalMarkdownHref,
  markdownAssetUrl,
  markdownLinkWasDragged,
  resolveRepositoryMarkdownPath,
  type PointerPosition,
} from "../markdown-links.js";
import type { ThemePreference } from "../theme.js";
import {
  CodeReferenceLink,
  codeReferenceIdFromHref,
  codeReferenceMarkdownSanitizeSchema,
} from "./CodeReferenceLink.js";
import { MarkdownImagePlaceholder } from "./MarkdownImagePlaceholder.js";
import { MermaidSurface } from "./MermaidSurface.js";

function codeText(content: ReactNode): string {
  return Children.toArray(content)
    .map((part) => {
      if (typeof part === "string" || typeof part === "number") return String(part);
      return isValidElement<{ children?: ReactNode }>(part) ? codeText(part.props.children) : "";
    })
    .join("");
}

function CommentMermaidDiagram({
  source,
  themePreference,
}: {
  source: string;
  themePreference: ThemePreference;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: "160px" },
    );
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="comment-mermaid-shell" ref={shellRef}>
      <div className="comment-mermaid-toolbar">Mermaid diagram</div>
      {visible ? (
        <MermaidSurface
          className="comment-mermaid"
          role="img"
          aria-label="Mermaid diagram"
          source={source}
          themePreference={themePreference}
          renderIdPrefix="rvwComment"
          errorClassName="comment-mermaid-error"
        />
      ) : (
        <div className="comment-mermaid-placeholder">diagramを準備しています…</div>
      )}
    </div>
  );
}

export function CommentMarkdown({
  body,
  pullRequestId,
  sourceOid,
  sourcePath,
  references,
  themePreference,
  onOpenCodeReference,
  onOpenRepositoryLink,
}: {
  body: string;
  pullRequestId: string;
  sourceOid: string;
  sourcePath: string | null;
  references: CodeReference[];
  themePreference: ThemePreference;
  onOpenCodeReference?: ((reference: CodeReference, openInOtherPane: boolean) => void) | undefined;
  onOpenRepositoryLink?:
    ((path: string, sourceOid: string, openInOtherPane: boolean) => void) | undefined;
}) {
  const linkPointerStart = useRef<PointerPosition | null>(null);
  const referencesById = useMemo(
    () => new Map(references.map((reference) => [reference.id, reference])),
    [references],
  );
  const components = useMemo<Components>(
    () => ({
      table: ({ children, node, ...props }) => {
        void node;
        return (
          <div className="comment-markdown-table-scroll">
            <table {...props}>{children}</table>
          </div>
        );
      },
      a: ({ href, children, node, ...props }) => {
        void node;
        const referenceId = codeReferenceIdFromHref(href);
        if (referenceId !== null) {
          const reference = referencesById.get(referenceId);
          return reference && onOpenCodeReference ? (
            <CodeReferenceLink
              reference={reference}
              className="comment-inline-reference"
              onOpen={onOpenCodeReference}
            >
              {children}
            </CodeReferenceLink>
          ) : (
            <span>{children}</span>
          );
        }
        const repositoryPath = resolveRepositoryMarkdownPath(href, sourcePath);
        if (!repositoryPath) {
          if (!href) return <span>{children}</span>;
          const external = isExternalMarkdownHref(href);
          return (
            <a
              {...props}
              href={href}
              target={external ? "_blank" : undefined}
              rel={external ? "noopener noreferrer" : undefined}
            >
              {children}
            </a>
          );
        }
        if (!onOpenRepositoryLink) {
          return (
            <span className="comment-markdown-unavailable-link" title={repositoryPath}>
              {children}
            </span>
          );
        }
        return (
          <a
            {...props}
            href={href}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              linkPointerStart.current = { x: event.clientX, y: event.clientY };
            }}
            onPointerUp={(event) => {
              if (event.button !== 0 || !linkPointerStart.current) return;
              const dragged = markdownLinkWasDragged(linkPointerStart.current, {
                x: event.clientX,
                y: event.clientY,
              });
              linkPointerStart.current = null;
              if (dragged) {
                event.currentTarget.dataset.rvwLinkDragged = "true";
                return;
              }
              event.preventDefault();
              onOpenRepositoryLink(repositoryPath, sourceOid, event.metaKey || event.ctrlKey);
            }}
            onPointerCancel={() => {
              linkPointerStart.current = null;
            }}
            onClick={(event) => {
              event.preventDefault();
              if (event.currentTarget.dataset.rvwLinkDragged === "true") {
                delete event.currentTarget.dataset.rvwLinkDragged;
                return;
              }
              if (event.detail === 0) onOpenRepositoryLink(repositoryPath, sourceOid, false);
            }}
            onContextMenu={(event) => {
              if (event.ctrlKey || event.metaKey) event.preventDefault();
            }}
          >
            {children}
          </a>
        );
      },
      img: ({ src, alt, title, node, ...props }) => {
        void node;
        const repositoryPath = resolveRepositoryMarkdownPath(src, sourcePath);
        return repositoryPath ? (
          <img
            {...props}
            src={markdownAssetUrl(pullRequestId, sourceOid, repositoryPath)}
            alt={alt ?? ""}
            title={title}
          />
        ) : (
          <MarkdownImagePlaceholder alt={alt} title={title} sourceAttributes={{}} />
        );
      },
      pre: ({ children, node, ...props }) => {
        void node;
        const child =
          Children.count(children) === 1
            ? (Children.only(children) as ReactElement<{
                className?: string;
                children?: ReactNode;
              }>)
            : null;
        if (
          !isValidElement(child) ||
          !child.props.className?.split(/\s+/u).includes("language-mermaid")
        ) {
          return <pre {...props}>{children}</pre>;
        }
        return (
          <CommentMermaidDiagram
            source={codeText(child.props.children).trim()}
            themePreference={themePreference}
          />
        );
      },
    }),
    [
      onOpenCodeReference,
      onOpenRepositoryLink,
      pullRequestId,
      referencesById,
      sourceOid,
      sourcePath,
      themePreference,
    ],
  );

  return (
    <div className="comment-markdown">
      <ReactMarkdown
        rehypePlugins={[rehypeRaw, [rehypeSanitize, codeReferenceMarkdownSanitizeSchema]]}
        remarkPlugins={[remarkGfm, remarkBreaks]}
        urlTransform={(url) => (url.startsWith("rvw-ref:") ? url : defaultUrlTransform(url))}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
