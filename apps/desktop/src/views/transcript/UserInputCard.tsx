import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { Question, UserInputRequest } from "../../gen";
import { useStore } from "../../state/store";
import { physicalKey } from "../../lib/keymap";
import { setFocus } from "../../commands/core";
import { useQuestionKey } from "./questionKey";

/** Per question: the options picked, whether "Other" is chosen, and the text typed for it. */
type Sel = Record<string, { picked: Set<number>; other: boolean; text: string }>;

/** An open "Other" needs its text, also next to picked options: an empty one is never dropped silently. */
const answered = (s: Sel[string]) => (s.other ? !!s.text.trim() : s.picked.size > 0);

/** An option the agent wrote itself that means "something else", e.g. "Other" or "Other (please specify)". */
const OTHER_LABEL = /^other\s*(\(.*\))?\s*(…|\.\.\.|:)?$/i;

/**
 * Where the "Other" row sits: the agent's own "Other" option when it wrote one, else a row after its options.
 * -1 when the question takes no typed answer.
 */
export function otherIndex(q: Question): number {
  if (!q.allow_free_text) return -1;
  const own = q.options.findIndex((o) => OTHER_LABEL.test(o.label.trim()));
  return own >= 0 ? own : q.options.length;
}

/** Focus that is nobody's in particular: the card may take it. Never a field, the message box or another control. */
function idleFocus(el: Element | null): boolean {
  return !el || el === document.body || (el as HTMLElement).matches?.(".transcript, [data-region='main']") === true;
}

/** Nothing to choose from: the only way to answer is to type. */
const textOnly = (q: Question) => q.options.length === 0 && q.allow_free_text;

/** The rows shown for a question: its options, plus an "Other" row when the agent did not write one. A text-only question shows just its field. */
const rowCount = (q: Question) => (!textOnly(q) && otherIndex(q) === q.options.length ? q.options.length + 1 : q.options.length);

export function UserInputCard({ request, sessionId, cursor }: { request: UserInputRequest; sessionId: string; cursor: boolean }) {
  const client = useStore((s) => s.client);
  const toast = useStore((s) => s.toast);
  const [qi, setQi] = useState(0);
  const [oi, setOi] = useState(0);
  // A question with nothing to choose from is answered by typing, so its field is open from the start.
  const [sel, setSelState] = useState<Sel>(() => Object.fromEntries(request.questions.map((q) => [q.id, { picked: new Set<number>(), other: textOnly(q), text: "" }])));
  // Keys can pick and submit in one handler, so submit reads the latest selection from here, not a stale render.
  const selRef = useRef(sel);
  const setSel = (next: Sel) => {
    selRef.current = next;
    setSelState(next);
  };
  const [busy, setBusy] = useState(false);
  // Set as a send starts and kept once it lands: the card stays up until the resolved event removes it, and a second
  // send in that gap would only hit "unknown input request". The state alone is a render late for a quick double press.
  const sentRef = useRef(false);
  // The question whose "Other" field should take the keyboard once it is on screen; the count makes a repeat request count.
  const [focusText, setFocusText] = useState<{ id: string; n: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const qs = request.questions;
  const q = qs[qi];
  const qiRef = useRef(qi);
  qiRef.current = qi;

  const textField = (id: string) => [...(rootRef.current?.querySelectorAll<HTMLInputElement>("input[data-q]") ?? [])].find((el) => el.dataset.q === id);

  // Take the keyboard once, as soon as the question shows, unless the user is busy elsewhere: keys meant for the message
  // box would pick, switch and even dismiss here. A frame later so a region focus queued for the same frame does not
  // win. A question that arrives under a dialog tries on the first frame after it closes, once the dialog has given
  // focus back; that is the only retry, so closing a later dialog never pulls the user back here.
  const dialogOpen = useStore((s) => s.dialog.kind !== "none");
  const focusTried = useRef(false);
  // Whether the keyboard is on the card (or in one of its fields). The card never takes it from the user, so while it
  // is elsewhere the card stands out and says which key brings the user here; not before the first try, which would
  // otherwise flash the hint for a frame.
  const [hasKeyboard, setHasKeyboard] = useState(false);
  const [settled, setSettled] = useState(false);
  const away = settled && !hasKeyboard;
  const questionKey = useQuestionKey();
  useEffect(() => {
    if (dialogOpen || focusTried.current) return;
    const id = requestAnimationFrame(() => {
      focusTried.current = true;
      setSettled(true);
      if (!idleFocus(document.activeElement)) return;
      const cur = qs[qiRef.current];
      const field = cur && selRef.current[cur.id].other ? textField(cur.id) : undefined;
      (field ?? rootRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [dialogOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (focusText) textField(focusText.id)?.focus();
  }, [focusText]);

  const goTo = (idx: number, s: Sel = selRef.current) => {
    const nq = qs[idx];
    if (!nq) return;
    setQi(idx);
    const first = s[nq.id].other ? otherIndex(nq) : [...s[nq.id].picked].sort((a, b) => a - b)[0];
    setOi(first ?? 0);
  };

  /** Move to question `idx` and give it the keyboard: its field when "Other" is open there, else the card. */
  const landOn = (idx: number, s: Sel) => {
    goTo(idx, s);
    const nq = qs[idx];
    if (nq && s[nq.id].other) setFocusText((f) => ({ id: nq.id, n: (f?.n ?? 0) + 1 }));
    else rootRef.current?.focus();
  };

  /** The first unanswered question after `from`, wrapping; null when every question has an answer. */
  const nextOpen = (from: number, s: Sel): number | null => {
    for (let k = 1; k <= qs.length; k++) {
      const idx = (from + k) % qs.length;
      if (!answered(s[qs[idx].id])) return idx;
    }
    return null;
  };

  /** Choose row `idx` of question `qIdx`. The "Other" row opens its text field and puts the keyboard there. */
  const pick = (qIdx: number, idx: number): Sel => {
    const qq = qs[qIdx];
    const cur = selRef.current[qq.id];
    let next: Sel[string];
    if (idx === otherIndex(qq)) {
      // Multi-select toggles "Other" like any option; single-select swaps the picked option for it.
      const on = qq.multi_select ? !cur.other : true;
      next = { ...cur, other: on, picked: qq.multi_select ? cur.picked : new Set() };
      if (on) setFocusText((f) => ({ id: qq.id, n: (f?.n ?? 0) + 1 }));
    } else if (qq.multi_select) {
      const picked = new Set(cur.picked);
      if (picked.has(idx)) picked.delete(idx);
      else picked.add(idx);
      next = { ...cur, picked };
    } else next = { ...cur, picked: new Set([idx]), other: false };
    const all = { ...selRef.current, [qq.id]: next };
    setSel(all);
    return all;
  };

  const submit = async (s: Sel = selRef.current) => {
    if (!client || sentRef.current) return;
    const answers: Record<string, string[]> = {};
    for (const [idx, qq] of qs.entries()) {
      const a = s[qq.id];
      const labels = [...a.picked].sort((x, y) => x - y).map((i) => qq.options[i]?.label).filter((x): x is string => !!x);
      if (a.other && a.text.trim()) labels.push(a.text.trim());
      if (!answered(a)) {
        const name = qq.header ?? qq.question;
        toast(!a.other ? `Answer “${name}” first` : textOnly(qq) ? `Type your answer to “${name}” first` : qq.multi_select ? `Type your “Other” answer to “${name}”, or untick Other` : `Type your answer to “${name}”, or pick an option`, "warn");
        landOn(idx, s);
        return;
      }
      answers[qq.id] = labels;
    }
    await send(answers, false);
  };

  /** Send once; only a failed send lets the user try again. */
  const send = async (answers: Record<string, string[]>, declined: boolean) => {
    if (!client || sentRef.current) return false;
    sentRef.current = true;
    setBusy(true);
    try {
      await client.respondInput(sessionId, { request_id: request.id, answers, declined });
      return true;
    } catch (e) {
      sentRef.current = false;
      setBusy(false);
      toast(`${declined ? "dismiss" : "answer"}: ${e instanceof Error ? e.message : String(e)}`, "error");
      return false;
    }
  };

  /** Tell the agent the user will not answer, then hand the keyboard to the composer for a normal message. */
  const dismiss = async () => {
    if (await send({}, true)) setFocus("composer");
  };

  /** Enter: send when every question has an answer, otherwise move on to the next open one. When only this one is
   * open, submit says what it still needs and puts the keyboard there. */
  const confirm = (s: Sel) => {
    const open = nextOpen(qi, s);
    if (open === null || open === qi) void submit(s);
    else landOn(open, s);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT") {
      const qq = qs.find((x) => x.id === target.dataset.q);
      if (e.key === "Enter") {
        e.preventDefault();
        // An empty "Other" field stays put rather than skipping the question.
        if (qq && answered(selRef.current[qq.id])) confirm(selRef.current);
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Back to the card; an "Other" left empty is closed again. A text-only field has nothing to close.
        const a = qq && selRef.current[qq.id];
        if (qq && a && !textOnly(qq) && !a.text.trim()) setSel({ ...selRef.current, [qq.id]: { ...a, other: false } });
        rootRef.current?.focus();
      }
      // Everything typed here is text, not an option hotkey or an app shortcut.
      e.stopPropagation();
      return;
    }
    // A focused button (Answer, Dismiss) does its own Enter and Space.
    if (target.tagName === "BUTTON" && (e.key === "Enter" || e.key === " ")) return;
    if (!q) return;
    const n = rowCount(q);
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
      // Tab on the card switches questions and lands like Enter does, in the question's field when it is open; it
      // never moves the keyboard off the card, so Escape (or the mouse) is the way out. Tab in a field is the
      // browser's, on to the Answer and Dismiss buttons. The arrows only browse and keep the keyboard on the card:
      // inside a field they move the text cursor, so landing there would end the browsing.
      case "Tab":
        landOn((qi + (e.shiftKey ? -1 : 1) + qs.length) % qs.length, selRef.current);
        break;
      case " ":
      case "x":
        if (oi < n) pick(qi, oi);
        break;
      case "Enter": {
        const cur = selRef.current[q.id];
        if (cur.picked.size === 0 && !cur.other && oi < n) {
          // Nothing chosen at all: Enter takes the row under the cursor; on "Other" that opens the field instead of sending.
          // Anything chosen already stays as it is, also an Other still waiting for its text.
          const s = pick(qi, oi);
          if (oi !== otherIndex(q)) confirm(s);
        } else confirm(selRef.current);
        break;
      }
      case "d":
        void dismiss();
        break;
      case "i":
        if (otherIndex(q) >= 0) {
          setOi(otherIndex(q));
          if (!selRef.current[q.id].other) pick(qi, otherIndex(q));
          else setFocusText((f) => ({ id: q.id, n: (f?.n ?? 0) + 1 }));
        }
        break;
      default: {
        const num = Number(e.altKey ? physicalKey(e) : e.key);
        if (num >= 1 && num <= 9 && num <= n) {
          const s = pick(qi, num - 1);
          setOi(num - 1);
          // A single answer is complete once chosen, so move straight on to the next open question.
          const open = q.multi_select || num - 1 === otherIndex(q) ? null : nextOpen(qi, s);
          if (open !== null) landOn(open, s);
          break;
        }
        return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={rootRef}
      className={clsx("card input", cursor && "cursor", away && "away")}
      data-input-id={request.id}
      data-keynav
      tabIndex={0}
      onKeyDown={onKey}
      onFocus={() => setHasKeyboard(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHasKeyboard(false)}
    >
      <div className="card-head">
        <span className="dot info pulse" />
        <span>The agent has a question</span>
        {away && (
          <span className="question-hint" role="status">
            {questionKey ? <><kbd>{questionKey}</kbd> to answer</> : "Click to answer"}
          </span>
        )}
        <span className="spacer" />
        <span className="dim">{qs.length > 1 ? `${qi + 1}/${qs.length} · ←→ / Tab switch question` : ""}</span>
      </div>
      {qs.map((qq, qIdx) => {
        const active = qIdx === qi;
        const s = sel[qq.id];
        const oIdx = otherIndex(qq);
        const rows = rowCount(qq) > qq.options.length ? [...qq.options, { label: "Other", description: "type your own answer" }] : qq.options;
        const isPicked = (idx: number) => (idx === oIdx ? s.other : s.picked.has(idx));
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
              {rows.map((o, idx) => (
                <button
                  key={idx}
                  type="button"
                  tabIndex={-1}
                  className={clsx("option", active && idx === oi && "cursor", isPicked(idx) && "picked", idx === oIdx && "other")}
                  data-command="input.pick-option"
                  onClick={(e) => {
                    e.stopPropagation();
                    setQi(qIdx);
                    setOi(idx);
                    const next = pick(qIdx, idx);
                    // Keep the keyboard on the card after a click, so number keys and Enter keep working; an "Other" turned on
                    // sends it to its field. One turned off takes its focused field away, so the card takes the keyboard back.
                    if (idx !== oIdx || !next[qq.id].other) rootRef.current?.focus();
                  }}
                >
                  <span className="option-box">{qq.multi_select ? (isPicked(idx) ? "☑" : "☐") : isPicked(idx) ? "◉" : "○"}</span>
                  {idx < 9 && <kbd>{idx + 1}</kbd>}
                  <span className="option-label">{o.label}</span>
                  {o.description && <span className="dim option-desc">{o.description}</span>}
                </button>
              ))}
            </div>
            {s.other && (
              <input
                type={qq.secret ? "password" : "text"}
                className="other-input"
                data-q={qq.id}
                // Escape here goes back to the card, so the app keymap must not take it first.
                data-own-escape=""
                aria-label={`Your answer to: ${qq.question}`}
                placeholder={textOnly(qq) ? "Type your answer… (Enter to confirm, Esc back to the card)" : "Type your answer… (Enter to confirm, Esc back to the options)"}
                autoComplete="off"
                value={s.text}
                onFocus={() => {
                  setQi(qIdx);
                  setOi(oIdx);
                }}
                onChange={(e) => setSel({ ...selRef.current, [qq.id]: { ...selRef.current[qq.id], text: e.target.value } })}
              />
            )}
          </div>
        );
      })}
      <div className="actions">
        <button className="btn small primary" type="button" disabled={busy} data-command="input.submit" onClick={() => void submit()}>Answer <kbd>Enter</kbd></button>
        <button className="btn small" type="button" disabled={busy} data-command="input.dismiss" title="Tell the agent you will not answer" onClick={() => void dismiss()}>Dismiss <kbd>d</kbd></button>
        <span className="dim">↑↓ move · 1-9 / space pick{qs.length > 1 ? " · ←→ question" : ""}{qs.some((x) => otherIndex(x) >= 0) ? " · i other" : ""} · Enter {qs.length > 1 ? "next / answer" : "answer"} · d dismiss</span>
      </div>
    </div>
  );
}
