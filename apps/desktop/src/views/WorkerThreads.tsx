import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { ProviderInfo, Session } from "../gen";
import { useStore } from "../state/store";
import { closeWorkerThreads, openWorkerThread, useWorkerThreads } from "../state/workerThreads";
import { sessionProviderLabel } from "../lib/acp";
import { statusClass } from "../lib/sessionStatus";
import { exactTime, timeAgo } from "../lib/time";
import { auraMessage } from "../lib/auraMessage";
import { orchestratorMessages, sentTexts, workerThread, type ThreadEntry } from "../lib/orchestration";
import { transcriptTree } from "./transcript/replySteps";
import { Markdown } from "./transcript/MarkdownView";

/** An orchestrator's workers, oldest first. */
export function useWorkers(orchestratorId: string): Session[] {
  const sessions = useStore((st) => st.sessions);
  return useMemo(
    () => Object.values(sessions).filter((w) => w.orchestrator_id === orchestratorId).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [sessions, orchestratorId],
  );
}

/** "Claude Code · opus · high": the agent a worker runs, with its model and effort. */
export function agentLine(s: Session, providers: ProviderInfo[]): string {
  return `${sessionProviderLabel(s, providers)} · ${s.model || "default"} · ${s.effort || "default"}`;
}

/** Switches an orchestrator between its chat with the user and its threads with its workers. */
export function OrchestratorTabs({ orchestratorId }: { orchestratorId: string }) {
  const workers = useWorkers(orchestratorId).filter((w) => !w.archived);
  const onWorkers = useWorkerThreads((s) => s.views[orchestratorId]?.tab === "workers");
  return (
    <div className="tabs orchestrator-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={!onWorkers} data-hint data-command="orchestrator.chat" className={clsx("tab", !onWorkers && "active")} onClick={() => closeWorkerThreads(orchestratorId)}>
        Chat
      </button>
      <button type="button" role="tab" aria-selected={onWorkers} data-hint data-command="orchestrator.workers" className={clsx("tab", onWorkers && "active")} onClick={() => openWorkerThread(orchestratorId)}>
        Workers <span className="dim">{workers.length}</span>
      </button>
    </div>
  );
}

/**
 * The orchestrator's workers on the left, the conversation with the picked one
 * on the right. Archived workers are left out of the list, unless a link (from
 * a report, say) picked one: that one is listed, marked archived, with its thread.
 */
export function WorkerThreads({ orchestratorId }: { orchestratorId: string }) {
  const all = useWorkers(orchestratorId);
  const providers = useStore((st) => st.providers);
  const picked = useWorkerThreads((s) => s.views[orchestratorId]?.worker);
  const worker = all.find((w) => w.id === picked) ?? null;
  const workers = all.filter((w) => !w.archived || w.id === picked);
  return (
    <div className="worker-threads">
      <div className="worker-list" role="list">
        {workers.length === 0 && <div className="list-empty">{all.length === 0 ? "No workers yet. The orchestrator starts them as it plans the work." : "Every worker is archived."}</div>}
        {workers.map((w) => (
          <button
            key={w.id}
            type="button"
            role="listitem"
            className={clsx("list-item worker-row", w.id === picked && "active", w.archived && "archived")}
            data-hint
            data-command="orchestrator.thread"
            onClick={() => openWorkerThread(orchestratorId, w.id)}
          >
            <span className={clsx("dot", statusClass(w))} />
            <span className="grow">
              <span className="worker-title">{w.title}</span>
              <span className="dim">{w.specialist_name && w.specialist_name !== w.title ? `${w.specialist_name} · ` : ""}{agentLine(w, providers)}</span>
            </span>
            <span className="dim">{w.archived ? "archived" : w.status === "running" ? "working" : w.status.replace("_", " ")}</span>
          </button>
        ))}
      </div>
      {worker ? (
        <WorkerThread key={worker.id} orchestratorId={orchestratorId} worker={worker} />
      ) : (
        (workers.length > 0 || picked) && (
          <div className="worker-thread empty">
            <span className="dim">{picked ? "That worker was deleted, with its conversation. Pick another one." : "Pick a worker to read its conversation with the orchestrator."}</span>
          </div>
        )
      )}
    </div>
  );
}

function When({ at }: { at: string }) {
  return <span className="dim" title={exactTime(at)}>{timeAgo(at)}</span>;
}

/** Everything the orchestrator and one worker said to each other, oldest first. */
function WorkerThread({ orchestratorId, worker }: { orchestratorId: string; worker: Session }) {
  const orchestrator = useStore((st) => st.sessions[orchestratorId]);
  const providers = useStore((st) => st.providers);
  const own = useStore((st) => st.transcripts[worker.id]);
  const lead = useStore((st) => st.transcripts[orchestratorId]);
  const select = useStore((st) => st.select);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    useStore.getState().loadTranscript(worker.id);
    useStore.getState().loadTranscript(orchestratorId);
  }, [worker.id, orchestratorId]);

  const entries = useMemo(() => {
    const workerTop = own ? transcriptTree(own.order, own.items).top : [];
    const leadTop = lead ? transcriptTree(lead.order, lead.items).top : [];
    const { senders } = orchestratorMessages(worker, workerTop, sentTexts(leadTop));
    return workerThread(worker.id, workerTop, senders, leadTop);
  }, [own, lead, worker]);

  // Opening a thread shows its latest message.
  const count = entries.length;
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = bodyRef.current;
    if (!el || e.metaKey || e.ctrlKey || e.altKey) return;
    const by = e.key === "j" ? 60 : e.key === "k" ? -60 : e.key === "d" ? el.clientHeight / 2 : e.key === "u" ? -el.clientHeight / 2 : 0;
    if (by) {
      e.preventDefault();
      el.scrollBy({ top: by });
    } else if (e.key === "G") el.scrollTop = el.scrollHeight;
  };

  const leadTitle = orchestrator?.title ?? "Orchestrator";
  const loading = !own?.loaded || !lead?.loaded;
  const entry = (e: ThreadEntry) => {
    const key = e.kind === "report" ? `${e.item.id}:${e.section.workerId}` : e.item.id;
    switch (e.kind) {
      case "orchestrator":
        return (
          <div key={key} className="thread-msg from-orchestrator" data-item-id={e.item.id}>
            <div className="thread-head">
              <span className="name">{leadTitle}</span>
              <span className="dim">orchestrator · {e.brief ? "brief" : "follow-up"}</span>
              <span className="spacer" />
              <When at={e.item.started_at} />
            </div>
            <Markdown text={e.item.text} cwd={worker.cwd} />
          </div>
        );
      case "user":
        return (
          <div key={key} className="thread-msg from-user" data-item-id={e.item.id}>
            <div className="thread-head">
              <span className="name">You</span>
              <span className="dim">to the worker directly</span>
              <span className="spacer" />
              <When at={e.item.started_at} />
            </div>
            <Markdown text={e.item.text} cwd={worker.cwd} />
          </div>
        );
      case "reply":
        return (
          <div key={key} className="thread-msg from-worker" data-item-id={e.item.id}>
            <div className="thread-head">
              <span className="name">{worker.title}</span>
              <span className="dim">worker</span>
              <span className="spacer" />
              <When at={e.item.started_at} />
            </div>
            <Markdown text={e.item.text} cwd={worker.cwd} />
            {e.item.status === "in_progress" && <span className="caret" />}
          </div>
        );
      case "aura":
      case "report": {
        const body = e.kind === "report" ? e.section.body : (auraMessage(e.item)?.body ?? "");
        const shown = open[key] ?? false;
        return (
          <div key={key} className="thread-msg from-aura" data-item-id={e.item.id}>
            <button type="button" className="thread-head" data-hint aria-expanded={shown} onClick={() => setOpen((o) => ({ ...o, [key]: !shown }))}>
              <span className="name">Aura</span>
              <span className="dim">{e.kind === "report" ? `worker report to ${leadTitle} · ${e.section.status}` : `${auraMessage(e.item)?.title ?? "message"} · to the worker`}</span>
              <span className="spacer" />
              <When at={e.item.started_at} />
              <span className="dim">{shown ? "▾" : "▸"}</span>
            </button>
            {shown && body && <Markdown text={body} cwd={worker.cwd} />}
          </div>
        );
      }
    }
  };

  return (
    <div className="worker-thread">
      <div className="thread-title">
        <span className={clsx("dot", statusClass(worker))} />
        <span className="name">{worker.title}</span>
        <span className="dim">{agentLine(worker, providers)}</span>
        {worker.archived && <span className="chip">archived</span>}
        <span className="spacer" />
        <button type="button" className="btn small" data-hint data-command="orchestrator.open-worker" onClick={() => select(worker.id)}>
          Open session ↗
        </button>
      </div>
      <div className="thread-body" ref={bodyRef} tabIndex={0} onKeyDown={onKeyDown}>
        {loading && entries.length === 0 && <div className="dim transcript-loading">Loading the conversation…</div>}
        {!loading && entries.length === 0 && <div className="list-empty">Nothing passed between them yet.</div>}
        {entries.map(entry)}
      </div>
    </div>
  );
}
