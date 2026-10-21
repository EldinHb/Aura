import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Item, Session } from "../gen";
import { emptyTranscript, useStore, type Transcript as TranscriptState } from "../state/store";
import { closeWorkerThreads, openWorkerThread, reloadWorkerThreads, useWorkerThreads } from "../state/workerThreads";
import { Transcript } from "./Transcript";
import { OrchestratorTabs, WorkerThreads } from "./WorkerThreads";

const ORCH = "99999999-9999-4999-8999-999999999999";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: id, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false, created_at: "2026-10-15T00:00:00Z",
    pending_count: 0, last_activity: "2026-10-15T00:00:00Z", group: null, worktree: null, model: null, effort: null, orchestrator: false, orchestrator_id: null, pulls: [], attention: null, ...patch } as Session;
}

function item(sessionId: string, id: string, kind: Item["kind"], text: string, at: string, extra: Partial<Item> = {}): Item {
  return { id, session_id: sessionId, turn_id: id, kind, status: "completed", title: null, text, data: {}, parent_id: null, started_at: at, ended_at: at, ...extra };
}

function transcript(items: Item[]): TranscriptState {
  const t = emptyTranscript();
  t.order = items.map((i) => i.id);
  t.items = Object.fromEntries(items.map((i) => [i.id, i]));
  t.loaded = true;
  return t;
}

const report = `[Aura] Worker report. This message comes from Aura, not the user.

### Builder (\`${A}\`) · claude · opus · high · idle
In /work
Last reply:
Built it.

### Tester (\`${B}\`) · codex · default · default · failed
In /work
Error: boom
No reply yet.
`;

const history = vi.fn(async () => []);
const saved = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v), removeItem: (k: string) => saved.delete(k), clear: () => saved.clear() } });
const picked = () => useWorkerThreads.getState().views[ORCH]?.worker;

beforeEach(() => {
  saved.clear();
  useWorkerThreads.setState({ views: {} });
  useStore.setState({
    client: { history } as never,
    selectedId: ORCH,
    dialog: { kind: "none" },
    sessions: {
      [ORCH]: session(ORCH, { title: "Lead", orchestrator: true }),
      [A]: session(A, { title: "Builder", orchestrator_id: ORCH, model: "opus", effort: "high", created_at: "2026-10-15T00:00:01Z" }),
      [B]: session(B, { title: "Tester", orchestrator_id: ORCH, provider: "codex", status: "error", created_at: "2026-10-15T00:00:02Z" }),
    },
    transcripts: {
      [ORCH]: transcript([
        item(ORCH, "o1", "user_message", "build and test it", "2026-10-15T00:00:00Z"),
        item(ORCH, "o2", "user_message", report, "2026-10-15T00:00:05Z"),
        item(ORCH, "o3", "agent_message", "Builder is done; Tester failed.", "2026-10-15T00:00:06Z"),
      ]),
      [A]: transcript([
        item(A, "a1", "user_message", "Build it.", "2026-10-15T00:00:01Z", { data: { from_orchestrator: ORCH } }),
        item(A, "a2", "agent_message", "Built it.", "2026-10-15T00:00:04Z"),
        item(A, "a3", "user_message", "Also lint, please.", "2026-10-15T00:00:07Z"),
        item(A, "a4", "agent_message", "Linted.", "2026-10-15T00:00:08Z"),
      ]),
    },
  });
});
afterEach(cleanup);

// jsdom has no layout, so no scrollIntoView.
Element.prototype.scrollIntoView ??= () => {};

it("lists an orchestrator's workers and shows the conversation with one of them", () => {
  render(
    <>
      <OrchestratorTabs orchestratorId={ORCH} />
      <WorkerThreads orchestratorId={ORCH} />
    </>,
  );
  const rows = [...document.querySelectorAll(".worker-row")].map((r) => r.textContent);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("Builder");
  expect(rows[0]).toContain("Claude Code · opus · high");
  expect(screen.getByRole("tab", { name: /Workers/ }).textContent).toContain("2");

  fireEvent.click(screen.getByText("Builder"));
  const thread = document.querySelector(".thread-body")!;
  const said = [...thread.querySelectorAll(".thread-msg")].map((m) => [m.className.replace("thread-msg ", ""), m.querySelector(".thread-head .name")?.textContent]);
  expect(said).toEqual([
    ["from-orchestrator", "Lead"],
    ["from-worker", "Builder"],
    ["from-aura", "Aura"],
    ["from-user", "You"],
    ["from-worker", "Builder"],
  ]);
  expect(thread.textContent).toContain("brief");
  // A report on several workers shows only this worker's part, folded until opened.
  const aura = thread.querySelector<HTMLElement>(".from-aura .thread-head")!;
  expect(aura.textContent).toContain("idle");
  fireEvent.click(aura);
  expect(thread.querySelector(".from-aura")!.textContent).toContain("Built it.");
  expect(thread.textContent).not.toContain("boom");

  fireEvent.click(screen.getByText("Open session ↗"));
  expect(useStore.getState().selectedId).toBe(A);

  // A worker whose history is not loaded yet gets it loaded; its part of the report shows meanwhile.
  fireEvent.click(screen.getByText("Tester"));
  expect(history).toHaveBeenCalledWith(B);
  fireEvent.click(document.querySelector<HTMLElement>(".from-aura .thread-head")!);
  expect(document.querySelector(".thread-body")!.textContent).toContain("boom");
});

it("links the folded report row in the orchestrator's chat to each worker's thread", () => {
  render(<Transcript sessionId={ORCH} />);
  const links = [...document.querySelectorAll<HTMLElement>(".steps-threads .chip")];
  expect(links.map((l) => l.textContent)).toEqual(["Builder · idle ▸", "Tester · failed ▸"]);
  fireEvent.click(links[1]);
  expect(picked()).toBe(B);
});

it("labels what the orchestrator sent a worker in the worker's chat, and leaves the user's messages the user's", () => {
  render(<Transcript sessionId={A} />);
  const brief = document.querySelector<HTMLElement>('[data-item-id="a1"]')!;
  expect(brief.classList.contains("from-orchestrator")).toBe(true);
  expect(brief.textContent).toContain("From orchestrator");
  expect(brief.textContent).toContain("Lead");
  const own = document.querySelector<HTMLElement>('[data-item-id="a3"]')!;
  expect(own.classList.contains("from-orchestrator")).toBe(false);
  expect(own.textContent).not.toContain("From orchestrator");

  fireEvent.click(screen.getByText("thread ▸"));
  expect(useStore.getState().selectedId).toBe(ORCH);
  expect(picked()).toBe(A);
});

it("reads old worker transcripts by the brief and the texts the orchestrator sent", () => {
  act(() =>
    useStore.setState({
      transcripts: {
        [ORCH]: transcript([
          item(ORCH, "o1", "mcp_call", "", "2026-10-15T00:00:00Z", { data: { server: "aura", tool: "send_message", input: { session: A, text: "Now test it." } } }),
        ]),
        [A]: transcript([
          item(A, "a1", "user_message", "Build it.", "2026-10-15T00:00:01Z"),
          item(A, "a2", "user_message", "Now test it.", "2026-10-15T00:00:02Z"),
          item(A, "a3", "user_message", "Mine.", "2026-10-15T00:00:03Z"),
        ]),
      },
    }),
  );
  render(<Transcript sessionId={A} />);
  const from = (id: string) => document.querySelector(`[data-item-id="${id}"]`)!.classList.contains("from-orchestrator");
  expect([from("a1"), from("a2"), from("a3")]).toEqual([true, true, false]);
});

it("remembers each orchestrator's tab and thread across a reload", () => {
  openWorkerThread(ORCH, B);
  openWorkerThread("other", A);
  closeWorkerThreads("other");
  act(() => useWorkerThreads.setState({ views: {} }));
  act(() => reloadWorkerThreads());
  expect(useWorkerThreads.getState().views).toEqual({ [ORCH]: { tab: "workers", worker: B }, other: { tab: "chat", worker: A } });
  // Back on the Workers tab, the thread open last opens again.
  openWorkerThread("other");
  expect(useWorkerThreads.getState().views.other).toEqual({ tab: "workers", worker: A });
  render(<WorkerThreads orchestratorId={ORCH} />);
  expect(document.querySelector(".thread-title")!.textContent).toContain("Tester");
  // Saved junk is dropped rather than shown.
  saved.set("aura.worker-threads.v1", JSON.stringify({ x: { tab: "nope" }, y: { tab: "chat", worker: 3 } }));
  act(() => reloadWorkerThreads());
  expect(useWorkerThreads.getState().views).toEqual({});
});

it("leaves archived workers out of the list, unless a link opens one's thread", () => {
  act(() => useStore.setState({ sessions: { ...useStore.getState().sessions, [A]: { ...useStore.getState().sessions[A], archived: true } } }));
  render(
    <>
      <OrchestratorTabs orchestratorId={ORCH} />
      <WorkerThreads orchestratorId={ORCH} />
    </>,
  );
  const rows = () => [...document.querySelectorAll(".worker-row")].map((r) => r.textContent);
  expect(rows()).toEqual([expect.stringContaining("Tester")]);
  expect(screen.getByRole("tab", { name: /Workers/ }).textContent).toContain("1");
  // A report's link to the archived worker opens its thread, marked archived.
  act(() => openWorkerThread(ORCH, A));
  expect(rows()).toEqual([expect.stringContaining("archived"), expect.stringContaining("Tester")]);
  expect(document.querySelector(".thread-title")!.textContent).toContain("archived");
  expect(document.querySelector(".thread-body")!.textContent).toContain("Built it.");
  // A link to a worker deleted since says so.
  act(() => openWorkerThread(ORCH, "gone"));
  expect(document.querySelector(".worker-thread.empty")!.textContent).toContain("deleted");
});
