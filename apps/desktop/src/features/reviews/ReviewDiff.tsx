import { useEffect, useMemo, useState } from "react";
import type { ReviewComment } from "../../gen";
import { displayPath, parseUnifiedDiff } from "../../components/diff/parse";

export function ReviewDiff({ diff, comments = [], focus, onFocus, onAdd }: { diff: string; comments?: ReviewComment[]; focus?: { id: string; seq: number } | null; onFocus?: (id: string) => void; onAdd?: (path: string, line: number, side: string) => void }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const focusedPath = comments.find((c) => c.id === focus?.id)?.path;
  useEffect(() => {
    if (!focus) return;
    if (focusedPath) setCollapsed((s) => ({ ...s, [focusedPath]: false }));
    const timer = setTimeout(() => document.getElementById(`review-anchor-${focus.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 30);
    return () => clearTimeout(timer);
  }, [focus, focusedPath]);
  return <div className="pr-diff" data-keynav>
    {files.length === 0 && <p className="pr-muted pr-empty">No textual diff available.</p>}
    {files.map((file, index) => {
      const path = displayPath(file);
      return <section key={`${path}-${index}`} className="pr-diff-file">
        <button className="pr-file-heading" data-hint aria-expanded={!collapsed[path]} onClick={() => setCollapsed({ ...collapsed, [path]: !collapsed[path] })}>{collapsed[path] ? "▸" : "▾"} {path} {file.isBinary ? "· binary" : ""}</button>
        {!collapsed[path] && <div className="pr-diff-lines">{file.hunks.flatMap((h, hi) => h.lines.map((line, li) => {
          const side = line.kind === "del" ? "LEFT" : "RIGHT";
          const no = side === "LEFT" ? line.oldNo : line.newNo;
          const anchored = comments.filter((c) => !c.deleted && c.valid && c.path === path && (c.side === "LEFT" ? c.line === line.oldNo : c.line === line.newNo));
          return <div key={`${hi}-${li}`}>
            <div className={`pr-diff-line ${line.kind}`}><span className="pr-line-no">{line.oldNo}</span><span className="pr-line-no">{line.newNo}</span>
              {onAdd && no !== null ? <button className="pr-add-comment" title={`Comment on ${path}:${no}`} data-hint onClick={() => onAdd(path, no, side)}>+</button> : <span className="pr-add-space" />}
              <code>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}{line.text}</code></div>
            {anchored.map((c) => <button key={c.id} id={`review-anchor-${c.id}`} className={`pr-inline-comment ${focus?.id === c.id ? "selected" : ""}`} data-hint onClick={() => onFocus?.(c.id)}><strong>{c.severity}{c.user_authored ? " · yours" : ""}</strong><span>{c.body || "New comment"}</span></button>)}
          </div>;
        }))}</div>}
      </section>;
    })}
  </div>;
}
