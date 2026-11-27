import { describe, expect, it, vi } from "vitest";
import type { ConnInfo } from "./connection";
import { DaemonLink, connectWindow } from "./daemonLink";

type Fake = { info: { port: number; token: string }; connect: () => Promise<void>; close: ReturnType<typeof vi.fn> };

/** Promises a test resolves when it likes. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function setup(opts: { connect?: (info: ConnInfo) => Promise<void>; attach?: (c: Fake) => Promise<() => void> | (() => void) } = {}) {
  const clients: Fake[] = [];
  const committed: Fake[] = [];
  const detached: Fake[] = [];
  const link = new DaemonLink<Fake>({
    makeClient: (info) => {
      const c: Fake = { info: { port: info.port, token: info.token }, connect: () => (opts.connect ? opts.connect(info) : Promise.resolve()), close: vi.fn() };
      clients.push(c);
      return c;
    },
    attach: (c) => (opts.attach ? opts.attach(c) : () => detached.push(c)),
    commit: (c) => committed.push(c),
  });
  return { link, clients, committed, detached };
}

describe("daemon link", () => {
  it("connects, subscribes, then commits", async () => {
    const { link, committed } = setup();
    expect(await link.switchTo({ port: 1000, token: "a" })).toBe(true);
    expect(link.current?.info).toEqual({ port: 1000, token: "a" });
    expect(committed).toHaveLength(1);
  });

  it("stays on the same daemon when told about it again", async () => {
    const { link, clients } = setup();
    await link.switchTo({ port: 1000, token: "a" });
    expect(await link.switchTo({ port: 1000, token: "a" })).toBe(false);
    expect(clients).toHaveLength(1);
    expect(clients[0].close).not.toHaveBeenCalled();
  });

  it("moves to a daemon with new credentials: closes the old client, resubscribes on the new", async () => {
    const { link, clients, committed, detached } = setup();
    await link.switchTo({ port: 1000, token: "a" });
    expect(await link.switchTo({ port: 2000, token: "b" })).toBe(true);
    const [old, next] = clients;
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(detached).toEqual([old]);
    expect(committed).toEqual([old, next]);
    expect(link.current).toBe(next);
    // A new token on the same port is another daemon too.
    expect(await link.switchTo({ port: 2000, token: "c" })).toBe(true);
    expect(next.close).toHaveBeenCalledTimes(1);
  });

  it("closes a candidate that cannot connect and keeps the old client", async () => {
    const { link, clients, committed } = setup({ connect: async (info) => (info.port === 2000 ? Promise.reject(new Error("refused")) : undefined) });
    await link.switchTo({ port: 1000, token: "a" });
    await expect(link.switchTo({ port: 2000, token: "b" })).rejects.toThrow("refused");
    expect(clients[1].close).toHaveBeenCalledTimes(1);
    expect(clients[0].close).not.toHaveBeenCalled();
    expect(link.current).toBe(clients[0]);
    expect(committed).toEqual([clients[0]]);
  });

  it("commits nothing when subscribing fails, and retries the same daemon later", async () => {
    let fail = true;
    const { link, clients, committed } = setup({
      attach: async () => {
        if (fail) throw new Error("sessions.list failed");
        return () => {};
      },
    });
    await expect(link.switchTo({ port: 1000, token: "a" })).rejects.toThrow("sessions.list failed");
    expect(link.current).toBeNull();
    expect(committed).toEqual([]);
    expect(clients[0].close).toHaveBeenCalledTimes(1);
    // The same endpoint again: not taken for the current one.
    fail = false;
    expect(await link.switchTo({ port: 1000, token: "a" })).toBe(true);
    expect(link.current).toBe(clients[1]);
  });

  it("calls off a switch under way when closed", async () => {
    const gate = deferred();
    const { link, clients, committed } = setup({ connect: () => gate.promise });
    const pending = link.switchTo({ port: 1000, token: "a" });
    // Connecting.
    await new Promise((r) => setTimeout(r, 0));
    expect(clients).toHaveLength(1);
    link.close();
    gate.resolve();
    expect(await pending).toBe(false);
    expect(link.current).toBeNull();
    expect(committed).toEqual([]);
    expect(clients[0].close).toHaveBeenCalledTimes(1);
  });

  it("calls off a switch that subscribes when closed", async () => {
    const gate = deferred<() => void>();
    const detach = vi.fn();
    const { link, clients, committed } = setup({ attach: () => gate.promise });
    const pending = link.switchTo({ port: 1000, token: "a" });
    await new Promise((r) => setTimeout(r, 0));
    link.close();
    gate.resolve(detach);
    expect(await pending).toBe(false);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(committed).toEqual([]);
  });

  it("calls off switches still waiting in line when closed", async () => {
    const gate = deferred();
    const { link, clients, committed } = setup({ connect: (info) => (info.port === 1 ? gate.promise : Promise.resolve()) });
    const first = link.switchTo({ port: 1, token: "a" });
    const queued = link.switchTo({ port: 2, token: "b" });
    await new Promise((r) => setTimeout(r, 0));
    link.close();
    gate.resolve();
    expect(await first).toBe(false);
    expect(await queued).toBe(false);
    // The queued one never even made a client.
    expect(clients).toHaveLength(1);
    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(committed).toEqual([]);
    expect(link.current).toBeNull();
  });

  it("a switch asked for after closing does nothing until asked again", async () => {
    const { link, clients } = setup();
    const pending = link.switchTo({ port: 1, token: "a" });
    link.close();
    expect(await pending).toBe(false);
    expect(clients).toHaveLength(0);
    expect(await link.switchTo({ port: 1, token: "a" })).toBe(true);
  });

  it("applies switches in order", async () => {
    const { link } = setup();
    await Promise.all([link.switchTo({ port: 1, token: "a" }), link.switchTo({ port: 2, token: "b" }), link.switchTo({ port: 3, token: "c" })]);
    expect(link.current?.info).toEqual({ port: 3, token: "c" });
  });
});

describe("connecting a window", () => {
  function harness() {
    const { link } = setup();
    const calls: string[] = [];
    let announce: (info: ConnInfo) => void = () => {};
    const discovery = deferred<ConnInfo>();
    const onError = vi.fn();
    const listen = vi.fn(async (onChange: (info: ConnInfo) => void) => {
      calls.push("listen");
      announce = onChange;
      return () => calls.push("unlisten");
    });
    const discover = vi.fn(() => {
      calls.push("discover");
      return discovery.promise;
    });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    return { link, calls, listen, discover, discovery, onError, settle, announce: (i: ConnInfo) => announce(i) };
  }

  it("listens before it looks for the daemon, then connects to what it found", async () => {
    const h = harness();
    const connecting = connectWindow({ link: h.link, listen: h.listen, discover: h.discover, onError: h.onError });
    await h.settle();
    expect(h.calls).toEqual(["listen", "discover"]);
    h.discovery.resolve({ port: 1000, token: "a" });
    await connecting;
    await h.settle();
    expect(h.link.current?.info).toEqual({ port: 1000, token: "a" });
  });

  it("does not miss an announcement made while it looks, which wins over what it found", async () => {
    const h = harness();
    const connecting = connectWindow({ link: h.link, listen: h.listen, discover: h.discover, onError: h.onError });
    await h.settle();
    // The daemon was restarted while this window looked for the old one.
    h.announce({ port: 2000, token: "new" });
    h.discovery.resolve({ port: 1000, token: "old" });
    await connecting;
    await h.settle();
    expect(h.link.current?.info).toEqual({ port: 2000, token: "new" });
  });

  it("an announcement after it connected moves it", async () => {
    const h = harness();
    const connecting = connectWindow({ link: h.link, listen: h.listen, discover: h.discover, onError: h.onError });
    h.discovery.resolve({ port: 1000, token: "a" });
    await connecting;
    await h.settle();
    h.announce({ port: 2000, token: "b" });
    await h.settle();
    expect(h.link.current?.info).toEqual({ port: 2000, token: "b" });
  });

  it("reports a failed discovery unless an announcement connected it", async () => {
    const h = harness();
    const connecting = connectWindow({ link: h.link, listen: h.listen, discover: h.discover, onError: h.onError });
    await h.settle();
    h.discovery.reject(new Error("no daemon"));
    await connecting;
    expect(h.onError).toHaveBeenCalledWith(new Error("no daemon"));
  });
});
