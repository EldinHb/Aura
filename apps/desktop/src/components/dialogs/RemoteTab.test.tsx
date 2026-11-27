import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../../lib/rpc";
import type { RemoteDevice, RemoteStatus } from "../../gen";
import { countdown, pairingUriFor, validateRemoteForm } from "../../lib/remote";
import { useStore } from "../../state/store";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,AAAA") } }));

let status: RemoteStatus;
let devices: RemoteDevice[];
const remoteConfigure = vi.fn(async (config: Partial<RemoteStatus>) => {
  status = { ...status, ...config };
  return status;
});
const remoteRevokeDevice = vi.fn(async (id: string) => {
  devices = devices.filter((d) => d.deviceId !== id);
  return true;
});

const remoteStartPairing = vi.fn(async () => ({
  code: "ABCD2345",
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  uri: "aura://pair?host=192.168.1.5&port=7443&fp=abcdef&code=ABCD2345&name=Studio%20Mac",
  fingerprint: "abcdef",
  addresses: ["192.168.1.5", "10.0.0.7"],
}));

beforeEach(() => {
  status = { enabled: true, bindAddress: "0.0.0.0", port: 7443, serverName: "Studio", serverId: "s1", fingerprint: "abcdef", listening: true, error: null, addresses: ["192.168.1.5"] };
  devices = [{ deviceId: "d1", name: "Pixel 9", pairedAt: "2026-11-01T10:00:00Z", lastSeenAt: null, lastAddress: null }];
  remoteConfigure.mockClear();
  remoteRevokeDevice.mockClear();
  useStore.setState({
    client: {
      remoteStatus: () => Promise.resolve(status),
      remoteListDevices: () => Promise.resolve(devices),
      remoteConfigure,
      remoteRevokeDevice,
      remoteStartPairing,
    } as unknown as RpcClient,
  });
});
afterEach(cleanup);

it("validates the form: a name, an address and a port from 1024 to 65535", () => {
  const ok = { serverName: "Studio", bindAddress: "127.0.0.1", port: "7443" };
  expect(validateRemoteForm(ok)).toEqual({});
  expect(validateRemoteForm({ ...ok, serverName: " " }).serverName).toBeTruthy();
  for (const bindAddress of ["", "localhost", "300.1.1.1", "1.2.3"]) expect(validateRemoteForm({ ...ok, bindAddress }).bindAddress).toBeTruthy();
  for (const bindAddress of ["0.0.0.0", "::1", "fe80::1"]) expect(validateRemoteForm({ ...ok, bindAddress }).bindAddress).toBeUndefined();
  expect(validateRemoteForm({ ...ok, serverName: "x".repeat(65) }).serverName).toBeTruthy();
  for (const port of ["1023", "65536", "", "80x", "1.5", "-1"]) expect(validateRemoteForm({ ...ok, port }).port).toBeTruthy();
  for (const port of ["1024", "65535"]) expect(validateRemoteForm({ ...ok, port }).port).toBeUndefined();
});

it("points the pairing link at the chosen address and counts down to expiry", () => {
  const link = new URL(pairingUriFor("aura://pair?host=10.0.0.2&port=7443&fp=abcdef&code=ABCD2345&name=Studio%20Mac", "fe80::1"));
  expect(Object.fromEntries(link.searchParams)).toEqual({ host: "fe80::1", port: "7443", fp: "abcdef", code: "ABCD2345", name: "Studio Mac" });
  expect(countdown("2026-11-28T10:05:00Z", Date.parse("2026-11-28T10:00:55Z"))).toBe("4:05");
  expect(countdown("2026-11-28T10:05:00Z", Date.parse("2026-11-28T10:05:00Z"))).toBeNull();
});

it("shows the status and fingerprint, and keeps Save off until the form is valid and changed", async () => {
  render(<SettingsDialog tab="remote" />);
  await screen.findByText("Listening on 0.0.0.0:7443");
  expect(screen.getByText("abcdef")).toBeTruthy();
  const save = screen.getByText("Save") as HTMLButtonElement;
  expect(save.disabled).toBe(true);

  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "80" } });
  expect(screen.getByText("A port between 1024 and 65535")).toBeTruthy();
  expect(save.disabled).toBe(true);

  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "8443" } });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() => expect(remoteConfigure).toHaveBeenCalledWith({ serverName: "Studio", bindAddress: "0.0.0.0", port: 8443 }));
});

it("turns remote access off straight away", async () => {
  render(<SettingsDialog tab="remote" />);
  fireEvent.click(await screen.findByLabelText("Allow remote clients"));
  await waitFor(() => expect(remoteConfigure).toHaveBeenCalledWith({ enabled: false }));
  await screen.findByText("Off");
});

it("revokes a device only after confirming", async () => {
  render(<SettingsDialog tab="remote" />);
  await screen.findByText("Pixel 9");
  expect(screen.getByText(/never connected/)).toBeTruthy();
  fireEvent.click(screen.getByText("Revoke…"));
  expect(remoteRevokeDevice).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Revoke"));
  await waitFor(() => expect(screen.queryByText("Pixel 9")).toBeNull());
  expect(remoteRevokeDevice).toHaveBeenCalledWith("d1");
  expect(screen.getByText("No devices paired yet.")).toBeTruthy();
});

it("pairs a device: code, QR, expiry and a link for the chosen address", async () => {
  render(<SettingsDialog tab="remote" />);
  fireEvent.click(await screen.findByText("Pair a device…"));
  await screen.findByText("ABCD2345");
  await screen.findByAltText("QR code with the pairing link");
  expect(screen.getByText(/Expires in/)).toBeTruthy();
  expect((screen.getByLabelText("Pairing link") as HTMLInputElement).value).toContain("host=192.168.1.5");
  fireEvent.change(screen.getByLabelText("Address the device connects to"), { target: { value: "10.0.0.7" } });
  expect((screen.getByLabelText("Pairing link") as HTMLInputElement).value).toContain("host=10.0.0.7");
  fireEvent.click(screen.getByText("New code"));
  await waitFor(() => expect(remoteStartPairing).toHaveBeenCalledTimes(2));
});

it("shows a refused change inline and keeps the form", async () => {
  remoteConfigure.mockRejectedValueOnce(new Error("port 7443 is taken"));
  render(<SettingsDialog tab="remote" />);
  fireEvent.click(await screen.findByLabelText("Allow remote clients"));
  expect((await screen.findByRole("alert")).textContent).toContain("port 7443 is taken");
});

it("says so when the certificate does not exist yet", async () => {
  status = { ...status, enabled: false, listening: false, fingerprint: null };
  render(<SettingsDialog tab="remote" />);
  await screen.findByText("Made the first time you allow remote clients");
  expect((screen.getByText("Pair a device…") as HTMLButtonElement).disabled).toBe(true);
});

it("shows why a pairing code could not be made", async () => {
  remoteStartPairing.mockRejectedValueOnce(new Error("remote access is off"));
  render(<SettingsDialog tab="remote" />);
  fireEvent.click(await screen.findByText("Pair a device…"));
  await screen.findByText("remote access is off");
});
