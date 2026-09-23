import { useEffect, useState } from "react";
import type { ModelInfo, PreReview, PullRequest, ReviewConfig } from "../../gen";
import { Modal } from "../../components/Modal";
import { useStore } from "../../state/store";
import { openPull, rpc, useReviews } from "./state";

export function ReviewSettings({ pull, config: previous }: { pull: PullRequest; config?: ReviewConfig }) {
  const providers = useStore((s) => s.providers).filter((p) => p.available && p.kind !== "terminal");
  const client = useStore((s) => s.client);
  const [config, setConfig] = useState<ReviewConfig>(() => previous ?? useReviews.getState().inbox?.defaults ?? { provider: providers[0]?.kind ?? "codex", model: null, effort: null, prompt_mode: "default", prompt: "" });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const close = useStore((s) => s.closeDialog);
  useEffect(() => { rpc<{ instructions: string }>("reviews.defaults").then((r) => setInstructions(r.instructions)).catch((e) => setError(String(e))); }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setModels([]);
    if (config.provider !== "claude" && config.provider !== "codex") return;
    client?.models(config.provider).then((models) => { if (active) { setModels(models); setLoading(false); } }).catch((e) => { if (active) { setError(String(e)); setLoading(false); } });
    return () => { active = false; };
  }, [client, config.provider]);
  const model = models.find((m) => m.id === config.model) ?? models.find((m) => m.is_default);
  const effective = config.prompt_mode === "replace" ? config.prompt : instructions + (config.prompt_mode === "append" ? `\n\n${config.prompt}` : "");
  const start = async () => {
    setBusy(true); setError(null);
    try { const review = await rpc<PreReview>("reviews.start", { repo: pull.repo, number: pull.number, account: pull.account, config }); close(); openPull(pull, review.id); void useReviews.getState().refresh(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const valid = providers.some((p) => p.kind === config.provider) && !loading && !!instructions && (config.prompt_mode !== "replace" || !!config.prompt.trim()) && (!config.effort || model?.efforts.includes(config.effort));
  return <Modal className="pr-modal" title={`Pre-review ${pull.repo}#${pull.number}`} width={720} onClose={() => { if (!busy) close(); }} footer={<><button className="btn" data-hint disabled={busy} onClick={close}>Cancel</button><button className="btn primary" data-hint disabled={busy || !valid} onClick={() => void start()}>{busy ? "Starting…" : "Start pre-review"}</button></>}>
    <div className="pr-form">
      {error && <p className="pr-error" role="alert">{error}</p>}
      {!providers.length && <p className="pr-error">Install Claude Code or Codex to run a pre-review.</p>}
      <div className="pr-form-row"><label>Provider<select aria-label="Provider" value={config.provider} onChange={(e) => setConfig({ ...config, provider: e.target.value, model: null, effort: null })}>{providers.map((p) => <option key={p.kind} value={p.kind}>{p.display_name}</option>)}</select></label>
        <label>Model<input aria-label="Model" list="review-models" value={config.model ?? ""} placeholder="Provider default" onChange={(e) => setConfig({ ...config, model: e.target.value || null, effort: null })} /><datalist id="review-models">{models.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</datalist></label>
        <label>Effort<select aria-label="Effort" value={config.effort ?? ""} onChange={(e) => setConfig({ ...config, effort: e.target.value || null })}><option value="">Provider default</option>{model?.efforts.map((e) => <option key={e}>{e}</option>)}</select></label></div>
      <label>Review instructions<select aria-label="Review instructions" value={config.prompt_mode} onChange={(e) => setConfig({ ...config, prompt_mode: e.target.value })}><option value="default">Use default</option><option value="append">Add to default</option><option value="replace">Replace default</option></select></label>
      {config.prompt_mode !== "default" && <label>{config.prompt_mode === "append" ? "Additional instructions" : "Replacement instructions"}<textarea rows={7} value={config.prompt} onChange={(e) => setConfig({ ...config, prompt: e.target.value })} /></label>}
      <details><summary>Effective prompt</summary><pre className="pr-prompt">{effective}</pre></details>
      <p className="pr-muted">PR context, the diff, the result schema, and read-only restrictions are always included. Settings apply only to this review. Nothing starts until you confirm.</p>
    </div>
  </Modal>;
}
