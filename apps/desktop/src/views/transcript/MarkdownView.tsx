import { memo, useMemo } from "react";
import { ExternalLink } from "../../components/ExternalLink";
import { parseMarkdown, type Block, type Inline } from "./markdown";
import { CodeBlock } from "./CodeBlock";

function isExternalUrl(url: string): boolean {
  try {
    return ["https:", "http:", "mailto:", "tel:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return <span key={i}>{n.v}</span>;
          case "code":
            return <code key={i} className="md-code">{n.v}</code>;
          case "bold":
            return <strong key={i}><InlineNodes nodes={n.v} /></strong>;
          case "em":
            return <em key={i}><InlineNodes nodes={n.v} /></em>;
          case "link":
            if (isExternalUrl(n.url)) {
              return (
                <ExternalLink key={i} className="md-link" href={n.url} title={n.url}>
                  {n.text}
                </ExternalLink>
              );
            }
            return (
              <span key={i} className="md-link" title={n.url}>
                {n.text} <span className="dim">({n.url})</span>
              </span>
            );
        }
      })}
    </>
  );
}

function BlockNode({ b }: { b: Block }) {
  switch (b.t) {
    case "code":
      return <CodeBlock code={b.v} language={b.lang} />;
    case "heading": {
      const cls = `md-h md-h${Math.min(b.level, 4)}`;
      return <div className={cls}><InlineNodes nodes={b.v} /></div>;
    }
    case "list":
      return b.ordered ? (
        <ol className="md-list">{b.items.map((it, i) => <li key={i}><InlineNodes nodes={it} /></li>)}</ol>
      ) : (
        <ul className="md-list">{b.items.map((it, i) => <li key={i}><InlineNodes nodes={it} /></li>)}</ul>
      );
    case "para":
      return <p className="md-p"><InlineNodes nodes={b.v} /></p>;
    case "hr":
      return <hr className="md-hr" />;
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="md">
      {blocks.map((b, i) => <BlockNode key={i} b={b} />)}
    </div>
  );
});
