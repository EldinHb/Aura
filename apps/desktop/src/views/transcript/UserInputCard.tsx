import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { UserInputRequest } from "../../gen";
import { useStore } from "../../state/store";
import { physicalKey } from "../../lib/keymap";

type Sel = Record<string, { picked: Set<number>; text: string }>;

export function UserInputCard({ request, sessionId, cursor }: { request: UserInputRequest; sessionId: string; cursor: boolean }) {
  const client = useStore((s) => s.client);
  const toast = useStore((s) => s.toast);
  const [qi, setQi] = useState(0);
  const [oi, setOi] = useState(0);
  const [sel, setSel] = useState<Sel>(() => Object.fromEntries(request.questions.map((q) => [q.id, { picked: new Set<number>(), text: "" }])));
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const q = request.questions[qi];

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const toggle = (qid: string, idx: number, multi: boolean) => {
    setSel((s) => {
      const cur = s[qid];
      const picked = new Set(multi ? cur.picked : []);
      if (picked.has(idx)) picked.delete(idx);
      else picked.add(idx);
      return { ...s, [qid]: { ...cur, picked } };
    });
  };

  const submit = async () => {
    if (!client || busy) return;
    const answers: Record<string, string[]> = {};
    for (const qq of request.questions) {
      const s = sel[qq.id];
      const labels = [...s.picked].sort().map((i) => qq.options[i]?.label).filter((x): x is string => !!x);
      if (s.text.trim()) labels.push(s.text.trim());
      if (labels.length === 0) {
        toast(`Answer “${qq.header ?? qq.question}” first`, "warn");
        setQi(request.questions.indexOf(qq));
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

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
      if (e.key === "Escape") rootRef.current?.focus();
      e.stopPropagation();
      return;
    }
    const n = q?.options.length ?? 0;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        setOi((i) => Math.min(n - 1, i + 1));
        break;
      case "k":
      case "ArrowUp":
        setOi((i) => Math.max(0, i - 1));
        break;
      case " ":
      case "x":
        if (q) toggle(q.id, oi, q.multi_select);
        break;
      case "Tab":
        setQi((i) => (i + (e.shiftKey ? -1 : 1) + request.questions.length) % request.questions.length);
        setOi(0);
        break;
      case "Enter":
        if (q && !q.multi_select && q.options[oi] && sel[q.id].picked.size === 0 && !sel[q.id].text) toggle(q.id, oi, false);
        // let state settle then submit
        setTimeout(() => void submit(), 0);
        break;
      case "i":
        (rootRef.current?.querySelector(`input[data-q="${q?.id}"]`) as HTMLInputElement | null)?.focus();
        break;
      default: {
        const num = Number(e.altKey ? physicalKey(e) : e.key);
        if (q && num >= 1 && num <= 9 && q.options[num - 1]) {
          toggle(q.id, num - 1, q.multi_select);
          setOi(num - 1);
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
        <span className="dim">{request.questions.length > 1 ? `${qi + 1}/${request.questions.length} · Tab next` : ""}</span>
      </div>
      {request.questions.map((qq, qIdx) => {
        const active = qIdx === qi;
        const s = sel[qq.id];
        return (
          <div key={qq.id} className={clsx("question", active && "active")} data-hint onClick={() => setQi(qIdx)}>
            {qq.header && <div className="question-head">{qq.header}</div>}
            <div className="question-text">{qq.question}</div>
            <div className="options">
              {qq.options.map((o, idx) => (
                <button
                  key={idx}
                  className={clsx("option", active && idx === oi && "cursor", s.picked.has(idx) && "picked")}
                  data-command="input.pick-option"
                  onClick={(e) => {
                    e.stopPropagation();
                    setQi(qIdx);
                    setOi(idx);
                    toggle(qq.id, idx, qq.multi_select);
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
                onChange={(e) => setSel((st) => ({ ...st, [qq.id]: { ...st[qq.id], text: e.target.value } }))}
              />
            )}
          </div>
        );
      })}
      <div className="actions">
        <button className="btn small primary" disabled={busy} data-command="input.submit" onClick={() => void submit()}>Answer <kbd>Enter</kbd></button>
        <span className="dim">j/k move · space / 1-9 pick</span>
      </div>
    </div>
  );
}
