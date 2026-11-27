/** Types of the daemon's local-only `remote.*` methods (remote clients: the Android app). */

export type RemoteStatus = {
  enabled: boolean;
  bindAddress: string;
  port: number;
  serverName: string;
  /** SHA-256 fingerprint of the server certificate. */
  fingerprint: string;
  listening: boolean;
  error?: string;
  /** Addresses a device on the network can reach this machine at. */
  addresses: string[];
};

export type RemoteConfig = Partial<Pick<RemoteStatus, "enabled" | "bindAddress" | "port" | "serverName">>;

export type PairingInfo = {
  code: string;
  /** ISO time the code stops working. */
  expiresAt: string;
  /** The link the QR code carries. */
  uri: string;
  fingerprint: string;
  addresses: string[];
};

export type RemoteDevice = {
  deviceId: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
  lastAddress: string | null;
};

export const DEFAULT_BIND_ADDRESS = "0.0.0.0";
export const DEFAULT_PORT = 7443;
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

export type RemoteForm = { serverName: string; bindAddress: string; port: string };
export type RemoteFormErrors = Partial<Record<keyof RemoteForm, string>>;

/** What is wrong with the form, per field; empty when it can be saved. */
export function validateRemoteForm(form: RemoteForm): RemoteFormErrors {
  const errors: RemoteFormErrors = {};
  if (!form.serverName.trim()) errors.serverName = "Give this computer a name";
  if (!form.bindAddress.trim()) errors.bindAddress = "Enter an address, such as 0.0.0.0 or 127.0.0.1";
  const port = Number(form.port);
  if (!/^\d+$/.test(form.port.trim()) || port < MIN_PORT || port > MAX_PORT) errors.port = `A port between ${MIN_PORT} and ${MAX_PORT}`;
  return errors;
}

/** The pairing link pointing at `host`: its `host` parameter when it has one, else the link's own host. */
export function pairingUriFor(uri: string, host: string): string {
  try {
    const url = new URL(uri);
    if (url.searchParams.has("host")) url.searchParams.set("host", host);
    else url.hostname = host;
    return url.toString();
  } catch {
    return uri;
  }
}

/** "4:05" for the time left until `expiresAt`; null once it has passed. */
export function countdown(expiresAt: string, now = Date.now()): string | null {
  const seconds = Math.ceil((Date.parse(expiresAt) - now) / 1000);
  if (!(seconds > 0)) return null;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
