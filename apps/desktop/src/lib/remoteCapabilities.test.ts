import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { REMOTE_ALLOWED_METHODS, commandWorksRemotely, refusalMessage, remoteAllows, remoteCreateParams } from "./remoteCapabilities";
import { RemoteRpcClient, ERR_FORBIDDEN } from "./remoteClient";
import { RpcClient, RpcError } from "./rpc";
import { evaluateWhen, listCommands, registerCommands, runCommand, setCommandErrorHandler, setRemoteShown, type CommandContext } from "./commands";

describe("the allowlist", () => {
  it("is the daemon's REMOTE_ALLOWED_METHODS, exactly", () => {
    const rust = readFileSync(resolve(__dirname, "../../../../crates/aura-rpc/src/remote.rs"), "utf8");
    const block = rust.slice(rust.indexOf("pub const REMOTE_ALLOWED_METHODS"), rust.indexOf("];", rust.indexOf("pub const REMOTE_ALLOWED_METHODS")));
    const daemon = [...block.matchAll(/"([a-z_.A-Z]+)"/g)].map((m) => m[1]);
    expect(daemon.length).toBeGreaterThan(10);
    expect([...REMOTE_ALLOWED_METHODS].sort()).toEqual([...daemon].sort());
  });

  it("allows sessions and refuses terminals, files, git and settings", () => {
    for (const m of ["session.list", "session.send", "session.respond_approval", "orchestrator.projects", "feature.answer"]) expect(remoteAllows(m)).toBe(true);
    for (const m of ["pty.attach", "fs.list_dir", "git.status", "settings.get", "mods.list", "session.delete", "session.rename", "remote.status", "daemon.window_hello"]) expect(remoteAllows(m)).toBe(false);
  });

  it("says in words what is not available", () => {
    expect(refusalMessage("pty.attach")).toBe("Terminals: not available on remote computers");
    expect(refusalMessage("fs.read_image")).toBe("Browsing files: not available on remote computers");
    expect(refusalMessage("session.delete")).toBe("Deleting sessions: not available on remote computers");
    expect(refusalMessage("prompts.get")).toBe("`prompts.get`: not available on remote computers");
  });
});

describe("commands on a remote computer", () => {
  it("leaves out what needs this computer, keeps the rest", () => {
    for (const id of ["session.new-terminal", "session.delete", "session.rename", "session.pin", "session.mode-terminal", "session.pick-model", "git.commit", "git.diff", "schedules.open", "search.open", "import.open", "workspace.delete"])
      expect(commandWorksRemotely(id)).toBe(false);
    for (const id of ["session.new", "session.stop", "session.interrupt", "approval.accept-oldest", "inbox.open", "settings.open", "workspace.new", "workspace.switch", "session.move-workspace", "computer.switch", "tab.next"])
      expect(commandWorksRemotely(id)).toBe(true);
  });

  it("are hidden from the palette and refused by key with a hint", async () => {
    const ran = vi.fn();
    const off = registerCommands([
      { id: "session.delete", title: "Delete session…", group: "Session", run: ran },
      { id: "session.stop", title: "Stop", group: "Session", run: ran },
    ]);
    const errors: string[] = [];
    setCommandErrorHandler((m) => errors.push(m));
    const ctx = { remote: true } as CommandContext;
    expect(listCommands(ctx).map((c) => c.id)).toContain("session.stop");
    expect(listCommands(ctx).map((c) => c.id)).not.toContain("session.delete");
    expect(listCommands({ remote: false } as CommandContext).map((c) => c.id)).toContain("session.delete");
    expect(evaluateWhen("!remote", ctx)).toBe(false);

    setRemoteShown(() => true);
    expect(await runCommand("session.delete")).toBe(false);
    expect(ran).not.toHaveBeenCalled();
    expect(errors).toEqual(["Delete session: not available on remote computers. Switch to this computer to use it."]);
    expect(await runCommand("session.stop")).toBe(true);
    setRemoteShown(() => false);
    expect(await runCommand("session.delete")).toBe(true);
    expect(ran).toHaveBeenCalledTimes(2);
    off();
  });
});

describe("session.create for a remote", () => {
  it("sends only the keys a remote takes, without nulls, the worktree without a path", () => {
    expect(
      remoteCreateParams({
        provider: "claude",
        cwd: "/srv/aura",
        title: null,
        command: null,
        orchestrator_id: null,
        model: "opus",
        worktree: { branch: "aura/x", base: null, path: null },
        workspace: "w1",
        orchestrator: false,
      }),
    ).toEqual({ provider: "claude", cwd: "/srv/aura", model: "opus", worktree: { branch: "aura/x" }, workspace: "w1", orchestrator: false });
  });

  it("refuses terminals and commands with words", () => {
    expect(() => remoteCreateParams({ provider: "terminal", cwd: "/x" })).toThrow("Terminal sessions: not available on remote computers");
    expect(() => remoteCreateParams({ provider: "claude", cwd: "/x", mode: "terminal" })).toThrow(/Terminal sessions/);
    expect(() => remoteCreateParams({ provider: "claude", cwd: "/x", command: ["bash"] })).toThrow(/Custom commands/);
  });
});

describe("the remote client", () => {
  it("refuses forbidden methods before sending, with -32003 and a hint", async () => {
    const send = vi.spyOn(RpcClient.prototype, "call");
    const c = new RemoteRpcClient("srv", 1, "t");
    const e = await c.gitStatus("/x").catch((err: unknown) => err);
    expect(e).toBeInstanceOf(RpcError);
    expect((e as RpcError).code).toBe(ERR_FORBIDDEN);
    expect((e as RpcError).message).toBe("Git actions: not available on remote computers");
    expect(send).not.toHaveBeenCalled();
    // An allowed one goes to the connection (not open here).
    await expect(c.sessions()).rejects.toThrow("not connected");
    expect(send).toHaveBeenCalledWith("session.list", {});
    send.mockRestore();
  });

  it("shapes session.create and refuses a terminal", async () => {
    const send = vi.spyOn(RpcClient.prototype, "call").mockResolvedValue({ id: "s" });
    const c = new RemoteRpcClient("srv", 1, "t");
    await c.createSession({ provider: "codex", cwd: "/p", command: null, orchestrator_id: null, title: "T" });
    expect(send).toHaveBeenCalledWith("session.create", { provider: "codex", cwd: "/p", title: "T" });
    send.mockClear();
    await expect(c.createSession({ provider: "terminal", cwd: "/p" })).rejects.toMatchObject({ code: ERR_FORBIDDEN });
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
  });
});
