import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LoadBalancer, LoadBalancerUpdate } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { SettingsDialog } from "./SettingsDialog";

let lb: LoadBalancer;
const setLoadBalancer = vi.fn(async (u: LoadBalancerUpdate) => {
  lb = { ...u, policy: u.policy ?? lb.default_policy, policy_is_default: u.policy === null, default_policy: lb.default_policy };
  return lb;
});

beforeEach(() => {
  lb = { enabled: false, policy: "Route well", policy_is_default: true, default_policy: "Route well", rules: "", prefer: [], avoid: [] };
  vi.clearAllMocks();
  useStore.setState({ providers: [], dialog: { kind: "none" }, client: { loadBalancer: () => Promise.resolve(lb), setLoadBalancer } as unknown as RpcClient });
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
