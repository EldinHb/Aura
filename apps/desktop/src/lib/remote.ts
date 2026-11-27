/** Helpers for the daemon's local-only `remote.*` methods (remote clients: the Android app); the types are in `../gen`. */

/** The daemon takes 1–65535; below 1024 needs privileges, so the page asks for 1024 and up. */
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

const MAX_NAME = 64;

export type RemoteForm = { serverName: string; bindAddress: string; port: string };

export type RemoteFormErrors = Partial<Record<keyof RemoteForm, string>>;

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** An IPv4 address, or something that looks like IPv6 (the daemon has the last word). */
function isIpAddress(value: string): boolean {
  return IPV4.test(value) || (value.includes(":") && /^[0-9a-fA-F:.]+$/.test(value));
}

/** What is wrong with the form, per field; empty when it can be saved. */
export function validateRemoteForm(form: RemoteForm): RemoteFormErrors {
  const errors: RemoteFormErrors = {};
  const name = form.serverName.trim();
  if (!name) errors.serverName = "Give this computer a name";
  else if (name.length > MAX_NAME) errors.serverName = `At most ${MAX_NAME} characters`;
  if (!isIpAddress(form.bindAddress.trim())) errors.bindAddress = "Enter an IP address, such as 0.0.0.0 or 127.0.0.1";
  const port = Number(form.port);
  if (!/^\d+$/.test(form.port.trim()) || port < MIN_PORT || port > MAX_PORT) errors.port = `A port between ${MIN_PORT} and ${MAX_PORT}`;
  return errors;
}

/** The pairing link (`aura://pair?host=…&port=…&fp=…&code=…&name=…`) pointing at `host`; the other parameters stay as they are. */
export function pairingUriFor(uri: string, host: string): string {
  try {
    const url = new URL(uri);
    url.searchParams.set("host", host);
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
