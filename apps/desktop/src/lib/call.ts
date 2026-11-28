import { selectLocalClient, useStore } from "../state/store";

/** Call a method on this computer's daemon, whichever computer the window shows. */
export function rpc<T>(method: string, params: unknown = {}): Promise<T> {
  const client = selectLocalClient(useStore.getState());
  if (!client) return Promise.reject(new Error("Not connected to the daemon"));
  return client.call<T>(method, params);
}

/**
 * Call a method on the daemon of the computer the window shows. On a remote
 * computer, methods outside its allowlist are refused before they leave the app.
 */
export function shownRpc<T>(method: string, params: unknown = {}): Promise<T> {
  const client = useStore.getState().client;
  if (!client) return Promise.reject(new Error("Not connected to the daemon"));
  return client.call<T>(method, params);
}
