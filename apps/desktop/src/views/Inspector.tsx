import clsx from "clsx";
import type { Session } from "../gen";
import { useStore } from "../state/store";
import { setFocus } from "../commands/core";
import { runCommand } from "../lib/commands";
import { fmtTokens, fmtUsd, relTime, truncate } from "./transcript/format";
import { SessionLinks } from "./SessionLinks";
import { useSessionLinkPreferences } from "../state/sessionLinkPreferences";
import { useGithubRepo } from "../state/githubRepos";
import { PlanSection } from "./PlanSection";
import { acpSessionInfo } from "../lib/acp";
import { WatchSection } from "../features/watches/WatchSection";
import { selectedSessionLinks, sessionLinks } from "./issueLinks";
import { useMemo } from "react";

function KV({ k, v, mono, title }: { k: string; v: React.ReactNode; mono?: boolean; title?: string }) {
  return (
    <>
      <span className="k">{k}</span>
      <span className={clsx("v", mono && "mono")} title={title}>{v}</span>
    </>
  );
}

function Action({ cmd, label, keys, cls }: { cmd: string; label: string; keys?: string; cls?: string }) {
  return (
    <button className={clsx("btn small", cls)} data-command={cmd} onClick={() => void runCommand(cmd)}>
      {label}
      {keys && <kbd>{keys}</kbd>}
    </button>
  );
}

type McpServer = { name?: string; status?: string };
type Init = {
  claude_code_version?: string;
  tools?: string[];
  mcp_servers?: McpServer[];
  plugins?: { name: string }[];
  slash_commands?: string[];
  agents?: string[];
  cwd?: string;
  thread?: Record<string, unknown>;
  cliVersion?: string;
  id?: string;
  [k: string]: unknown;
};
type RateLimits = {
  rate_limit_info?: { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> };
  rateLimits?: { primary?: { usedPercent?: number; resetsAt?: number; windowDurationMins?: number }; secondary?: { usedPercent?: number; resetsAt?: number } | null };
};

function statusDot(s: Session): string {
  return s.status === "running" ? "info pulse" : s.status.startsWith("waiting") ? "warn pulse" : s.status === "error" ? "err" : s.status === "exited" ? "" : "ok";
}

/** An orchestrator's workers, or the orchestrator a worker reports to. */
function OrchestrationSection({ s }: { s: Session }) {
  const sessions = useStore((st) => st.sessions);
  const select = useStore((st) => st.select);
  const workers = useMemo(
    () => Object.values(sessions).filter((w) => w.orchestrator_id === s.id).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [sessions, s.id],
  );
  const lead = s.orchestrator_id ? sessions[s.orchestrator_id] : undefined;
  if (!s.orchestrator && !lead) return null;
  const row = (w: Session) => (
    <button key={w.id} className="list-item" data-command="session.select" onClick={() => select(w.id)} title={w.cwd}>
      <span className={clsx("dot", statusDot(w))} />
      <span className="grow">{w.title}</span>
      <span className={clsx("chip", w.provider)}>{w.agent ?? w.provider}</span>
    </button>
  );
  return (
    <div className="inspector-section">
      <h4>{s.orchestrator ? "Orchestrator" : "Worker"}</h4>
      {s.orchestrator ? (
        <>
          <div className="dim" style={{ marginBottom: 6 }}>Starts and directs the sessions below and hears back when each one stops.</div>
          <div className="list">
            {workers.length === 0 && <span className="dim">No workers yet</span>}
            {workers.map(row)}
          </div>
        </>
      ) : (
        <>
          <div className="dim" style={{ marginBottom: 6 }}>Started by this orchestrator, which hears back when this session stops.</div>
          <div className="list">{lead && row(lead)}</div>
        </>
      )}
    </div>
  );
}

function AcpSection({ s, info }: { s: Session; info: Record<string, unknown> }) {
  const acp = acpSessionInfo(info);
  if (!acp) return null;
  const mode = acp.modes?.find((m) => m.id === acp.current_mode)?.name ?? acp.current_mode;
  return (
    <div className="inspector-section">
      <h4>{acp.agent?.name ?? s.agent ?? "ACP agent"}</h4>
      <div className="kv">
        {acp.agent?.info?.version && <KV k="version" v={acp.agent.info.version} />}
        <KV k="protocol" v="ACP" />
        {mode && <KV k="mode" v={mode} />}
        {!!acp.commands?.length && <KV k="commands" v={acp.commands.length} />}
        {acp.title && <KV k="agent title" v={acp.title} title={acp.title} />}
      </div>
    </div>
  );
}

function ProviderSection({ s, info }: { s: Session; info: Record<string, unknown> }) {
  if (s.provider === "acp") return <AcpSection s={s} info={info} />;
  const init = (info.init ?? {}) as Init;
  const rl = (info.rate_limit ?? info.rate_limits ?? null) as RateLimits | null;
  const bars: { label: string; pct: number; resets?: number }[] = [];
  if (rl?.rate_limit_info?.unifiedWindows) {
    for (const [k, w] of Object.entries(rl.rate_limit_info.unifiedWindows)) bars.push({ label: k.replace("_", " "), pct: Math.round((w.utilization ?? 0) * 100), resets: w.resetsAt });
  }
  if (rl?.rateLimits?.primary) bars.push({ label: `${Math.round((rl.rateLimits.primary.windowDurationMins ?? 0) / 60 / 24)}d window`, pct: rl.rateLimits.primary.usedPercent ?? 0, resets: rl.rateLimits.primary.resetsAt });
  if (rl?.rateLimits?.secondary) bars.push({ label: "secondary", pct: rl.rateLimits.secondary.usedPercent ?? 0, resets: rl.rateLimits.secondary.resetsAt });
  const hasInit = Object.keys(init).length > 0;
  if (!hasInit && bars.length === 0) return null;
  return (
    <div className="inspector-section">
      <h4>{s.provider === "claude" ? "Claude Code" : s.provider === "codex" ? "Codex" : "Provider"}</h4>
      <div className="kv">
        {s.provider === "claude" && hasInit && (
          <>
            {init.claude_code_version && <KV k="version" v={init.claude_code_version} />}
            {init.tools && <KV k="tools" v={init.tools.length} />}
            {init.slash_commands && <KV k="commands" v={init.slash_commands.length} />}
            {init.agents && <KV k="agents" v={init.agents.length} />}
            {init.plugins && init.plugins.length > 0 && <KV k="plugins" v={init.plugins.map((p) => p.name).join(", ")} title={init.plugins.map((p) => p.name).join(", ")} />}
          </>
        )}
        {s.provider === "codex" && hasInit && (
          <>
            {typeof init.cliVersion === "string" && <KV k="version" v={init.cliVersion} />}
            {typeof init.id === "string" && <KV k="thread" v={init.id} mono title={init.id} />}
            {typeof init.modelProvider === "string" && <KV k="provider" v={init.modelProvider} />}
            {typeof init.source === "string" && <KV k="source" v={init.source} />}
          </>
        )}
      </div>
      {s.provider === "claude" && init.mcp_servers && init.mcp_servers.length > 0 && (
        <div className="mcp-list">
          {init.mcp_servers.map((m, i) => (
            <div key={i} className="mcp-row">
              <span className={clsx("dot", m.status === "connected" ? "ok" : m.status === "failed" ? "err" : "warn")} />
              <span className="grow">{m.name}</span>
              <span className="dim">{m.status}</span>
            </div>
          ))}
        </div>
      )}
      {bars.map((b, i) => (
        <div key={i} className="rl">
          <div className="rl-head">
            <span>{b.label}</span>
            <span className="dim">{b.pct}%{b.resets ? ` · resets ${new Date(b.resets * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</span>
          </div>
          <div className="meter"><div style={{ width: `${Math.min(100, b.pct)}%`, background: b.pct > 85 ? "var(--err)" : b.pct > 60 ? "var(--warn)" : "var(--accent)" }} /></div>
        </div>
      ))}
    </div>
  );
}

export function Inspector({ sessionId }: { sessionId: string | null }) {
  const linkPreferences = useSessionLinkPreferences(sessionId);
  const s = useStore((st) => (sessionId ? st.sessions[sessionId] : null));
  const t = useStore((st) => (sessionId ? st.transcripts[sessionId] : null));
  const repo = useGithubRepo(s?.cwd);
  const focus = useStore((st) => st.focus);
  const caps = useStore((st) => st.providers.find((p) => p.kind === s?.provider)?.capabilities);
  const openDialog = useStore((st) => st.openDialog);
  const setCursorItem = useStore((st) => st.setCursorItem);

  const prs = useMemo(() => {
    if (!s || !linkPreferences) return [];
    return selectedSessionLinks(sessionLinks(t?.items ?? {}, s.title, repo), linkPreferences.preferences)
      .filter((l) => l.kind === "PR")
      .map((l) => ({ repo: l.repo, number: Number(l.number) }));
  }, [s, t?.items, repo, linkPreferences]);

  const jump = (key: string) => {
    setCursorItem(key);
    setFocus("main");
  };

  return (
    // Only mark the region: focus events bubble up from every control inside, and moving focus here would pull it off the control just focused.
    <div className={clsx("region inspector", focus === "inspector" && "focused")} data-region="inspector" tabIndex={0} onFocus={() => useStore.getState().setFocus("inspector")}>
      {!s && <div className="empty" style={{ padding: 20 }}><span className="dim">No session selected</span></div>}
      {s && (
        <>
          <SessionLinks items={t?.items ?? {}} title={s.title} repo={repo} preferences={linkPreferences?.preferences}
            loading={!linkPreferences} error={linkPreferences?.error}
            onEdit={() => openDialog({ kind: "session-links", sessionId: s.id })} />
          {prs.map((pr) => <WatchSection key={`${pr.repo}#${pr.number}`} target={pr} showTarget={prs.length > 1} />)}
          <PlanSection sessionId={s.id} />
          <OrchestrationSection s={s} />
          <div className="inspector-section">
            <h4>Session</h4>
            <div className="kv">
              <KV k="title" v={s.title} title={s.title} />
              <KV k="provider" v={<span className={clsx("chip", s.provider)}>{s.agent ?? s.provider}</span>} />
              <KV k="status" v={<><span className={clsx("dot", statusDot(s))} /> {s.status}{s.pending_count ? ` (${s.pending_count} pending)` : ""}</>} />
              <KV k="mode" v={s.mode} />
              <KV k="cwd" v={s.cwd} mono title={s.cwd} />
              {s.worktree && <KV k="worktree" v={`⎇ ${s.worktree.branch}`} title={s.worktree.path} />}
              {s.command && s.mode === "terminal" && <KV k="command" v={s.command.join(" ")} mono title={s.command.join(" ")} />}
              <KV
                k="native id"
                v={
                  s.native_id ? (
                    <span className="with-btn">
                      <span className="mono" title={s.native_id}>{truncate(s.native_id, 18)}</span>
                      <button className="btn small" data-command="session.copy-id" title="copy" onClick={() => void navigator.clipboard.writeText(s.native_id!).then(() => useStore.getState().toast("Native id copied"))}>⧉</button>
                    </span>
                  ) : (
                    <span className="dim">not yet</span>
                  )
                }
              />
              <KV k="created" v={relTime(s.created_at)} title={s.created_at} />
              <KV k="activity" v={relTime(s.last_activity)} title={s.last_activity} />
              {s.last_error && <KV k="error" v={<span className="err-text">{s.last_error}</span>} title={s.last_error} />}
            </div>
          </div>
          {s.mode === "structured" && caps && (caps.models || caps.effort || caps.permission_modes.length > 0 || caps.sandbox_modes.length > 0) && (
            <div className="inspector-section">
              <h4>Model</h4>
              <div className="kv">
                {caps.models && <KV k="model" v={<button className="linkish" data-command="session.pick-model" onClick={() => openDialog({ kind: "models", sessionId: s.id })}>{s.model ?? "default"} ›</button>} />}
                {caps.effort && <KV k="effort" v={<button className="linkish" data-command="session.pick-effort" onClick={() => openDialog({ kind: "effort", sessionId: s.id })}>{s.effort ?? "default"} ›</button>} />}
                {caps.permission_modes.length > 0 && <KV k="permissions" v={<button className="linkish" data-command="session.pick-permission" onClick={() => openDialog({ kind: "permission", sessionId: s.id })}>{s.permission_mode ?? "default"} ›</button>} />}
                {caps.sandbox_modes.length > 0 && <KV k="sandbox" v={<button className="linkish" data-command="session.pick-sandbox" onClick={() => openDialog({ kind: "sandbox", sessionId: s.id })}>{s.sandbox_mode ?? "default"} ›</button>} />}
              </div>
            </div>
          )}
          {s.mode === "structured" && (
            <div className="inspector-section">
              <h4>Usage</h4>
              <div className="kv">
                <KV k="input" v={fmtTokens(s.usage.input_tokens)} />
                <KV k="output" v={fmtTokens(s.usage.output_tokens)} />
                <KV k="cached" v={fmtTokens(s.usage.cached_input_tokens)} />
                {s.usage.total_cost_usd !== null && <KV k="cost" v={fmtUsd(s.usage.total_cost_usd)} />}
              </div>
              {s.usage.context_window ? (
                <>
                  <div className="dim" style={{ marginTop: 6 }}>
                    context {fmtTokens(s.usage.context_used ?? 0)} / {fmtTokens(s.usage.context_window)}
                  </div>
                  <div className="meter"><div style={{ width: `${Math.min(100, Math.round(((s.usage.context_used ?? 0) / s.usage.context_window) * 100))}%` }} /></div>
                </>
              ) : null}
            </div>
          )}
          {t && (Object.keys(t.approvals).length > 0 || Object.keys(t.inputs).length > 0) && (
            <div className="inspector-section">
              <h4>Pending</h4>
              <div className="list">
                {Object.values(t.approvals).map((a) => (
                  <button key={a.id} className="list-item" data-command="inspector.jump" onClick={() => jump(`approval:${a.id}`)}>
                    <span className="dot warn pulse" />
                    <span className="grow">{a.title}</span>
                    <span className="dim">{a.kind}</span>
                  </button>
                ))}
                {Object.values(t.inputs).map((r) => (
                  <button key={r.id} className="list-item" data-command="inspector.jump" onClick={() => jump(`input:${r.id}`)}>
                    <span className="dot info pulse" />
                    <span className="grow">{r.questions[0]?.header ?? r.questions[0]?.question ?? "question"}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {t && <ProviderSection s={s} info={t.providerInfo} />}
          {t && t.notices.length > 0 && (
            <div className="inspector-section">
              <h4 className="section-head">Notices <Action cmd="session.clear-notices" label="Clear" /></h4>
              {t.notices.slice(-5).reverse().map((n) => (
                <div key={n.id} className={clsx("notice", n.level)}>
                  <span className={clsx("dot", n.level === "error" ? "err" : n.level === "warn" ? "warn" : "info")} /> {n.message}
                </div>
              ))}
            </div>
          )}
          <div className="inspector-section">
            <h4>Actions</h4>
            <div className="actions">
              {caps?.fork && s.native_id && <Action cmd="session.fork" label="Fork" />}
              <Action cmd="session.rename" label="Rename" />
              {s.provider !== "terminal" && <Action cmd="session.system-prompt" label="Prompt" />}
              {s.provider !== "terminal" && <Action cmd="session.toggle-orchestrator" label={s.orchestrator ? "Stop orchestrating" : "Orchestrate"} />}
              {caps?.terminal_mode && s.provider !== "terminal" && <Action cmd="session.toggle-mode" label={s.mode === "terminal" ? "Structured" : "Terminal"} />}
              {s.mode === "terminal" && s.status === "exited" && <Action cmd="session.restart" label="Restart" />}
              <Action cmd="git.diff" label="Diff" />
              <Action cmd="session.open-window" label="Window" />
              <Action cmd="session.stop" label="Stop" />
              <Action cmd="session.archive" label={s.archived ? "Unarchive" : "Archive"} />
              <Action cmd="session.delete" label="Delete" cls="danger" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
