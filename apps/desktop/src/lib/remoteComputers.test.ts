import { describe, expect, it } from "vitest";
import { describeState, formatFingerprint, needsPairing, normalizeFingerprint, parsePairingLink } from "./remoteComputers";

const fp = "ab".repeat(32);

describe("parsePairingLink", () => {
  it("reads the daemon's link, alternatives decoded and unbracketed", () => {
    const link = `aura://pair?host=192.168.1.20&port=7443&fp=${fp}&code=K7QM2XRA&name=Studio%20Mac&alt=100.75.1.9%2C%5B2001%3Adb8%3A%3A5%5D`;
    expect(parsePairingLink(link)).toEqual({ host: "192.168.1.20", port: 7443, fingerprint: fp, code: "K7QM2XRA", name: "Studio Mac", alt: ["100.75.1.9", "2001:db8::5"] });
  });

  it("takes an IPv6 host, and no alt", () => {
    const l = parsePairingLink(`  aura://pair?host=2001%3Adb8%3A%3A5&port=9000&fp=${fp.toUpperCase()}&code=abcd-efgh&name=x  `);
    expect(l.host).toBe("2001:db8::5");
    expect(l.port).toBe(9000);
    expect(l.fingerprint).toBe(fp);
    expect(l.alt).toEqual([]);
  });

  it("says what is wrong", () => {
    expect(() => parsePairingLink("https://example.com")).toThrow("starts with aura://pair?");
    expect(() => parsePairingLink(`aura://pair?port=7443&fp=${fp}&code=X`)).toThrow("no host");
    expect(() => parsePairingLink(`aura://pair?host=h&port=0&fp=${fp}&code=X`)).toThrow("port");
    expect(() => parsePairingLink(`aura://pair?host=h&port=7443&fp=abc&code=X`)).toThrow("fingerprint");
    expect(() => parsePairingLink(`aura://pair?host=h&port=7443&fp=${fp}`)).toThrow("pairing code");
  });
});

it("normalizes and formats fingerprints", () => {
  expect(normalizeFingerprint(fp.toUpperCase().match(/../g)!.join(":"))).toBe(fp);
  expect(normalizeFingerprint("xyz")).toBeNull();
  expect(formatFingerprint("abcdef0123")).toBe("abcd ef01 23");
});

it("describes each state; revoked and a changed certificate need pairing again", () => {
  expect(describeState({ kind: "online", serverName: "S", version: "0.6.3" })).toBe("Connected · Aura 0.6.3");
  expect(describeState({ kind: "retrying", reason: "refused", retryAt: 10_500 }, 1_000)).toBe("Unreachable: refused · retrying in 10s");
  expect(describeState({ kind: "cert_mismatch", expected: "a", actual: "b" })).toMatch(/certificate changed/);
  expect(needsPairing({ kind: "revoked", reason: "" })).toBe(true);
  expect(needsPairing({ kind: "cert_mismatch", expected: "a", actual: "b" })).toBe(true);
  expect(needsPairing({ kind: "retrying", reason: "", retryAt: 0 })).toBe(false);
});
