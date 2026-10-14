import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { UserInputRequest } from "../../gen";
import { useStore } from "../../state/store";
import { physicalKey } from "../../lib/keymap";

type Sel = Record<string, { picked: Set<number>; text: string }>;

const answered = (s: Sel[string]) => s.picked.size > 0 || !!s.text.trim();

export function UserInputCard({ request, sessionId, cursor }: { request: UserInputRequest; sessionId: string; cursor: boolean }) {
  const client = useStore((s) => s.client);
  const toast = useStore((s) => s.toast);
  const [qi, setQi] = useState(0);
  const [oi, setOi] = useState(0);
  const [sel, setSelState] = useState<Sel>(() => Object.fromEntries(request.questions.map((q) => [q.id, { picked: new Set<number>(), text: "" }])));
  // Keys can pick and submit in one handler, so submit reads the latest selection from here, not a stale render.
  const selRef = useRef(sel);
  const setSel = (next: Sel) => {
    selRef.current = next;
    setSelState(next);
  };
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const qs = request.questions;
  const q = qs[qi];

  // Take the keyboard as soon as the question shows; a frame later so a region focus queued for the same frame does not win.
  useEffect(() => {
    const id = requestAnimationFrame(() => rootRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, []);

  const goTo = (idx: number, s: Sel = selRef.current) => {
    const nq = qs[idx];
    if (!nq) return;
    setQi(idx);
    const first = [...s[nq.id].picked].sort((a, b) => a - b)[0];
    setOi(first ?? 0);
  };

  /** The first unanswered question after `from`, wrapping; null when every question has an answer. */
  const nextOpen = (from: number, s: Sel): number | null => {
    for (let k = 1; k <= qs.length; k++) {
      const idx = (from + k) % qs.length;
      if (!answered(s[qs[idx].id])) return idx;
    }
    return null;
  };

  const pick = (qIdx: number, idx: number): Sel => {
    const qq = qs[qIdx];
    const cur = selRef.current[qq.id];
    let picked: Set<number>;
    if (qq.multi_select) {
      picked = new Set(cur.picked);
      if (picked.has(idx)) picked.delete(idx);
      else picked.add(idx);
    } else picked = new Set([idx]);
    const next = { ...selRef.current, [qq.id]: { ...cur, picked } };
    setSel(next);
    return next;
  };

  const submit = async (s: Sel = selRef.current) => {
    if (!client || busy) return;
    const answers: Record<string, string[]> = {};
    for (const [idx, qq] of qs.entries()) {
      const a = s[qq.id];
      const labels = [...a.picked].sort((x, y) => x - y).map((i) => qq.options[i]?.label).filter((x): x is string => !!x);
      if (a.text.trim()) labels.push(a.text.trim());
      if (labels.length === 0) {
        toast(`Answer “${qq.header ?? qq.question}” first`, "warn");
        goTo(idx, s);
        rootRef.current?.focus();
        return;
      }
      answers[qq.id] = labels;
    }
    setBusy(true);
    try {
      await client.respondInput(sessionId, { request_id: request.id, answers });
    } catch (e) {
      toast(`answer: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  /** Enter: send when every question has an answer, otherwise move on to the next open one. */
  const confirm = (s: Sel) => {
    const open = nextOpen(qi, s);
    if (open === null) void submit(s);
    else {
      goTo(open, s);
      rootRef.current?.focus();
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") {
      if (e.key === "Enter") {
        e.preventDefault();
        confirm(selRef.current);
      }
      if (e.key === "Escape") rootRef.current?.focus();
      e.stopPropagation();
      return;
    }
    if (!q) return;
    const n = q.options.length;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        setOi((i) => Math.min(n - 1, i + 1));
        break;
      case "k":
      case "ArrowUp":
        setOi((i) => Math.max(0, i - 1));
        break;
      case "l":
      case "ArrowRight":
        goTo(Math.min(qs.length - 1, qi + 1));
        break;
      case "h":
      case "ArrowLeft":
        goTo(Math.max(0, qi - 1));
        break;
      case "Tab":
        goTo((qi + (e.shiftKey ? -1 : 1) + qs.length) % qs.length);
        break;
      case " ":
      case "x":
        if (q.options[oi]) pick(qi, oi);
        break;
      case "Enter": {
        // Nothing chosen yet: Enter takes the option under the cursor.
        const s = !answered(selRef.current[q.id]) && q.options[oi] ? pick(qi, oi) : selRef.current;
        confirm(s);
        break;
      }
      case "i":
        (rootRef.current?.querySelector(`input[data-q="${q.id}"]`) as HTMLInputElement | null)?.focus();
        break;
      default: {
        const num = Number(e.altKey ? physicalKey(e) : e.key);
        if (num >= 1 && num <= 9 && q.options[num - 1]) {
          const s = pick(qi, num - 1);
          setOi(num - 1);
          // A single answer is complete once chosen, so move straight on to the next open question.
          const open = q.multi_select ? null : nextOpen(qi, s);
          if (open !== null) goTo(open, s);
          break;
        }
        return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div ref={rootRef} className={clsx("card input", cursor && "cursor")} data-input-id={request.id} data-keynav tabIndex={0} onKeyDown={onKey}>
      <div className="card-head">
        <span className="dot info pulse" />
        <span>The agent has a question</span>
        <span className="spacer" />
        <span className="dim">{qs.length > 1 ? `${qi + 1}/${qs.length} · ←→ / Tab switch question` : ""}</span>
      </div>
      {qs.map((qq, qIdx) => {
        const active = qIdx === qi;
        const s = sel[qq.id];
        return (
          <div key={qq.id} className={clsx("question", active && "active")} data-hint onClick={() => qIdx !== qi && goTo(qIdx)}>
            {(qq.header || qs.length > 1) && (
              <div className="question-head">
                {qq.header}
                {answered(s) && <span className="dim"> ✓</span>}
              </div>
            )}
            <div className="question-text">{qq.question}</div>
            <div className="options">
              {qq.options.map((o, idx) => (
                <button
                  key={idx}
                  type="button"
                  tabIndex={-1}
                  className={clsx("option", active && idx === oi && "cursor", s.picked.has(idx) && "picked")}
                  data-command="input.pick-option"
                  onClick={(e) => {
                    e.stopPropagation();
                    setQi(qIdx);
                    setOi(idx);
                    pick(qIdx, idx);
                    // Keep the keyboard on the card after a click, so number keys and Enter keep working.
                    rootRef.current?.focus();
                  }}
                >
                  <span className="option-box">{qq.multi_select ? (s.picked.has(idx) ? "☑" : "☐") : s.picked.has(idx) ? "◉" : "○"}</span>
                  <kbd>{idx + 1}</kbd>
                  <span className="option-label">{o.label}</span>
                  {o.description && <span className="dim option-desc">{o.description}</span>}
                </button>
              ))}
            </div>
            {qq.allow_free_text && (
              <input
                type="text"
                data-q={qq.id}
                placeholder="Or type an answer… (i)"
                value={s.text}
                onFocus={() => setQi(qIdx)}
                onChange={(e) => setSel({ ...selRef.current, [qq.id]: { ...selRef.current[qq.id], text: e.target.value } })}
              />
            )}
          </div>
        );
      })}
      <div className="actions">
        <button className="btn small primary" type="button" disabled={busy} data-command="input.submit" onClick={() => void submit()}>Answer <kbd>Enter</kbd></button>
        <span className="dim">↑↓ move · 1-9 / space pick{qs.length > 1 ? " · ←→ question" : ""} · i type · Enter {qs.length > 1 ? "next / answer" : "answer"}</span>
      </div>
    </div>
  );
}
