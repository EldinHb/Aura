import clsx from "clsx";
import { formatWhen, nextRuns } from "./schedule";
import { openSchedules, useSchedules } from "./state";

/** One line under the sessions: how many tasks there are and which runs next. Opens the scheduled tasks. */
export function ScheduleSidebar() {
  const { tasks, loaded } = useSchedules();
  if (!loaded) return null;
  const next = nextRuns(tasks)[0];
  const failed = tasks.filter((t) => t.last_run?.result === "failed").length;
  return (
    <button type="button" className="schedule-sidebar" data-command="schedules.open" onClick={() => openSchedules(next?.id)} title="Scheduled tasks: start a session with a prompt on a schedule">
      <span className="section-title">Scheduled tasks</span>
      {tasks.length > 0 && <span className="chip">{tasks.length}</span>}
      {failed > 0 && <span className={clsx("chip", "run-result", "failed")} title="Tasks whose last run failed">{failed} failed</span>}
      <span className="grow dim schedule-sidebar-next">
        {next?.next_run ? `next ${formatWhen(next.next_run)} · ${next.name}` : tasks.length ? "none enabled" : "none yet"}
      </span>
    </button>
  );
}
