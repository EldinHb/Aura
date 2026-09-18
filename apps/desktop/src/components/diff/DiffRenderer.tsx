import { useMemo } from "react";
import { type FileDiff, type Hunk, type DiffLine, pairHunk, filterWhitespace, displayPath, countChanges } from "./parse";
import clsx from "clsx";

function lineClass(k: DiffLine["kind"]): string {
  return k === "add" ? "diff-add" : k === "del" ? "diff-del" : k === "hunk" ? "diff-hunk" : k === "meta" ? "diff-meta" : "";
}

export function DiffRenderer({
  files,
  sideBySide,
  ignoreWs,
  activeHunk,
}: {
  files: FileDiff[];
  sideBySide: boolean;
  ignoreWs: boolean;
  /** index into the flattened hunk list to highlight */
  activeHunk: number;
}) {
  let hunkIdx = 0;
  return (
    <div className="diff-view mono">
      {files.map((f, fi) => {
        const { added, deleted } = countChanges(f);
        return (
          <div key={fi} className="diff-file" data-file-index={fi}>
            <div className="diff-file-head">
              <span className="path">{displayPath(f)}</span>
              {f.isNew && <span className="chip">new</span>}
              {f.isDeleted && <span className="chip">deleted</span>}
              {f.isBinary && <span className="chip">binary</span>}
              <span className="diff-add">+{added}</span>
              <span className="diff-del">−{deleted}</span>
            </div>
            {f.hunks.map((h, hi) => {
              const idx = hunkIdx++;
              return <HunkView key={hi} hunk={h} sideBySide={sideBySide} ignoreWs={ignoreWs} active={idx === activeHunk} index={idx} />;
            })}
            {f.hunks.length === 0 && <div className="diff-meta" style={{ padding: "4px 8px" }}>{f.isBinary ? "Binary file" : "No textual changes"}</div>}
          </div>
        );
      })}
    </div>
  );
}

function HunkView({ hunk, sideBySide, ignoreWs, active, index }: { hunk: Hunk; sideBySide: boolean; ignoreWs: boolean; active: boolean; index: number }) {
  const unified = useMemo(() => (ignoreWs ? filterWhitespace(hunk) : hunk.lines), [hunk, ignoreWs]);
  const rows = useMemo(() => (sideBySide ? pairHunk(hunk, ignoreWs) : []), [hunk, sideBySide, ignoreWs]);
  if (!sideBySide) {
    return (
      <table className={clsx("diff-table", active && "active")} data-hunk-index={index}>
        <tbody>
          {unified.map((l, i) => (
            <tr key={i} className={lineClass(l.kind)}>
              <td className="ln">{l.oldNo ?? ""}</td>
              <td className="ln">{l.newNo ?? ""}</td>
              <td className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</td>
              <td className="code">{l.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className={clsx("diff-table side", active && "active")} data-hunk-index={index}>
      <tbody>
        <tr className="diff-hunk">
          <td colSpan={4} className="code">{hunk.header}</td>
        </tr>
        {rows.map((r, i) => (
          <tr key={i} className={clsx(r.wsOnly && "ws-only")}>
            <td className="ln">{r.left?.oldNo ?? ""}</td>
            <td className={clsx("code", r.left && r.left !== r.right && !r.wsOnly && lineClass(r.left.kind))}>{r.left?.text ?? ""}</td>
            <td className="ln">{r.right?.newNo ?? ""}</td>
            <td className={clsx("code", r.right && r.left !== r.right && !r.wsOnly && lineClass(r.right.kind))}>{r.right?.text ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
