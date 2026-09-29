import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Group, Session } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { groupNames } from "../../state/groups";
import { SettingsDialog } from "./SettingsDialog";

let registry: Group[];
const deleteGroup = vi.fn(async (name: string) => {
  registry = registry.filter((g) => g.name !== name);
  return true;
});

beforeEach(() => {
  registry = [
    { name: "backend", repos: [{ path: "/src/api", last_used: "2026-09-01T10:00:00Z" }] },
    { name: "empty", repos: [] },
  ];
  deleteGroup.mockClear();
  useStore.setState({
    client: { groups: () => Promise.resolve(registry), deleteGroup } as unknown as RpcClient,
    sessions: { s1: { id: "s1", group: "backend" } as Session },
  });
});
afterEach(cleanup);

it("lists remembered groups with their repositories and deletes one after confirming", async () => {
  render(<SettingsDialog tab="groups" />);
  await screen.findByText("backend");
  expect(screen.getByText("/src/api")).toBeTruthy();
  expect(screen.getByText("1 session")).toBeTruthy();
  expect(screen.getByText("no sessions")).toBeTruthy();
  expect(screen.getByText("No repository linked")).toBeTruthy();

  fireEvent.click(screen.getAllByText("Delete…")[0]);
  expect(screen.getByText("Delete and ungroup 1 session?")).toBeTruthy();
  expect(deleteGroup).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Delete"));
  await waitFor(() => expect(screen.queryByText("backend")).toBeNull());
  expect(deleteGroup).toHaveBeenCalledWith("backend");
  expect(screen.getByText("empty")).toBeTruthy();
});

it("merges remembered groups with the groups sessions are in", () => {
  expect(groupNames([{ name: "b", repos: [] }], { x: { group: "a" } as Session, y: { group: null } as Session, z: { group: "b" } as Session })).toEqual(["a", "b"]);
});
