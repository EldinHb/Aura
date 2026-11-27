/** Find the daemon: Tauri command in the app, URL/dev endpoint in a browser. */
import { RpcClient } from "./rpc";

/**
 * `window_secret`: the secret the desktop shell gave the daemon it spawned;
 * presenting it (`daemon.window_hello`) makes this connection Aura's window,
 * the only one that may grant approvals. Absent when the daemon was not
 * spawned by this app process.
 */
export type ConnInfo = { port: number; token: string; data_dir?: string; version?: string; window_secret?: string | null; windowSecret?: string | null };

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function discoverDaemon(): Promise<ConnInfo> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ConnInfo>("connect_daemon");
  }
  const url = new URL(window.location.href);
  const port = url.searchParams.get("port");
  const token = url.searchParams.get("token");
  if (port && token) return { port: Number(port), token };
  const res = await fetch("/__aura/daemon.json");
  if (!res.ok) throw new Error("No daemon found. Start it with `aura daemon start`.");
  const info = (await res.json()) as ConnInfo;
  if (!info.port) throw new Error("daemon.json is incomplete");
  return info;
}

export async function connectDaemon(): Promise<RpcClient> {
  const info = await discoverDaemon();
  const client = new RpcClient(info.port, info.token);
  const secret = info.window_secret ?? info.windowSecret ?? null;
  // Every (re)connection is a new connection to the daemon: say hello each time.
  const hello = () => {
    if (secret) void client.call("daemon.window_hello", { secret }).catch((e) => console.warn("not Aura's window:", e));
  };
  client.onState((s) => {
    if (s === "open") hello();
  });
  await client.connect();
  return client;
}
