//! An orchestrator's tools for the user's scheduled tasks: prompts Aura starts
//! a new session with on a schedule. Each calls the daemon's
//! `orchestrator.schedules.*`, which shares its code with the app's
//! scheduled-tasks window. Permission and sandbox modes stay the user's.

use anyhow::Result;
use aura_core::{agent_line, RunResult, RunTrigger, ScheduledRun, ScheduledTask};
use chrono::{DateTime, Local, Utc};
use serde_json::{json, Value};

/// Tool names, in the order `tools/list` shows them.
pub const NAMES: &[&str] = &[
    "list_scheduled_tasks",
    "read_scheduled_task_history",
    "create_scheduled_task",
    "update_scheduled_task",
    "delete_scheduled_task",
    "set_scheduled_task_enabled",
    "run_scheduled_task",
];

/// The daemon method a tool calls, and its parameters: the tool's own
/// arguments, as given, for the orchestrator `o`.
pub fn request(tool: &str, o: &str, a: &Value) -> Option<(&'static str, Value)> {
    let method = match tool {
        "list_scheduled_tasks" => "orchestrator.schedules.list",
        "read_scheduled_task_history" => "orchestrator.schedules.get",
        "create_scheduled_task" => "orchestrator.schedules.create",
        "update_scheduled_task" => "orchestrator.schedules.update",
        "delete_scheduled_task" => "orchestrator.schedules.delete",
        "set_scheduled_task_enabled" => "orchestrator.schedules.set_enabled",
        "run_scheduled_task" => "orchestrator.schedules.run",
        _ => return None,
    };
    let mut p = match a {
        Value::Object(m) => Value::Object(m.clone()),
        _ => json!({}),
    };
    p["orchestrator"] = json!(o);
    Some((method, p))
}

/// What the tool says back, from the daemon's reply.
pub fn reply(tool: &str, v: Value) -> Result<String> {
    Ok(match tool {
        "list_scheduled_tasks" => {
            let tasks: Vec<ScheduledTask> = serde_json::from_value(v)?;
            if tasks.is_empty() {
                "The user has no scheduled tasks. Create one with create_scheduled_task.".into()
            } else {
                let mut out = format!(
                    "Scheduled tasks (times in the user's time zone, now {}):\n",
                    when(Utc::now())
                );
                for t in &tasks {
                    out.push_str(&format!("- {}\n", task_line(t)));
                }
                out
            }
        }
        "read_scheduled_task_history" => {
            let task: ScheduledTask = serde_json::from_value(v["task"].clone())?;
            let runs: Vec<ScheduledRun> = serde_json::from_value(v["runs"].clone())?;
            let mut out = describe_task(&task);
            if runs.is_empty() {
                out.push_str("\nIt has not run yet.");
            } else {
                out.push_str("\nHistory, latest first:\n");
                for r in &runs {
                    out.push_str(&format!("- {}\n", run_line(r)));
                }
            }
            out
        }
        "create_scheduled_task" => {
            let t: ScheduledTask = serde_json::from_value(v)?;
            format!(
                "Created scheduled task `{}`.\n\n{}",
                t.id,
                describe_task(&t)
            )
        }
        "update_scheduled_task" | "set_scheduled_task_enabled" => {
            describe_task(&serde_json::from_value(v)?)
        }
        "delete_scheduled_task" => {
            let t: ScheduledTask = serde_json::from_value(v)?;
            format!(
                "Deleted scheduled task \"{}\" (`{}`) and its history. The sessions it started are kept.",
                t.name, t.id
            )
        }
        "run_scheduled_task" => {
            let r: ScheduledRun = serde_json::from_value(v)?;
            match r.result {
                RunResult::Started => format!(
                    "Started session \"{}\" (`{}`). It is a normal session of the user's, not your worker: you get no report when it stops.",
                    r.session_title.as_deref().unwrap_or_default(),
                    r.session_id.as_deref().unwrap_or_default()
                ),
                _ => run_line(&r),
            }
        }
        _ => v.to_string(),
    })
}

/// A time as the user's clock shows it.
fn when(t: DateTime<Utc>) -> String {
    t.with_timezone(&Local)
        .format("%a %Y-%m-%d %H:%M %:z")
        .to_string()
}

fn task_line(t: &ScheduledTask) -> String {
    let state = if !t.enabled {
        "disabled".to_string()
    } else {
        match t.next_run {
            Some(n) => format!("next {}", when(n)),
            None => "no next run".into(),
        }
    };
    let last = t
        .last_run
        .as_ref()
        .map(|r| format!("; last: {}", run_line(r)))
        .unwrap_or_default();
    format!(
        "`{}` \"{}\": {} ({state}){last}",
        t.id,
        t.name,
        t.schedule.describe()
    )
}

pub fn describe_task(t: &ScheduledTask) -> String {
    let mut out = format!("Scheduled task \"{}\" (`{}`)\n", t.name, t.id);
    out.push_str(&format!(
        "- {}: {}\n",
        if t.enabled { "enabled" } else { "disabled" },
        t.schedule.describe()
    ));
    if let Some(n) = t.next_run {
        out.push_str(&format!("- next run: {}\n", when(n)));
    }
    out.push_str(&format!(
        "- starts {} in {}{}\n",
        agent_line(&t.agent, t.model.as_deref(), t.effort.as_deref()),
        t.cwd,
        if t.worktree {
            format!(
                ", each run in a new worktree on a branch starting `{}-`",
                aura_core::schedules::branch_prefix(t)
            )
        } else {
            String::new()
        }
    ));
    if t.permission_mode.is_some() || t.sandbox_mode.is_some() {
        out.push_str(&format!(
            "- permission mode {}, sandbox {} (the user's to change)\n",
            t.permission_mode.as_deref().unwrap_or("default"),
            t.sandbox_mode.as_deref().unwrap_or("default")
        ));
    }
    if let Some(g) = &t.group {
        out.push_str(&format!("- in sidebar group \"{g}\"\n"));
    }
    out.push_str(&format!(
        "- missed runs (Aura not running, computer asleep): {}\n",
        match t.missed {
            aura_core::MissedRuns::RunOnce => "run once when back",
            aura_core::MissedRuns::Skip => "skipped",
        }
    ));
    out.push_str(&format!(
        "- while the previous run still works: {}\n",
        if t.allow_overlap {
            "start another"
        } else {
            "skip the run"
        }
    ));
    if let Some(by) = &t.created_by {
        out.push_str(&format!(
            "- created by orchestrator \"{}\"\n",
            by.orchestrator_title
        ));
    }
    out.push_str(&format!("- prompt:\n\n{}\n", quote(&t.prompt)));
    out
}

fn quote(text: &str) -> String {
    text.lines()
        .map(|l| format!("> {l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn run_line(r: &ScheduledRun) -> String {
    let why = match r.trigger {
        RunTrigger::Schedule => "on schedule",
        RunTrigger::CatchUp => "making up for missed runs",
        RunTrigger::Manual => "run now",
    };
    let what = match r.result {
        RunResult::Started => format!(
            "started \"{}\" (`{}`)",
            r.session_title.as_deref().unwrap_or_default(),
            r.session_id.as_deref().unwrap_or_default()
        ),
        RunResult::Skipped => "skipped".into(),
        RunResult::Failed => "failed".into(),
    };
    let message = r
        .message
        .as_deref()
        .map(|m| format!(": {}", m.replace('\n', " ")))
        .unwrap_or_default();
    format!("{} {why}, {what}{message}", when(r.at))
}

fn id_arg() -> Value {
    json!({ "type": "string", "description": "The task's id, from list_scheduled_tasks." })
}

fn schedule_arg() -> Value {
    json!({
        "type": "object",
        "description": "When it runs, in the user's time zone. One of: {\"unit\":\"minutes\",\"every\":30}; {\"unit\":\"hours\",\"every\":2}; {\"unit\":\"days\",\"every\":1,\"at\":\"09:00\"}; {\"unit\":\"weeks\",\"every\":1,\"weekdays\":[\"mon\",\"thu\"],\"at\":\"09:00\"}; {\"unit\":\"months\",\"every\":1,\"day\":31,\"at\":\"08:00\"}. Minutes and hours are elapsed time counted from when the schedule is set. A day a month does not have runs on its last day. A time the clock skips when daylight saving time starts runs when it jumps.",
        "properties": {
            "unit": { "type": "string", "enum": ["minutes", "hours", "days", "weeks", "months"] },
            "every": { "type": "integer", "minimum": 1, "description": "Every this many units. Default 1." },
            "at": { "type": "string", "description": "Time of day, HH:MM (24 hours). For days, weeks and months." },
            "weekdays": { "type": "array", "items": { "type": "string", "enum": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }, "description": "For weeks." },
            "day": { "type": "integer", "minimum": 1, "maximum": 31, "description": "Day of the month, for months." },
        },
        "required": ["unit"],
    })
}

/// The fields a task has, all optional (for update_scheduled_task).
fn task_fields() -> serde_json::Map<String, Value> {
    let Value::Object(m) = json!({
        "name": { "type": "string", "description": "Short name, shown in Aura and in each session's title." },
        "prompt": { "type": "string", "description": "The first message of every session it starts: a complete, self-contained brief." },
        "agent": { "type": "string", "description": "`claude`, `codex`, or an ACP agent id from list_agents." },
        "model": { "type": "string", "description": "Model id from list_agents. Empty: the agent's default." },
        "effort": { "type": "string", "description": "Reasoning effort from list_agents. Empty: the default." },
        "cwd": { "type": "string", "description": "Absolute path of the folder or repository the sessions work in; list_projects shows the ones Aura knows." },
        "worktree": { "type": "boolean", "description": "Start each run in a new git worktree of `cwd`, on a branch of its own. Default false." },
        "branch_prefix": { "type": "string", "description": "Start of each run's branch name, which ends in the run's date and time. Default `scheduled/<name>`." },
        "group": { "type": "string", "description": "Sidebar group of the sessions it starts. Empty: none." },
        "schedule": schedule_arg(),
        "enabled": { "type": "boolean", "description": "Default true." },
        "missed": { "type": "string", "enum": ["run_once", "skip"], "description": "Runs that came due while Aura was not running or the computer slept: `run_once` (default) runs once when Aura is back, however many went by; `skip` runs none of them." },
        "allow_overlap": { "type": "boolean", "description": "Start a run while the previous run's session is still working. Default false: that run is skipped and recorded as skipped." },
    }) else {
        unreachable!()
    };
    m
}

pub fn tools() -> Vec<Value> {
    let create = task_fields();
    let mut update = task_fields();
    update.insert("id".into(), id_arg());
    vec![
        json!({
            "name": "list_scheduled_tasks",
            "description": "List the user's scheduled tasks: prompts Aura starts a new session with on a schedule, with when each runs next and how its last run went.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true },
        }),
        json!({
            "name": "read_scheduled_task_history",
            "description": "Read a scheduled task in full, with its run history: when each run happened, whether it started a session (and which), was skipped or failed, and why.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": id_arg(),
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Entries, latest first. Default 20." },
                },
                "required": ["id"],
            },
            "annotations": { "readOnlyHint": true },
        }),
        json!({
            "name": "create_scheduled_task",
            "description": "Create a scheduled task for the user: each time its schedule comes round, Aura starts a new session with `prompt`, which the user can open like any other. It runs whether or not the Aura window is open. The sessions are the user's, not your workers. You cannot choose permission or sandbox modes: a task that runs your own agent gets yours, others the agent's default, and the user can change them in Aura.",
            "inputSchema": {
                "type": "object",
                "properties": create,
                "required": ["name", "prompt", "agent", "cwd", "schedule"],
            },
        }),
        json!({
            "name": "update_scheduled_task",
            "description": "Change a scheduled task: give only the fields to change; an empty text clears an optional one. A new schedule counts from now. Changing what a task does (prompt, agent, model, effort, folder or worktree) sets its permission and sandbox modes back to the ones you would get.",
            "inputSchema": {
                "type": "object",
                "properties": update,
                "required": ["id"],
            },
        }),
        json!({
            "name": "delete_scheduled_task",
            "description": "Delete a scheduled task and its history. The sessions it started are kept.",
            "inputSchema": { "type": "object", "properties": { "id": id_arg() }, "required": ["id"] },
            "annotations": { "destructiveHint": true },
        }),
        json!({
            "name": "set_scheduled_task_enabled",
            "description": "Enable or disable a scheduled task. A disabled task does not run; enabled again, it does not make up for the time it was off.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": id_arg(), "enabled": { "type": "boolean" } },
                "required": ["id", "enabled"],
            },
        }),
        json!({
            "name": "run_scheduled_task",
            "description": "Run a scheduled task now, outside its schedule, which stays as it is. Like a scheduled run, it is skipped while the previous run's session is still working, unless the task allows overlapping runs.",
            "inputSchema": { "type": "object", "properties": { "id": id_arg() }, "required": ["id"] },
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_core::{MissedRuns, Schedule};

    fn task() -> ScheduledTask {
        let at = "2026-11-18T08:00:00Z".parse().unwrap();
        ScheduledTask {
            id: "t1".into(),
            name: "Nightly triage".into(),
            prompt: "Triage new issues.\nLabel them.".into(),
            agent: "codex".into(),
            model: Some("gpt-5".into()),
            effort: None,
            permission_mode: None,
            sandbox_mode: Some("workspace-write".into()),
            cwd: "/repo".into(),
            worktree: true,
            branch_prefix: None,
            group: Some("Chores".into()),
            enabled: true,
            schedule: Schedule::Weeks {
                every: 1,
                weekdays: vec![aura_core::Weekday::Mon],
                at: "07:00".parse().unwrap(),
            },
            missed: MissedRuns::Skip,
            allow_overlap: false,
            created_at: at,
            updated_at: at,
            anchor: at,
            last_slot: None,
            next_run: Some(at),
            last_run: None,
            created_by: None,
        }
    }

    #[test]
    fn every_tool_calls_its_orchestrator_method_for_the_orchestrator() {
        for tool in NAMES {
            let (method, p) = request(tool, "o1", &json!({ "id": "t1" })).unwrap();
            assert!(method.starts_with("orchestrator.schedules."), "{method}");
            assert_eq!(p["orchestrator"], json!("o1"));
            assert_eq!(p["id"], json!("t1"));
        }
        // It cannot pose as another orchestrator.
        let (_, p) = request(
            "list_scheduled_tasks",
            "o1",
            &json!({ "orchestrator": "o2" }),
        )
        .unwrap();
        assert_eq!(p["orchestrator"], json!("o1"));
        assert!(request("start_session", "o1", &json!({})).is_none());
        let all = tools();
        let names: Vec<&str> = all.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, NAMES);
        // Permission modes are not among a task's fields here.
        for t in tools() {
            let props = &t["inputSchema"]["properties"];
            assert!(props.get("permission_mode").is_none() && props.get("sandbox_mode").is_none());
        }
    }

    #[test]
    fn a_task_reads_with_everything_it_does() {
        let text = describe_task(&task());
        for want in [
            "\"Nightly triage\" (`t1`)",
            "enabled: every week on Monday at 07:00",
            "starts codex · gpt-5 · default in /repo, each run in a new worktree on a branch starting `scheduled/nightly-triage-`",
            "sandbox workspace-write (the user's to change)",
            "group \"Chores\"",
            "missed runs (Aura not running, computer asleep): skipped",
            "previous run still works: skip the run",
            "> Triage new issues.\n> Label them.",
        ] {
            assert!(text.contains(want), "{want}\nin\n{text}");
        }
    }

    #[test]
    fn history_says_what_each_run_did() {
        let mut t = task();
        let run = ScheduledRun {
            id: "r1".into(),
            task_id: "t1".into(),
            at: "2026-11-18T09:00:00Z".parse().unwrap(),
            slot: None,
            trigger: RunTrigger::Schedule,
            result: RunResult::Skipped,
            session_id: Some("s1".into()),
            session_title: Some("Nightly triage · Mon".into()),
            message: Some("The previous run is still working.".into()),
        };
        t.last_run = Some(run.clone());
        let text = reply(
            "read_scheduled_task_history",
            json!({ "task": t, "runs": [run] }),
        )
        .unwrap();
        assert!(
            text.contains("on schedule, skipped: The previous run is still working."),
            "{text}"
        );
        let listed = reply("list_scheduled_tasks", json!([t])).unwrap();
        assert!(
            listed.contains("`t1` \"Nightly triage\": every week on Monday at 07:00 (next "),
            "{listed}"
        );
        assert!(listed.contains("; last: "), "{listed}");
        assert_eq!(
            reply("list_scheduled_tasks", json!([])).unwrap(),
            "The user has no scheduled tasks. Create one with create_scheduled_task."
        );
        let started = reply(
            "run_scheduled_task",
            json!(ScheduledRun {
                result: RunResult::Started,
                trigger: RunTrigger::Manual,
                message: None,
                ..t.last_run.clone().unwrap()
            }),
        )
        .unwrap();
        assert!(
            started.starts_with("Started session \"Nightly triage · Mon\" (`s1`)."),
            "{started}"
        );
    }
}
