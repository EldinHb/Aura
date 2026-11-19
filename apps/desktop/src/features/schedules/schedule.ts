/**
 * Scheduled tasks in words and in the editor's terms. The daemon works out
 * when a task runs (in the user's time zone, through clock changes); the app
 * only describes schedules and edits them.
 */
import type { Autonomy, MissedRuns, RunAs, RunResult, RunTrigger, Schedule, ScheduledTask, ScheduledTaskInput, Weekday } from "../../gen";

export const WEEKDAYS: { day: Weekday; short: string; long: string }[] = [
  { day: "mon", short: "Mon", long: "Monday" }, { day: "tue", short: "Tue", long: "Tuesday" },
  { day: "wed", short: "Wed", long: "Wednesday" }, { day: "thu", short: "Thu", long: "Thursday" },
  { day: "fri", short: "Fri", long: "Friday" }, { day: "sat", short: "Sat", long: "Saturday" },
  { day: "sun", short: "Sun", long: "Sunday" },
];

export type Unit = Schedule["unit"];
export const UNITS: { unit: Unit; one: string; many: string; max: number }[] = [
  { unit: "minutes", one: "minute", many: "minutes", max: 7 * 24 * 60 },
  { unit: "hours", one: "hour", many: "hours", max: 365 * 24 },
  { unit: "days", one: "day", many: "days", max: 365 },
  { unit: "weeks", one: "week", many: "weeks", max: 52 },
  { unit: "months", one: "month", many: "months", max: 12 },
];

const ordinal = (n: number) => {
  const tens = n % 100, ones = n % 10;
  return `${n}${tens >= 11 && tens <= 13 ? "th" : ones === 1 ? "st" : ones === 2 ? "nd" : ones === 3 ? "rd" : "th"}`;
};

/** "every 2 weeks on Monday and Friday at 09:00", as the daemon says it. */
export function describeSchedule(s: Schedule): string {
  const u = UNITS.find((x) => x.unit === s.unit)!;
  const every = s.every === 1 ? `every ${u.one}` : `every ${s.every} ${u.many}`;
  switch (s.unit) {
    case "minutes": case "hours": return every;
    case "days": return `${every} at ${s.at}`;
    case "weeks": {
      const names = WEEKDAYS.filter((w) => s.weekdays.includes(w.day)).map((w) => w.long);
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";
      return `${every} on ${list} at ${s.at}`;
    }
    case "months": return `${every} on the ${ordinal(s.day)}${s.day > 28 ? " (the last day in shorter months)" : ""} at ${s.at}`;
  }
}

/** The editor's view of a schedule: every field of every unit, so switching units keeps what was typed. */
export type ScheduleDraft = { unit: Unit; every: number; at: string; weekdays: Weekday[]; day: number };

export function draftOf(s: Schedule): ScheduleDraft {
  return {
    unit: s.unit, every: s.every,
    at: "at" in s ? s.at : "09:00",
    weekdays: s.unit === "weeks" ? s.weekdays : ["mon"],
    day: s.unit === "months" ? s.day : 1,
  };
}

export function scheduleOf(d: ScheduleDraft): Schedule {
  switch (d.unit) {
    case "minutes": case "hours": return { unit: d.unit, every: d.every };
    case "days": return { unit: "days", every: d.every, at: d.at };
    case "weeks": return { unit: "weeks", every: d.every, weekdays: WEEKDAYS.map((w) => w.day).filter((w) => d.weekdays.includes(w)), at: d.at };
    case "months": return { unit: "months", every: d.every, day: d.day, at: d.at };
  }
}

/** Why the schedule cannot be saved, or null. */
export function scheduleError(d: ScheduleDraft): string | null {
  const u = UNITS.find((x) => x.unit === d.unit)!;
  if (!Number.isInteger(d.every) || d.every < 1 || d.every > u.max) return `Every 1 to ${u.max} ${u.many}`;
  if (d.unit !== "minutes" && d.unit !== "hours" && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(d.at)) return "Pick a time of day";
  if (d.unit === "weeks" && d.weekdays.length === 0) return "Pick at least one day";
  if (d.unit === "months" && !(d.day >= 1 && d.day <= 31)) return "Pick a day from 1 to 31";
  return null;
}

/** What a run's session is, as the new-session dialog offers it. */
export const RUN_AS: { value: RunAs; label: string; help: string }[] = [
  { value: "session", label: "Session", help: "A regular session with the prompt." },
  { value: "orchestrator", label: "Orchestrator", help: "Starts and directs worker sessions of any agent, in any folder or repository; they show up under it." },
  { value: "feature_owner", label: "Feature owner", help: "An orchestrator that owns one feature end to end with a team of specialists, and ends with a delivery report." },
];

/** What the task editor holds. `no_folder`: an orchestrator or feature owner without a folder of its own. */
export type TaskDraft = {
  name: string; prompt: string; agent: string; model: string; effort: string;
  permission_mode: string; sandbox_mode: string; cwd: string; no_folder: boolean; worktree: boolean; branch_prefix: string;
  run_as: RunAs; feature_goal: string; autonomy: Autonomy | null;
  group: string; enabled: boolean; schedule: ScheduleDraft; missed: MissedRuns; allow_overlap: boolean;
};

/** Whether the draft's session orchestrates, and so may go without a folder. */
export const orchestrates = (d: TaskDraft) => d.run_as !== "session";
/** The draft has no folder: an orchestrator that was not given one. */
export const folderless = (d: TaskDraft) => orchestrates(d) && d.no_folder;

export function newDraft(agent: string, cwd: string): TaskDraft {
  return {
    name: "", prompt: "", agent, model: "", effort: "", permission_mode: "", sandbox_mode: "", cwd, no_folder: true,
    worktree: false, branch_prefix: "", run_as: "session", feature_goal: "", autonomy: null, group: "", enabled: true,
    schedule: { unit: "days", every: 1, at: "09:00", weekdays: ["mon"], day: 1 }, missed: "run_once", allow_overlap: false,
  };
}

export function draftOfTask(t: ScheduledTask): TaskDraft {
  return {
    name: t.name, prompt: t.prompt, agent: t.agent, model: t.model ?? "", effort: t.effort ?? "",
    permission_mode: t.permission_mode ?? "", sandbox_mode: t.sandbox_mode ?? "", cwd: t.cwd, no_folder: !t.cwd,
    worktree: t.worktree, branch_prefix: t.branch_prefix ?? "", run_as: t.run_as ?? "session", feature_goal: t.feature_goal ?? "",
    autonomy: t.autonomy ?? null, group: t.group ?? "", enabled: t.enabled,
    schedule: draftOf(t.schedule), missed: t.missed, allow_overlap: t.allow_overlap,
  };
}

/** Everything in the draft, for the daemon; empty texts clear optional fields. */
export function inputOf(d: TaskDraft): ScheduledTaskInput {
  const owner = d.run_as === "feature_owner";
  return {
    name: d.name.trim(), prompt: d.prompt, agent: d.agent, model: d.model, effort: d.effort,
    permission_mode: d.permission_mode, sandbox_mode: d.sandbox_mode,
    // An empty folder gives an orchestrator a directory of its own, as in the new-session dialog.
    cwd: folderless(d) ? "" : d.cwd.trim(), worktree: !folderless(d) && d.worktree,
    run_as: d.run_as, feature_goal: owner ? d.feature_goal.trim() : "", autonomy: owner ? d.autonomy : null,
    branch_prefix: d.branch_prefix.trim(), group: d.group.trim(), enabled: d.enabled,
    schedule: scheduleOf(d.schedule), missed: d.missed, allow_overlap: d.allow_overlap,
  };
}

/** Why the draft cannot be saved, or null. The daemon checks the rest (agent, folder). */
export function draftError(d: TaskDraft): string | null {
  if (!d.name.trim()) return "Give the task a name";
  if (!d.prompt.trim()) return "Write the prompt each run starts with";
  if (!d.agent) return "Pick an agent";
  if (!folderless(d) && !d.cwd.trim()) return "Pick the folder the sessions work in";
  if (/\s/.test(d.branch_prefix.trim())) return "A branch name has no spaces";
  return scheduleError(d.schedule);
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "today 09:00", "tomorrow 09:00", "Mon 23 Nov 09:00", in the user's time zone. */
export function formatWhen(iso: string, now = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const time = t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(t, now)) return `today ${time}`;
  if (sameDay(t, tomorrow)) return `tomorrow ${time}`;
  if (sameDay(t, yesterday)) return `yesterday ${time}`;
  const date = t.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(t.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return `${date} ${time}`;
}

export const RESULT_LABEL: Record<RunResult, string> = { started: "Started", skipped: "Skipped", failed: "Failed" };
export const TRIGGER_LABEL: Record<RunTrigger, string> = { schedule: "on schedule", catch_up: "made up for missed runs", manual: "run now" };

/** The next run of the enabled tasks, soonest first. */
export function nextRuns(tasks: ScheduledTask[]): ScheduledTask[] {
  return tasks.filter((t) => t.enabled && t.next_run).sort((a, b) => a.next_run!.localeCompare(b.next_run!));
}
