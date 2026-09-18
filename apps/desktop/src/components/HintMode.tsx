import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { activateHintTarget, collectHintTargets, filterLabels, HINT_ALPHABET, type HintTarget } from "./hints";

/** Vimium-style hint labels: press the label to click / focus the element. */
export function HintMode() {
  const active = useStore((s) => s.hintMode);
  const setHintMode = useStore((s) => s.setHintMode);
  const [targets, setTargets] = useState<HintTarget[]>([]);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!active) {
      setTargets([]);
      setTyped("");
      return;
    }
    const recompute = () => setTargets(collectHintTargets());
    recompute();
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setHintMode(false);
        return;
      }
      if (e.key === "Backspace") {
        setTyped((t) => t.slice(0, -1));
        return;
      }
      const k = e.key.toLowerCase();
      if (k.length !== 1 || !HINT_ALPHABET.includes(k)) return;
      setTyped((prev) => {
        const next = prev + k;
        const current = collectHintTargets();
        const labels = current.map((t) => t.label);
        const matches = filterLabels(labels, next);
        if (matches.length === 0) return prev;
        const exact = current.find((t) => t.label === next);
        if (exact) {
          setHintMode(false);
          // let React unmount the labels before dispatching the click
          setTimeout(() => activateHintTarget(exact.el), 0);
          return "";
        }
        return next;
      });
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, { capture: true });
    };
  }, [active, setHintMode]);

  if (!active) return null;
  const visible = targets.filter((t) => t.label.startsWith(typed));
  return (
    <>
      {visible.map((t) => (
        <span key={t.label} className="hint-label" style={{ left: Math.max(0, t.rect.left - 2), top: Math.max(0, t.rect.top - 4) }} aria-hidden>
          {typed && <span className="typed">{typed}</span>}
          {t.label.slice(typed.length)}
        </span>
      ))}
      <div className="hint-status">
        hint mode · type a label · <kbd>Esc</kbd> exit
      </div>
    </>
  );
}
