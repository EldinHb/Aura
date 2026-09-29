import { useEffect, useMemo, useState } from "react";
import { Modal } from "../../components/Modal";
import { useStore } from "../../state/store";
import { rpc } from "../reviews/state";
import { reviewVerb, useWatches, type Candidates, type WatchTarget } from "./state";

type Person = { login: string; requested: boolean; last?: string };

/** Requested reviewers first, then people who reviewed before, then everyone else who can be requested. */
export function people(c: Candidates): Person[] {
  const out: Person[] = [];
  const add = (login: string) => {
    let p = out.find((x) => x.login.toLowerCase() === login.toLowerCase());
    if (!p) out.push(p = { login, requested: false });
    return p;
  };
  c.requested.forEach((login) => { add(login).requested = true; });
  c.reviewed.forEach((r) => { add(r.login).last = r.state; });
  [...c.candidates].sort((a, b) => a.localeCompare(b)).forEach(add);
  return out;
}

export function WatchDialog({ target }: { target: WatchTarget }) {
  const close = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  const [data, setData] = useState<Candidates | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);

  const { repo, number } = target;
  useEffect(() => {
    let active = true;
    rpc<Candidates>("watches.candidates", { repo, number }).then((c) => {
      if (!active) return;
      setData(c);
      setPicked(c.requested);
    }).catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [repo, number]);

  const all = useMemo(() => (data ? people(data) : []), [data]);
  const query = filter.trim().toLowerCase();
  const shown = all.filter((p) => !query || p.login.toLowerCase().includes(query)).slice(0, 60);
  const isPicked = (login: string) => picked.some((x) => x.toLowerCase() === login.toLowerCase());
  const toggle = (login: string) => setPicked((cur) => isPicked(login) ? cur.filter((x) => x.toLowerCase() !== login.toLowerCase()) : [...cur, login]);
  // Bots review on their own schedule and cannot be requested here; they are only watched.
  const requestable = (login: string) => !login.endsWith("[bot]") && !all.find((p) => p.login.toLowerCase() === login.toLowerCase())?.requested;
  const request = picked.filter(requestable);

  const start = async () => {
    if (!data || saving || data.state !== "open") return;
    setSaving(true);
    setError("");
    try {
      await rpc("watches.start", { repo, number, reviewers: picked, request });
      await useWatches.getState().refresh();
      toast(`Watching ${target.repo}#${target.number} for reviews`);
      close();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  const summary = picked.length === 0
    ? "No reviewer selected: the watch ends at the first review by anyone except the author."
    : `Waiting for ${picked.join(", ")}.${request.length ? ` Aura will request a review from ${request.join(", ")}.` : ""}`;

  return (
    <Modal title={`Watch ${target.repo}#${target.number} for reviews`} width={560} onClose={saving ? () => {} : close} onSubmit={() => void start()}
      footer={<>
        <button type="button" className="btn" data-command="dialog.cancel" disabled={saving} onClick={close}>Cancel</button>
        <button type="button" className="btn primary" data-command="dialog.confirm" disabled={!data || saving || data.state !== "open"} onClick={() => void start()}>
          {saving ? "Starting…" : data?.watch?.status === "watching" ? "Replace watch" : request.length ? "Request & watch" : "Watch"} <kbd>⌘↩</kbd>
        </button>
      </>}>
      {!data && !error && <p className="dim" role="status">Loading reviewers…</p>}
      {data && <>
        <p className="dim">{data.title} · by {data.author}{data.state !== "open" ? ` · ${data.state}` : ""}</p>
        <p className="dim">Aura checks GitHub every minute and tells you when a selected reviewer approves, requests changes or leaves a comment-only review. Select someone who isn't requested yet to request their review.</p>
        {data.teams.length > 0 && <p className="dim">Team review requested from {data.teams.join(", ")}. To catch a review from any team member, leave everyone unselected.</p>}
        {data.watch?.status === "watching" && <p className="dim">Already watching{data.watch.reviewers.length ? ` for ${data.watch.reviewers.join(", ")}` : ""}. Starting again replaces that watch.</p>}
        <div className="field">
          <label htmlFor="watch-filter">Find reviewers</label>
          <input id="watch-filter" type="text" data-autofocus placeholder="Filter people…" value={filter} onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && query && shown[0]) { e.preventDefault(); toggle(shown[0].login); setFilter(""); }
            }} />
        </div>
        <div className="watch-people" role="group" aria-label="Reviewers">
          {shown.map((p) => (
            <label key={p.login} className="watch-person">
              <input type="checkbox" checked={isPicked(p.login)} onChange={() => toggle(p.login)} />
              <span className="grow">{p.login}</span>
              {p.requested && <span className="chip">requested</span>}
              {p.last && <span className="chip">{reviewVerb(p.last)}</span>}
              {requestable(p.login) && isPicked(p.login) && <span className="chip accent">will request</span>}
            </label>
          ))}
          {shown.length === 0 && <p className="dim">{all.length ? "Nobody matches." : "No reviewers found for this repository."}</p>}
        </div>
        {data.candidate_error && <p className="dim">Could not list everyone who can review: {data.candidate_error}</p>}
        <p className="dim" role="status">{summary}</p>
      </>}
      {error && <p role="alert" className="err-text">{error}</p>}
    </Modal>
  );
}
