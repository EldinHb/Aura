/** Answers that arrive after the window moved to another computer are the old one's, and are dropped. */
import { beforeEach, expect, it, vi } from "vitest";
import type { Event, Feature, Session, StoredEvent } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { syncWithDaemon } from "./daemonSync";
import { useStore } from "./store";
import { useFeatures } from "./features";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

const session = (id: string) => ({ id, title: id, workspace: "one", status: "idle", archived: false, pinned: false, pending_count: 0, attention: null, orchestrator_id: null, created_at: "", last_activity: "" }) as Session;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  useStore.setState({ sessions: { mine: session("mine") }, transcripts: {}, workspaces: [], providers: [], selectedId: null, tabs: [], activeTab: null });
});

it("a snapshot, its held events and the features of a sync stopped meanwhile never reach the store", async () => {
  const list = deferred<Session[]>();
  const features = deferred<Feature[]>();
  const events = new Set<(ev: Event) => void>();
  const old = {
    state: "open",
    providers: vi.fn(async () => []),
    sessions: vi.fn(() => list.promise),
    daemonInfo: vi.fn(async () => ({ version: "0.6.3" })),
    workspaces: vi.fn(async () => []),
    touchWorkspace: vi.fn(async () => true),
    features: vi.fn(() => features.promise),
    roleSuggestions: vi.fn(async () => []),
    onState: () => () => {},
    onEvent: (l: (ev: Event) => void) => { events.add(l); return () => events.delete(l); },
  };
  const before = useFeatures.getState();
  const stop = syncWithDaemon(old as unknown as RpcClient, { initialSession: null, selectFirst: true });
  // An event held while the snapshot loads.
  events.forEach((l) => l({ type: "session_created", session: session("held") }));
  // The window moves on to another computer before the old daemon answers.
  stop();
  list.resolve([session("theirs")]);
  features.resolve([{ owner_id: "x" } as unknown as Feature]);
  await stop.loaded;
  await Promise.resolve();
  expect(Object.keys(useStore.getState().sessions)).toEqual(["mine"]);
  expect(useStore.getState().selectedId).toBeNull();
  expect(useFeatures.getState()).toBe(before);
});

it("a transcript that loads after the client changed is dropped", async () => {
  const history = deferred<StoredEvent[]>();
  const old = { history: vi.fn(() => history.promise) } as unknown as RpcClient;
  useStore.setState({ client: old });
  useStore.getState().loadTranscript("s1");
  expect(useStore.getState().transcripts.s1?.loading).toBe(true);
  // Another computer shown: its own client, transcripts emptied.
  useStore.setState({ client: { history: vi.fn(() => new Promise(() => {})) } as unknown as RpcClient, transcripts: {} });
  history.resolve([{ seq: 1, ts: "", event: { type: "session_removed", session_id: "s1" } } as unknown as StoredEvent]);
  await history.promise;
  await Promise.resolve();
  expect(useStore.getState().transcripts.s1).toBeUndefined();
});
