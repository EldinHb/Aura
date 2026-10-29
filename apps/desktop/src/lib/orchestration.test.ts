import { describe, expect, it } from "vitest";
import type { Item } from "../gen";
import { orchestratorMessages, reportSections, reportedWorkers, sentTexts, workerThread } from "./orchestration";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ORCH = "99999999-9999-4999-8999-999999999999";
const HEAD = "[Aura] Worker report. This message comes from Aura, not the user.\n";

let n = 0;
const item = (kind: Item["kind"], text: string, at: string, extra: Partial<Item> = {}): Item => ({
  id: `i${++n}`,
  session_id: "s",
  turn_id: null,
  kind,
  status: "completed",
  title: null,
  text,
  data: {},
  parent_id: null,
  started_at: at,
  ended_at: null,
  ...extra,
});
const fromOrch = (text: string, at: string) => item("user_message", text, at, { data: { from_orchestrator: ORCH } });

const twoWorkers = `${HEAD}
### Builder (\`${A}\`) · claude · opus · high · idle
In /repo on branch \`build\`
Last reply:
Built it.
### Notes
Headings of its own stay in the reply.

### Tester (\`${B}\`) · codex · default · default · failed
In /repo
Error: boom
No reply yet.
`;

describe("reportSections", () => {
  it("splits a report on several workers into one section each, keeping headings inside replies", () => {
    const sections = reportSections(twoWorkers.slice(HEAD.length));
    expect(sections.map((s) => [s.workerId, s.title, s.detail, s.status])).toEqual([
      [A, "Builder", "claude · opus · high · idle", "idle"],
      [B, "Tester", "codex · default · default · failed", "failed"],
    ]);
    expect(sections[0].body).toBe("In /repo on branch `build`\nLast reply:\nBuilt it.\n### Notes\nHeadings of its own stay in the reply.");
    expect(sections[1].body).toBe("In /repo\nError: boom\nNo reply yet.");
  });

  it("reads only worker reports", () => {
    expect(reportedWorkers(item("user_message", twoWorkers, "t"))).toHaveLength(2);
    expect(reportedWorkers(item("user_message", "[Aura] New review activity on your pull request. This message comes from Aura, not the user.\n### X (`" + A + "`) · y", "t"))).toEqual([]);
    expect(reportedWorkers(item("user_message", "### Builder (`" + A + "`) · claude · idle", "t"))).toEqual([]);
  });
});

describe("orchestratorMessages", () => {
  it("trusts the daemon's mark, and takes unmarked messages after a marked one for the user's", () => {
    const top = [fromOrch("build it", "1"), item("agent_message", "ok", "2"), item("user_message", "from me", "3"), fromOrch("and test it", "4")];
    const { senders, needsSent } = orchestratorMessages({ orchestrator_id: ORCH }, top);
    expect([...senders.values()]).toEqual(["orchestrator", "user", "orchestrator"]);
    expect(needsSent).toBe(false);
  });

  it("reads old transcripts: the first message is the brief, later ones need the texts the orchestrator sent", () => {
    const top = [item("user_message", "build it", "1"), item("user_message", "and test it", "2"), item("user_message", "from me", "3")];
    const before = orchestratorMessages({ orchestrator_id: ORCH }, top);
    expect([...before.senders.values()]).toEqual(["orchestrator", "user", "user"]);
    expect(before.needsSent).toBe(true);
    const after = orchestratorMessages({ orchestrator_id: ORCH }, top, new Set(["and test it"]));
    expect([...after.senders.values()]).toEqual(["orchestrator", "orchestrator", "user"]);
    expect(after.needsSent).toBe(false);
  });

  it("leaves sessions without an orchestrator to the user, and messages from Aura to Aura", () => {
    const aura = item("user_message", "[Aura] New review activity on your pull request. This message comes from Aura, not the user.\nx", "2");
    const { senders, needsSent } = orchestratorMessages({ orchestrator_id: null }, [item("user_message", "hi", "1"), aura]);
    expect([...senders.values()]).toEqual(["user", "aura"]);
    expect(needsSent).toBe(false);
  });
});

describe("sentTexts", () => {
  it("reads start_session, send_message and hire calls of every agent", () => {
    const items = [
      item("mcp_call", "", "1", { title: "aura: start_session", data: { server: "aura", tool: "start_session", input: { agent: "claude", prompt: "build it " } } }),
      item("mcp_call", "", "2", { title: "aura.send_message", data: { server: "aura", tool: "send_message", input: { session: A, text: "and test it" } } }),
      item("tool_call", "", "3", { title: "send_message", data: { tool_name: "mcp__aura__send_message", input: { session: B, text: "acp text" } } }),
      item("mcp_call", "", "4", { title: "aura: list_sessions", data: { tool: "list_sessions", input: {} } }),
      item("agent_message", "send_message", "5"),
      item("tool_call", "", "6", { title: "hire", data: { tool_name: "mcp__aura__hire", input: { specialist: "tester", prompt: "test it" } } }),
    ];
    expect([...sentTexts(items)]).toEqual(["build it", "and test it", "acp text", "test it"]);
  });
});

describe("workerThread", () => {
  it("puts the brief, follow-ups, replies and the worker's own report sections in time order", () => {
    const worker = [
      fromOrch("build it", "2026-01-01T00:00:01Z"),
      item("agent_message", "looking", "2026-01-01T00:00:02Z"),
      item("command_exec", "", "2026-01-01T00:00:03Z"),
      item("agent_message", "Built it.", "2026-01-01T00:00:04Z"),
      item("user_message", "from me", "2026-01-01T00:00:06Z"),
      item("agent_message", "", "2026-01-01T00:00:07Z"),
      fromOrch("and test it", "2026-01-01T00:00:08Z"),
    ];
    const orch = [
      item("user_message", "please build", "2026-01-01T00:00:00Z"),
      item("user_message", twoWorkers, "2026-01-01T00:00:05Z"),
      item("agent_message", "Builder is done", "2026-01-01T00:00:05.5Z"),
    ];
    const { senders } = orchestratorMessages({ orchestrator_id: ORCH }, worker);
    const thread = workerThread(A, worker, senders, orch);
    expect(thread.map((e) => [e.kind, e.kind === "report" ? e.section.title : e.item.text])).toEqual([
      ["orchestrator", "build it"],
      ["reply", "Built it."],
      ["report", "Builder"],
      ["user", "from me"],
      ["orchestrator", "and test it"],
    ]);
    expect(thread.filter((e) => e.kind === "orchestrator").map((e) => e.kind === "orchestrator" && e.brief)).toEqual([true, false]);
    // The other worker gets only its own section of the shared report.
    const other = workerThread(B, [], new Map(), orch);
    expect(other.map((e) => e.kind === "report" && e.section.body)).toEqual(["In /repo\nError: boom\nNo reply yet."]);
  });
});
