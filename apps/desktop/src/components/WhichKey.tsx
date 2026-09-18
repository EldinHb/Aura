import { useMemo } from "react";
import { useStore } from "../state/store";
import { formatKeys } from "../lib/keymap";
import { isMac } from "../lib/platform";
import clsx from "clsx";

export function WhichKey() {
  const wk = useStore((s) => s.whichKey);
  const sorted = useMemo(() => {
    if (!wk) return [];
    return [...wk.candidates].sort((a, b) => {
      const ga = a.label.startsWith("+") ? 0 : 1;
      const gb = b.label.startsWith("+") ? 0 : 1;
      return ga - gb || a.key.localeCompare(b.key);
    });
  }, [wk]);
  if (!wk) return null;
  return (
    <div className="whichkey" role="menu" aria-label="Key sequence">
      <div className="prefix">{formatKeys(wk.prefix.join(" "), isMac)} …</div>
      {sorted.map((c) => (
        <div key={c.key} className="k">
          <kbd>{formatKeys(c.key, isMac)}</kbd>
          <span className={clsx("label", c.label.startsWith("+") && "group")}>{c.label.startsWith("+") ? c.label.slice(1) : c.label}</span>
        </div>
      ))}
    </div>
  );
}
