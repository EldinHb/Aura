import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Element, ElementContent } from "hast";
import { ExternalLink } from "../../components/ExternalLink";
import { fileRef } from "../../lib/localPaths";
import { CodeBlock } from "./CodeBlock";
import { FileLink, MarkdownImage } from "./LocalFiles";
import { markdownSegments, PATH_LINK, rehypeBlockWhitespace, remarkFilePaths } from "./markdownPlugins";

/**
 * CommonMark and GitHub-flavoured markdown (tables, task lists, strikethrough,
 * autolinks, footnotes). HTML in the text shows as text, never as markup;
 * links open in the system browser and only for web, mail and phone addresses.
 */

function isExternalUrl(url: string): boolean {
  try {
    return ["https:", "http:", "mailto:", "tel:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** The folder relative paths and images resolve against; unset outside agent messages. */
const Folder = createContext<string | undefined>(undefined);

function text(node: ElementContent | Element): string {
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map(text).join("") : "";
}

/** Headings keep the transcript's sizes rather than the page's. */
function heading(level: number) {
  return function Heading({ children, className, id }: { children?: ReactNode; className?: string; id?: string }) {
    const cls = `md-h md-h${Math.min(level, 4)}${className ? ` ${className}` : ""}`;
    return <div className={cls} id={id} role="heading" aria-level={level}>{children}</div>;
  };
}

const components: Components = {
  p: ({ node: _, ...props }) => <p className="md-p" {...props} />,
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  ul: ({ node: _, className, ...props }) => <ul className={className ? `md-list ${className}` : "md-list"} {...props} />,
  ol: ({ node: _, className, ...props }) => <ol className={className ? `md-list ${className}` : "md-list"} {...props} />,
  blockquote: ({ node: _, ...props }) => <blockquote className="md-quote" {...props} />,
  hr: () => <hr className="md-hr" />,
  table: ({ node: _, ...props }) => <div className="md-table-wrap"><table className="md-table" {...props} /></div>,
  pre: ({ node }) => {
    const code = node?.children.find((c): c is Element => c.type === "element" && c.tagName === "code");
    const cls = (code?.properties.className as string[] | undefined) ?? [];
    const lang = cls.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
    // The converter ends every code block with a line break the source did not show.
    return <CodeBlock code={code ? text(code).replace(/\n$/, "") : ""} language={lang} />;
  },
  code: function InlineCode({ children, node }) {
    const cwd = useContext(Folder);
    const file = cwd === undefined || !node ? null : fileRef(text(node));
    const code = <code className="md-code">{children}</code>;
    return file ? <FileLink file={file} cwd={cwd}>{code}</FileLink> : code;
  },
  a: function Link({ href = "", id, children, node }) {
    const cwd = useContext(Folder);
    if (isExternalUrl(href)) {
      return <ExternalLink className="md-link" href={href} title={href}>{children}</ExternalLink>;
    }
    if (href.startsWith("#")) {
      // Footnotes: scroll within the message instead of changing the app's address.
      return (
        <a className="md-link" href={href} id={id} data-hint onClick={(e) => {
          e.preventDefault();
          e.currentTarget.closest(".md")?.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView({ block: "nearest" });
        }}>{children}</a>
      );
    }
    const file = cwd === undefined ? null : fileRef(href);
    if (file) return <FileLink file={file} cwd={cwd}>{children}</FileLink>;
    if (node?.properties[PATH_LINK] !== undefined) return <>{children}</>;
    return (
      <span className="md-link" title={href}>
        {children} <span className="dim">({href})</span>
      </span>
    );
  },
  img: function Image({ src, alt, title }) {
    const cwd = useContext(Folder);
    return <MarkdownImage src={typeof src === "string" ? src : ""} alt={alt ?? ""} title={title} cwd={cwd} />;
  },
};

const remarkPlugins = [[remarkGfm, { singleTilde: false }], remarkFilePaths] as const;
const rehypePlugins = [rehypeBlockWhitespace];
// Links and images are checked where they render (see `a` and `img`), so keep
// their destinations as written; everything else gets the default filter.
const urlTransform: UrlTransform = (url, key, node) =>
  (key === "href" && node.tagName === "a") || (key === "src" && node.tagName === "img") ? url : defaultUrlTransform(url);

const Segment = memo(function Segment({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins as never} rehypePlugins={rehypePlugins} components={components} urlTransform={urlTransform}>
      {text}
    </ReactMarkdown>
  );
});

/**
 * `cwd`: the folder of the agent whose message this is. With it, relative
 * paths resolve against it, paths become clickable and images on disk show.
 */
export const Markdown = memo(function Markdown({ text, cwd }: { text: string; cwd?: string }) {
  // A long streaming message re-parses only its last segment.
  const segments = useMemo(() => markdownSegments(text), [text]);
  return (
    <div className="md">
      <Folder.Provider value={cwd}>
        {segments.map((segment, i) => <Segment key={i} text={segment} />)}
      </Folder.Provider>
    </div>
  );
});
