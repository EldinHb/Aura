import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Autonomy, Feature, Session } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { useStore } from "../state/store";
import { setFeature, useFeatures } from "../state/features";
import { FeatureSection } from "./FeatureSection";

const setting: Autonomy = { level: "blocking_decisions", checkpoints: ["after_design", "before_implementation", "before_delivery"] };
const setFeatureAutonomy = vi.fn(async () => ({}) as Feature);

beforeEach(() => {
  vi.clearAllMocks();
  useFeatures.setState({ features: {} });
  setFeature({
    owner_id: "owner",
    goal: "Dark mode for the settings",
    status: "in_progress",
    autonomy: null,
    team: [{ worker_id: "w", specialist_id: "tester", name: "Tester (QA)", role: "", instructions: "", hired_at: "" }],
    decisions: [{ id: "d1", decision: "Use CSS variables", rationale: "Themes already do", decided_by: "owner", question_id: null, at: "" }],
    questions: [],
    checkpoints: [],
    suggestions: [],
    report: null,
    created_at: "",
    updated_at: "",
    counters: {},
  });
  useStore.setState({ client: { autonomy: () => Promise.resolve(setting), setFeatureAutonomy } as unknown as RpcClient });
});
afterEach(cleanup);

it("shows the feature's goal, status, team and decisions, and gives it its own autonomy", async () => {
  render(<FeatureSection s={{ id: "owner", feature_owner: true } as Session} />);
  expect(screen.getByText("Dark mode for the settings")).toBeTruthy();
  expect(screen.getByText("in progress")).toBeTruthy();
  expect(screen.getByText("1 member, 1 specialist")).toBeTruthy();
  expect(await screen.findByText("blocking decisions")).toBeTruthy();
  expect(screen.getByText("Use CSS variables")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "change" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Own autonomy/ }));
  await waitFor(() => expect(setFeatureAutonomy).toHaveBeenCalledWith("owner", setting));
});
