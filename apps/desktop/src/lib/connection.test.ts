import { afterEach, expect, it, vi } from "vitest";
import { windowClient } from "./connection";

/** A WebSocket the test opens and closes, recording what the client sends. */
class FakeSocket {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  binaryType = "";
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.();
  }
}

const hellos = (ws: FakeSocket) => ws.sent.map((d) => JSON.parse(d) as { method: string; params: unknown }).filter((m) => m.method === "daemon.window_hello");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeSocket.all = [];
});

it("says the window secret on the first connection and on every reconnect", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  const client = windowClient({ port: 1, token: "t", window_secret: "s3cret" });
  const connected = client.connect();
  FakeSocket.all[0].onopen!();
  await connected;
  expect(hellos(FakeSocket.all[0])).toEqual([expect.objectContaining({ params: { secret: "s3cret" } })]);
  // The daemon drops the connection; the client reconnects and says it again.
  FakeSocket.all[0].onclose!();
  await vi.advanceTimersByTimeAsync(300);
  FakeSocket.all[1].onopen!();
  expect(hellos(FakeSocket.all[1])).toEqual([expect.objectContaining({ params: { secret: "s3cret" } })]);
  client.close();
});

it("says nothing for a daemon this app did not spawn", async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  const client = windowClient({ port: 1, token: "t", window_secret: null });
  const connected = client.connect();
  FakeSocket.all[0].onopen!();
  await connected;
  expect(hellos(FakeSocket.all[0])).toEqual([]);
  client.close();
});
