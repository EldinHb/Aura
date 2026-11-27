import { describe, expect, it, vi } from "vitest";
import { DaemonLink } from "./daemonLink";

type Fake = { info: { port: number; token: string }; connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

function setup() {
  const clients: Fake[] = [];
  const detached: Fake[] = [];
  const attached: Fake[] = [];
  const link = new DaemonLink<Fake>({
    makeClient: (info) => {
      const c: Fake = { info: { port: info.port, token: info.token }, connect: vi.fn(async () => {}), close: vi.fn() };
      clients.push(c);
      return c;
    },
    attach: (c) => {
      attached.push(c);
      return () => detached.push(c);
    },
  });
  return { link, clients, attached, detached };
}

describe("daemon link", () => {
  it("connects and subscribes", async () => {
    const { link, attached } = setup();
    expect(await link.switchTo({ port: 1000, token: "a" })).toBe(true);
    expect(link.current?.info).toEqual({ port: 1000, token: "a" });
    expect(attached).toHaveLength(1);
  });

  it("stays on the same daemon when told about it again", async () => {
    const { link, clients } = setup();
    await link.switchTo({ port: 1000, token: "a" });
    expect(await link.switchTo({ port: 1000, token: "a" })).toBe(false);
    expect(clients).toHaveLength(1);
    expect(clients[0].close).not.toHaveBeenCalled();
  });

  it("moves to a daemon with new credentials: closes the old client, resubscribes on the new", async () => {
    const { link, clients, attached, detached } = setup();
    await link.switchTo({ port: 1000, token: "a" });
    expect(await link.switchTo({ port: 2000, token: "b" })).toBe(true);
    const [old, next] = clients;
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(detached).toEqual([old]);
    expect(attached).toEqual([old, next]);
    expect(next.connect).toHaveBeenCalledTimes(1);
    expect(link.current).toBe(next);
    // A new token on the same port is another daemon too.
    expect(await link.switchTo({ port: 2000, token: "c" })).toBe(true);
    expect(next.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the old client when the new daemon cannot be reached", async () => {
    const closed = vi.fn();
    const link = new DaemonLink<{ port: number; connect: () => Promise<void>; close: () => void }>({
      makeClient: (info) => ({
        port: info.port,
        connect: async () => (info.port === 2000 ? Promise.reject(new Error("refused")) : undefined),
        close: closed,
      }),
      attach: () => () => {},
    });
    await link.switchTo({ port: 1000, token: "a" });
    await expect(link.switchTo({ port: 2000, token: "b" })).rejects.toThrow("refused");
    expect(closed).not.toHaveBeenCalled();
    expect(link.current?.port).toBe(1000);
    // And still moves once the daemon is there.
    expect(await link.switchTo({ port: 3000, token: "c" })).toBe(true);
  });

  it("applies switches in order", async () => {
    const { link } = setup();
    await Promise.all([link.switchTo({ port: 1, token: "a" }), link.switchTo({ port: 2, token: "b" }), link.switchTo({ port: 3, token: "c" })]);
    expect(link.current?.info).toEqual({ port: 3, token: "c" });
  });
});
