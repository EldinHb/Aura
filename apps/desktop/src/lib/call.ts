import { useStore } from "../state/store";

/** Call a daemon method on the current connection. */
export function rpc<T>(method: string, params: unknown = {}): Promise<T> {
  const client = useStore.getState().client;
  if (!client) return Promise.reject(new Error("Not connected to the daemon"));
  return client.call<T>(method, params);
}
