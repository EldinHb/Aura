// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UiApi } from "@aura/mod-sdk/ui";
import type { SessionView } from "../shared/types";
import { session } from "../test/fixtures";
import { setCtx } from "./ctx";
import { LinkDialog } from "./LinkPr";
import { PrStatusSection } from "./PrStatusSection";

const card = (url: string, number: number) => ({
  ref: { url, repo: "acme/api", number, sources: [{ sessionId: "lead", title: "Lead", worker: false }, { sessionId: "w1", title: "W", worker: true }] },
  status: null, readAt: null, error: null,
});

function fakeCtx(view: SessionView, answer: (name: string, p: any) => unknown = () => undefined) {
  const rpc = vi.fn(async (name: string, p?: any) => {
    const own = answer(name, p);
    if (own instanceof Error) throw own;
    if (own !== undefined) return own;
    return name === "unwatch" || name === "links.remove" ? true : view;
  });
  setCtx({ rpc, on: () => () => {}, onConnection: () => () => {}, storage: { get: () => undefined, set: () => {}, delete: () => {} }, sessions: { open: () => [], onOpenChange: () => () => {} } } as unknown as UiApi);
  return rpc;
}

describe("linking pull requests by hand", () => {
  afterEach(() => {
    cleanup();
    setCtx(null);
  });

  it("links a PR from the section, says why a URL is refused, and cancels on Escape", async () => {
    const view: SessionView = { sessionId: "lead", pulls: [card("https://github.com/acme/api/pull/1", 1)], blocked: null };
    const rpc = fakeCtx(view, (name, p) => (name === "links.add" && !p.url.includes("/pull/") ? Object.assign(new Error("Not a GitHub pull request URL"), { code: "invalid" }) : name === "links.add" ? p.url : undefined));
    render(<PrStatusSection session={session("lead")} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Link PR…" }));
    const field = screen.getByLabelText("Pull request URL");
    fireEvent.change(field, { target: { value: "https://github.com/acme/api/issues/4" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Link" })));
    expect(screen.getByRole("alert").textContent).toBe("Not a GitHub pull request URL");
    fireEvent.change(field, { target: { value: "https://github.com/acme/api/pull/4" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Link" })));
    expect(rpc).toHaveBeenCalledWith("links.add", { sessionId: "lead", url: "https://github.com/acme/api/pull/4" });
    expect(rpc).toHaveBeenLastCalledWith("refresh", { sessionId: "lead" });
    expect(screen.queryByRole("form", { name: "Link a pull request" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Link PR…" }));
    fireEvent.keyDown(screen.getByLabelText("Pull request URL"), { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Link a pull request" })).toBeNull();
  });

  it("unlinks a PR from every session it came from", async () => {
    const view: SessionView = { sessionId: "lead", pulls: [card("https://github.com/acme/api/pull/1", 1)], blocked: null };
    const rpc = fakeCtx(view);
    render(<PrStatusSection session={session("lead")} />);
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Unlink #1" })));
    expect(rpc.mock.calls.filter(([n]) => n === "links.remove")).toEqual([
      ["links.remove", { sessionId: "lead", url: "https://github.com/acme/api/pull/1" }],
      ["links.remove", { sessionId: "w1", url: "https://github.com/acme/api/pull/1" }],
    ]);
    expect(rpc).toHaveBeenLastCalledWith("refresh", { sessionId: "lead" });
  });

  it("links from the dialog too (the command, when the section shows no PRs)", async () => {
    const rpc = fakeCtx({ sessionId: "lead", pulls: [], blocked: null }, (name, p) => (name === "links.add" ? p.url : undefined));
    const close = vi.fn();
    render(<LinkDialog props={{ sessionId: "lead" }} close={close} />);
    fireEvent.change(screen.getByLabelText("Pull request URL"), { target: { value: "https://github.com/acme/api/pull/8" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Link" })));
    expect(rpc).toHaveBeenCalledWith("links.add", { sessionId: "lead", url: "https://github.com/acme/api/pull/8" });
    expect(close).toHaveBeenCalled();
  });
});
