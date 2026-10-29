import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Autonomy, LoadBalancer, LoadBalancerUpdate, MeetingSettings } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { SettingsDialog } from "./SettingsDialog";

let lb: LoadBalancer;
const setLoadBalancer = vi.fn(async (u: LoadBalancerUpdate) => {
  lb = { ...u, policy: u.policy ?? lb.default_policy, policy_is_default: u.policy === null, default_policy: lb.default_policy };
  return lb;
});

let autonomy: Autonomy;
const setAutonomy = vi.fn(async (a: Autonomy) => (autonomy = a));
let meetings: MeetingSettings;
const setMeetingSettings = vi.fn(async (s: MeetingSettings) => (meetings = s));

beforeEach(() => {
  lb = { enabled: false, policy: "Route well", policy_is_default: true, default_policy: "Route well", rules: "", prefer: [], avoid: [] };
  autonomy = { level: "blocking_decisions", checkpoints: ["after_design", "before_implementation", "before_delivery"] };
  meetings = { mode: "written", max_rounds: 2, turn_words: 150 };
  vi.clearAllMocks();
  useStore.setState({ providers: [], dialog: { kind: "none" }, client: { loadBalancer: () => Promise.resolve(lb), setLoadBalancer, autonomy: () => Promise.resolve(autonomy), setAutonomy, meetingSettings: () => Promise.resolve(meetings), setMeetingSettings } as unknown as RpcClient });
});
afterEach(cleanup);

const field = (label: string) => screen.getByText(label).parentElement!;

it("is off by default and turns on keeping the default policy", async () => {
  render(<SettingsDialog tab="orchestrators" />);
  const toggle = (await screen.findByRole("checkbox")) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  expect(field("Routing policy · Aura's default").querySelector("textarea")!.value).toBe("Route well");
  fireEvent.click(toggle);
  await waitFor(() => expect(setLoadBalancer).toHaveBeenCalledWith({ enabled: true, policy: null, rules: "", prefer: [], avoid: [] }));
  await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true));
});

it("saves rules and agent lists, rewrites the policy and resets it", async () => {
  render(<SettingsDialog tab="orchestrators" />);
  const rules = (await screen.findByText("Your rules")).parentElement!.querySelector("textarea")!;
  fireEvent.change(rules, { target: { value: "Always use Codex for Rust." } });
  fireEvent.click(field("Your rules").querySelector<HTMLButtonElement>(".btn.primary")!);
  await waitFor(() => expect(setLoadBalancer).toHaveBeenLastCalledWith(expect.objectContaining({ rules: "Always use Codex for Rust." })));

  const avoid = "Never use (Aura refuses to start workers with these)";
  fireEvent.change(field(avoid).querySelector("textarea")!, { target: { value: "opus,\nacp:goose , " } });
  fireEvent.click(field(avoid).querySelector<HTMLButtonElement>(".btn.primary")!);
  await waitFor(() => expect(setLoadBalancer).toHaveBeenLastCalledWith(expect.objectContaining({ avoid: ["opus", "acp:goose"], rules: "Always use Codex for Rust." })));

  fireEvent.change(field("Routing policy · Aura's default").querySelector("textarea")!, { target: { value: "Mine" } });
  fireEvent.click(field("Routing policy · Aura's default").querySelector<HTMLButtonElement>(".btn.primary")!);
  await waitFor(() => expect(setLoadBalancer).toHaveBeenLastCalledWith(expect.objectContaining({ policy: "Mine" })));
  fireEvent.click(await screen.findByText("Reset to default"));
  await waitFor(() => expect(setLoadBalancer).toHaveBeenLastCalledWith(expect.objectContaining({ policy: null, avoid: ["opus", "acp:goose"] })));
  expect(await screen.findByText("Routing policy · Aura's default")).toBeTruthy();
});

it("sets how much feature owners decide on their own, with the checkpoints they stop at", async () => {
  render(<SettingsDialog tab="orchestrators" />);
  const blocking = (await screen.findByRole("radio", { name: /Blocking decisions/ })) as HTMLInputElement;
  expect(blocking.checked).toBe(true);
  expect(screen.queryByRole("checkbox", { name: "Before delivery" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: /Checkpoints/ }));
  await waitFor(() => expect(setAutonomy).toHaveBeenLastCalledWith({ level: "checkpoints", checkpoints: ["after_design", "before_implementation", "before_delivery"] }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "After design" }));
  await waitFor(() => expect(setAutonomy).toHaveBeenLastCalledWith({ level: "checkpoints", checkpoints: ["before_implementation", "before_delivery"] }));
  fireEvent.click(screen.getByRole("checkbox", { name: "After design" }));
  await waitFor(() => expect(setAutonomy).toHaveBeenLastCalledWith({ level: "checkpoints", checkpoints: ["after_design", "before_implementation", "before_delivery"] }));
});

it("keeps meetings written until the user allows live ones, with their rounds and words", async () => {
  render(<SettingsDialog tab="orchestrators" />);
  const written = await screen.findByRole("radio", { name: "Written only" });
  expect(written.getAttribute("aria-checked")).toBe("true");
  expect((screen.getByLabelText("Rounds at most") as HTMLSelectElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Live allowed" }));
  await waitFor(() => expect(setMeetingSettings).toHaveBeenCalledWith({ mode: "live", max_rounds: 2, turn_words: 150 }));
  await waitFor(() => expect((screen.getByLabelText("Rounds at most") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Rounds at most"), { target: { value: "3" } });
  await waitFor(() => expect(setMeetingSettings).toHaveBeenLastCalledWith({ mode: "live", max_rounds: 3, turn_words: 150 }));
  fireEvent.change(screen.getByLabelText("Words per turn"), { target: { value: "100" } });
  await waitFor(() => expect(setMeetingSettings).toHaveBeenLastCalledWith({ mode: "live", max_rounds: 3, turn_words: 100 }));
});
