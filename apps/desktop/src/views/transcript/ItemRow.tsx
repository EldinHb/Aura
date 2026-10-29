import { memo, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { Item } from "../../gen";
import { Markdown } from "./MarkdownView";
import { DiffText } from "./Diff";
import { MessageImages } from "../ImageThumbs";
import { useStore } from "../../state/store";
import { setPlanView } from "../../state/planView";
import { auraMessage } from "../../lib/auraMessage";
import { reportedWorkers } from "../../lib/orchestration";
import { openWorkerThread } from "../../state/workerThreads";
import { featureCard } from "../../lib/features";
import { FeatureCard } from "./FeatureCards";
import { commandOutput, contextBoundary, durationMs, firstLine, fmtDuration, isCardKind, isSlashCommand, itemChanges, itemLabel, kindIcon, prettyJson, truncate } from "./format";

const JSON_LIMIT = 4000;

function JsonBlock({ value, label }: { value: unknown; label?: string }) {
  const [all, setAll] = useState(false);
  if (value === undefined || value === null || value === "") return null;
  const text = prettyJson(value);
  const long = text.length > JSON_LIMIT;
  return (
    <div className="item-json">
      {label && <div className="dim item-json-label">{label}</div>}
      <pre>{all || !long ? text : text.slice(0, JSON_LIMIT) + "…"}</pre>
      {long && (
        <button className="btn small" data-hint onClick={() => setAll((v) => !v)}>
          {all ? "show less" : `show all (${text.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

function OutputPre({ text, streaming }: { text: string; streaming: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (streaming && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, streaming]);
  if (!text) return null;
  return <pre ref={ref} className="item-output">{text}</pre>;
}

type Plan = { steps?: { step: string; status?: string }[]; text?: string };

function CardBody({ item, cwd }: { item: Item; cwd: string | undefined }) {
  const d = item.data as Record<string, unknown>;
  const streaming = item.status === "in_progress";
  switch (item.kind) {
    case "command_exec":
      return (
        <>
          <pre className="item-cmd">
            <span className="dim">{d.cwd ? `${d.cwd} ` : ""}$ </span>
            {String(d.command ?? "")}
          </pre>
          <OutputPre text={String(d.output ?? "")} streaming={streaming} />
          {d.exit_code !== undefined && d.exit_code !== null && (
            <div className={clsx("dim", Number(d.exit_code) !== 0 && "err-text")}>exit {String(d.exit_code)}</div>
          )}
        </>
      );
    case "file_change":
      return (
        <>
          {itemChanges(item).map((c, i) => (
            <div key={i} className="item-change">
              <div className="item-change-head">
                <span className="chip">{c.kind ?? "modify"}</span> <span className="mono">{c.path}</span>
              </div>
              {c.diff && <DiffText diff={c.diff} />}
            </div>
          ))}
          {item.text && <pre>{item.text}</pre>}
        </>
      );
    case "tool_call":
    case "mcp_call":
      return (
        <>
          <JsonBlock value={d.input} label="input" />
          <JsonBlock value={d.result} label={d.is_error ? "error" : "result"} />
          {item.text && <pre>{item.text}</pre>}
        </>
      );
    case "web_search":
      return (
        <>
          {d.url ? <div className="mono dim">{String(d.url)}</div> : null}
          <JsonBlock value={d.results} label="results" />
          {item.text && <pre>{item.text}</pre>}
        </>
      );
    case "plan": {
      const p = d as Plan;
      if (p.steps && p.steps.length) {
        return (
          <ul className="plan">
            {p.steps.map((s, i) => (
              <li key={i} className={clsx("plan-step", s.status)}>
                <span className="plan-box">{s.status === "completed" ? "☑" : s.status === "in_progress" ? "◐" : "☐"}</span> {s.step}
              </li>
            ))}
          </ul>
        );
      }
      return <Markdown text={String(p.text ?? item.text)} cwd={cwd} />;
    }
    case "subagent":
      return (
        <>
          {d.agent_type ? <div className="dim">type: {String(d.agent_type)}</div> : null}
          {item.text && <Markdown text={item.text} cwd={cwd} />}
        </>
      );
    case "error":
    case "system":
      return <pre>{String(d.message ?? item.text ?? "")}</pre>;
    default:
      return (
        <>
          {item.text && <pre>{item.text}</pre>}
          <JsonBlock value={Object.keys(d).length ? d : undefined} />
        </>
      );
  }
}

export type ItemRowProps = {
  item: Item;
  cursor: boolean;
  expanded: boolean | undefined;
  onToggle: (id: string) => void;
  onCursor: (id: string) => void;
  nested?: boolean;
  showReasoning: boolean;
  /** Above the latest clear or compaction, so no longer in the agent's context. */
  stale?: boolean;
  /** For a user message the session's orchestrator sent rather than the user: the orchestrator's id. */
  fromOrchestrator?: string;
};

/** "From orchestrator Lead", linking to the orchestrator and to its thread with this worker. */
function FromOrchestrator({ orchestratorId, workerId }: { orchestratorId: string; workerId: string }) {
  const title = useStore((st) => st.sessions[orchestratorId]?.title);
  return (
    <div className="message-from">
      <span>From orchestrator</span>
      <button type="button" className="linkish" data-hint data-command="session.select" onClick={(e) => {
        e.stopPropagation();
        useStore.getState().select(orchestratorId);
      }}>{title ?? "(deleted)"}</button>
      <span className="spacer" />
      {title && <button type="button" className="linkish dim" data-hint data-command="orchestrator.thread" onClick={(e) => {
        e.stopPropagation();
        openWorkerThread(orchestratorId, workerId);
      }}>thread ▸</button>}
    </div>
  );
}

/** Links from a worker report to the thread of each worker it covers. */
function ReportThreads({ item }: { item: Item }) {
  const workers = reportedWorkers(item);
  if (workers.length === 0) return null;
  return (
    <span className="report-threads">
      {workers.map((w) => (
        <button key={w.workerId} type="button" className="chip linkish" data-hint data-command="orchestrator.thread" title={`${w.title}: ${w.detail}`} onClick={(e) => {
          e.stopPropagation();
          openWorkerThread(item.session_id, w.workerId);
        }}>{w.title} ▸</button>
      ))}
    </span>
  );
}

export const ItemRow = memo(function ItemRow({ item, cursor, expanded, onToggle, onCursor, nested, showReasoning, stale, fromOrchestrator }: ItemRowProps) {
  const cwd = useStore((s) => s.sessions[item.session_id]?.cwd);
  const dur = fmtDuration(durationMs(item.started_at, item.ended_at));
  const boundary = contextBoundary(item);
  if (boundary) {
    return (
      <div
        className={clsx("item context-boundary", boundary.kind, item.status, cursor && "cursor", stale && "stale")}
        data-item-id={item.id}
        data-hint
        role="separator"
        aria-label={boundary.detail ? `${boundary.title}. ${boundary.detail}` : boundary.title}
        onClick={() => onCursor(item.id)}
      >
        <span className="context-boundary-label">
          {item.status === "in_progress" && <span className="status-ico in_progress" />}
          <span className="context-boundary-title">{boundary.title}</span>
          {boundary.detail && <span className="dim">{boundary.detail}</span>}
        </span>
      </div>
    );
  }
  if (featureCard(item)) return <FeatureCard item={item} cursor={cursor} onCursor={onCursor} />;
  const command = commandOutput(item);
  if (command) {
    return (
      <div className={clsx("item command-output", cursor && "cursor", nested && "nested", stale && "stale")} data-item-id={item.id} data-hint onClick={() => onCursor(item.id)}>
        <div className="command-output-head">
          {command.name && <span className="mono">/{command.name}</span>}
          <span className="dim">{command.name ? "output" : "Command output"}</span>
        </div>
        <div className="command-output-body">
          <Markdown text={item.text} cwd={cwd} />
        </div>
      </div>
    );
  }
  const aura = auraMessage(item);
  if (aura) {
    return (
      <div className={clsx("item aura_message", cursor && "cursor", nested && "nested", stale && "stale")} data-item-id={item.id} data-hint onClick={() => onCursor(item.id)}>
        <div className="aura-message-head">
          <span className="name">{aura.title}</span>
          <span className="dim">from Aura</span>
          <span className="spacer" />
          <ReportThreads item={item} />
        </div>
        {aura.body && <Markdown text={aura.body} cwd={cwd} />}
      </div>
    );
  }
  if (item.kind === "user_message" && fromOrchestrator) {
    return (
      <div className={clsx("item user_message from-orchestrator", cursor && "cursor", nested && "nested", stale && "stale")} data-item-id={item.id} data-hint onClick={() => onCursor(item.id)}>
        <FromOrchestrator orchestratorId={fromOrchestrator} workerId={item.session_id} />
        <MessageImages sessionId={item.session_id} data={item.data} />
        <Markdown text={item.text} cwd={cwd} />
      </div>
    );
  }
  if (item.kind === "user_message") {
    return (
      <div className={clsx("item user_message", isSlashCommand(item.text) && "slash", cursor && "cursor", nested && "nested", stale && "stale")} data-item-id={item.id} data-hint onClick={() => onCursor(item.id)}>
        <MessageImages sessionId={item.session_id} data={item.data} />
        <Markdown text={item.text} cwd={cwd} />
      </div>
    );
  }
  if (item.kind === "agent_message") {
    return (
      <div className={clsx("item agent_message", cursor && "cursor", nested && "nested", stale && "stale")} data-item-id={item.id} data-hint onClick={() => onCursor(item.id)}>
        <Markdown text={item.text} cwd={cwd} />
        {item.status !== "in_progress" && <button className="btn small keep-plan" data-hint onClick={(event) => {
          event.stopPropagation();
          setPlanView(item.session_id, { selectedId: item.id, open: true });
          useStore.getState().setInspectorOpen(true);
        }}>Keep as plan</button>}
        {item.status === "in_progress" && <span className="caret" />}
      </div>
    );
  }
  if (item.kind === "reasoning") {
    if (!showReasoning) return null;
    const open = expanded ?? false;
    return (
      <div className={clsx("item reasoning", cursor && "cursor", nested && "nested", stale && "stale")} data-item-id={item.id} data-hint onClick={() => onCursor(item.id)}>
        <button className="reasoning-toggle" data-hint onClick={(e) => { e.stopPropagation(); onToggle(item.id); }}>
          <span className={clsx("status-ico", item.status)} /> thinking {open ? "▾" : "▸"}
          {!open && <span className="dim"> {truncate(firstLine(item.text) || "…", 140)}</span>}
        </button>
        {open && <div className="item-body">{item.text}</div>}
      </div>
    );
  }
  // cards
  const open = expanded ?? (item.status !== "completed");
  return (
    <div className={clsx("item tool", item.kind, cursor && "cursor", nested && "nested", stale && "stale")} data-item-id={item.id} data-hint onClick={() => onCursor(item.id)}>
      <button className="item-head" data-hint onClick={(e) => { e.stopPropagation(); onToggle(item.id); }}>
        <span className={clsx("status-ico", item.status)} />
        <span className="kind-ico">{kindIcon(item.kind)}</span>
        <span className="name">{itemLabel(item)}</span>
        <span className="spacer" />
        {item.kind === "command_exec" && item.data.exit_code !== undefined && item.data.exit_code !== null && Number(item.data.exit_code) !== 0 && (
          <span className="err-text">exit {String(item.data.exit_code)}</span>
        )}
        <span className="dim">{dur}</span>
        <span className="dim">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="item-body">
          <CardBody item={item} cwd={cwd} />
        </div>
      )}
    </div>
  );
});

export { isCardKind };
