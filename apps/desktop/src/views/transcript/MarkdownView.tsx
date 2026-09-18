import { memo, useMemo } from "react";
import { parseMarkdown, type Block, type Inline } from "./markdown";

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
      return (
        <pre className="md-pre" data-lang={b.lang || undefined}>
          {b.lang && <span className="md-lang">{b.lang}</span>}
          {b.v}
        </pre>
      );
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
