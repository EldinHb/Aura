import { memo } from "react";
import { classifyDiffLine } from "./format";

export const DiffText = memo(function DiffText({ diff, maxLines = 400 }: { diff: string; maxLines?: number }) {
  const lines = diff.split("\n");
  const shown = lines.slice(0, maxLines);
  return (
    <pre className="diff">
      {shown.map((l, i) => (
        <div key={i} className={`diff-${classifyDiffLine(l)}`}>{l || " "}</div>
      ))}
      {lines.length > maxLines && <div className="diff-meta">… {lines.length - maxLines} more lines</div>}
    </pre>
  );
});
