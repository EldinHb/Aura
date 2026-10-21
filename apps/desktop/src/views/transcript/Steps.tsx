import { memo, useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { Modal } from "../../components/Modal";
import type { Item } from "../../gen";
import { useStore } from "../../state/store";
import { ItemRow } from "./ItemRow";
import { isCardKind } from "./format";
import { replySteps, summarizeSteps, type StepGroup } from "./replySteps";
import { reportedWorkers, type ReportSection } from "../../lib/orchestration";
import { openWorkerThread } from "../../state/workerThreads";

export type StepsButtonProps = {
  group: StepGroup;
  sessionId: string;
  cursor: boolean;
  stale?: boolean;
  onCursor: (id: string) => void;
};

/** The workers the reports in a group cover, each once, latest report last. */
function reportedIn(group: StepGroup): ReportSection[] {
  const by = new Map<string, ReportSection>();
  for (const it of group.items) {
    for (const w of reportedWorkers(it)) {
      by.delete(w.workerId);
      by.set(w.workerId, w);
    }
  }
  return [...by.values()];
}

/**
 * One full-width row standing in for every step of a reply; opens them in a
 * modal. Under a row of worker reports, links to each reported worker's thread.
 */
export const StepsButton = memo(function StepsButton({ group, sessionId, cursor, stale, onCursor }: StepsButtonProps) {
  const s = summarizeSteps(group.items);
  const key = `steps:${group.id}`;
  const workers = group.aura ? reportedIn(group) : [];
  return (
    <>
      <button
        type="button"
        className={clsx("item steps-row", group.aura && "aura", s.running && "running", cursor && "cursor", stale && "stale")}
        data-steps-id={group.id}
        data-hint
        onClick={() => {
          onCursor(key);
          openSteps(sessionId, group.id);
        }}
      >
        <span className={clsx("status-ico", s.running ? "in_progress" : s.failed ? "failed" : "completed")} />
        <span className="steps-title">{s.running ? "Working" : (s.aura ?? `${s.count} ${s.count === 1 ? "step" : "steps"}`)}</span>
        <span className="steps-detail dim">{s.running && s.current ? s.current : s.parts}</span>
        {s.failed > 0 && <span className="err-text">{s.failed} failed</span>}
        <span className="spacer" />
        {s.duration && <span className="dim">{s.duration}</span>}
        <span className="dim">view ▸</span>
      </button>
      {workers.length > 0 && (
        <div className={clsx("steps-threads", stale && "stale")}>
          <span className="dim">{workers.length === 1 ? "Thread" : "Threads"}</span>
          {workers.map((w) => (
            <button key={w.workerId} type="button" className="chip linkish" data-hint data-command="orchestrator.thread" title={`${w.title}: ${w.detail}`} onClick={() => openWorkerThread(sessionId, w.workerId)}>
              {w.title} <span className="dim">· {w.status}</span> ▸
            </button>
          ))}
        </div>
      )}
    </>
  );
});

export function openSteps(sessionId: string, groupId: string) {
  useStore.getState().openDialog({ kind: "steps", sessionId, groupId });
}

/** Every step of one reply, live while the agent is still working on it. */
export function StepsDialog({ sessionId, groupId }: { sessionId: string; groupId: string }) {
  const t = useStore((s) => s.transcripts[sessionId]);
  const showReasoning = useStore((s) => s.settings.showReasoning);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const { group, byParent } = useMemo(() => {
    const steps = replySteps(t?.order ?? [], t?.items ?? {}, showReasoning);
    return { group: steps.groups.get(groupId) ?? null, byParent: steps.byParent };
  }, [t, showReasoning, groupId]);

  const toggle = useCallback(
    (id: string) => {
      const it = t?.items[id];
      // Reasoning opens by default here: reading it is why the modal was opened.
      const def = it ? (it.kind === "reasoning" ? true : isCardKind(it.kind) ? it.status !== "completed" : false) : false;
      setExpanded((e) => ({ ...e, [id]: !(e[id] ?? def) }));
    },
    [t],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = bodyRef.current;
    if (!el || e.metaKey || e.ctrlKey || e.altKey) return;
    const by = e.key === "j" ? 60 : e.key === "k" ? -60 : e.key === "d" ? el.clientHeight / 2 : e.key === "u" ? -el.clientHeight / 2 : 0;
    if (by) {
      e.preventDefault();
      el.scrollBy({ top: by });
    } else if (e.key === "G") el.scrollTop = el.scrollHeight;
  };

  const summary = group ? summarizeSteps(group.items) : null;
  const row = (it: Item, nested: boolean) => (
    <ItemRow
      key={it.id}
      item={it}
      nested={nested}
      cursor={cursor === it.id}
      expanded={expanded[it.id] ?? (it.kind === "reasoning" ? true : undefined)}
      onToggle={toggle}
      onCursor={setCursor}
      showReasoning
    />
  );

  return (
    <Modal
      className="steps-modal"
      width={960}
      onKeyDown={onKeyDown}
      title={
        <>
          <span>{summary?.running ? "Working" : (summary?.aura ?? "Steps")}</span>
          {summary && <span className="dim">{summary.parts}</span>}
          <span className="spacer" />
          {summary?.duration && <span className="dim">{summary.duration}</span>}
        </>
      }
    >
      <div className="steps-list" ref={bodyRef} tabIndex={0} data-autofocus>
        {!group && <div className="list-empty">These steps are no longer in the transcript.</div>}
        {group?.items.map((it) => [
          row(it, false),
          ...(byParent.get(it.id) ?? []).filter((c) => showReasoning || c.kind !== "reasoning").map((c) => row(c, true)),
        ])}
      </div>
    </Modal>
  );
}
