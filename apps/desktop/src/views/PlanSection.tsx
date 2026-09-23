import { useMemo } from "react";
import clsx from "clsx";
import { useStore } from "../state/store";
import { setPlanView, usePlanViews } from "../state/planView";
import { sessionPlans } from "./sessionPlans";
import { Markdown } from "./transcript/MarkdownView";

export function PlanSection({ sessionId }: { sessionId: string }) {
  const transcript = useStore((state) => state.transcripts[sessionId]);
  const view = usePlanViews((state) => state.views[sessionId]);
  const plans = useMemo(() => sessionPlans(transcript, view?.selectedId), [transcript, view?.selectedId]);
  const plan = plans.find((entry) => entry.id === view?.selectedId) ?? plans.at(-1);
  const open = view?.open ?? true;
  if (!plan) return null;
  return (
    <div className="inspector-section plan-section">
      <button className="plan-toggle" data-command="session.plan.toggle" aria-expanded={open} onClick={() => setPlanView(sessionId, { open: !open })}>
        <span>Plan</span><span>{open ? "Hide ▾" : "Show ▸"}</span>
      </button>
      {open && <>
        {plans.length > 1 && <select aria-label="Displayed plan" value={view?.selectedId && plans.some((entry) => entry.id === view.selectedId) ? view.selectedId : "latest"}
          onChange={(event) => setPlanView(sessionId, { selectedId: event.target.value === "latest" ? undefined : event.target.value })}>
          <option value="latest">Latest plan</option>
          {plans.map((entry, index) => <option key={entry.id} value={entry.id}>{index + 1}. {entry.title}</option>)}
        </select>}
        <div className="plan-content">
          {plan.text && <Markdown text={plan.text} />}
          {plan.steps.length > 0 && <ul className="plan">{plan.steps.map((step, index) => <li key={index} className={clsx("plan-step", step.status)}>
            <span className="plan-box" aria-label={step.status.replaceAll("_", " ")}>{step.status === "completed" ? "☑" : /in_progress|inProgress/.test(step.status) ? "◐" : "☐"}</span> {step.step}
          </li>)}</ul>}
        </div>
      </>}
    </div>
  );
}
