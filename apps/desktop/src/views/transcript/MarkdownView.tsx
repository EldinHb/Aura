import { memo, useMemo } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { isTauri } from "../../lib/connection";
import { useStore } from "../../state/store";
import { parseMarkdown, type Block, type Inline } from "./markdown";

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
                <a key={i} className="md-link" href={n.url} title={n.url} data-hint
                  target="_blank" rel="noopener noreferrer"
                  onClick={(event) => {
                    if (!isTauri()) return;
                    event.preventDefault();
                    void open(n.url).catch((error: unknown) => {
                      useStore.getState().toast(`Could not open link: ${String(error)}`, "error");
                    });
                  }}>
                  {n.text}
                </a>
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
