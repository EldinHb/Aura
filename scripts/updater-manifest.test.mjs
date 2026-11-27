// node --test scripts/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildManifest, digestOf, platformOf, verifyArtifact } from "./updater-manifest.mjs";

// The assets tauri-action uploads for a release of every platform the workflow builds.
const ASSETS = [
  "Aura_0.5.0_aarch64.dmg",
  "Aura_aarch64.app.tar.gz",
  "Aura_aarch64.app.tar.gz.sig",
  "Aura_0.5.0_x64.dmg",
  "Aura_x64.app.tar.gz",
  "Aura_x64.app.tar.gz.sig",
  "Aura_0.5.0_x64-setup.exe",
  "Aura_0.5.0_x64-setup.exe.sig",
  "Aura_0.5.0_x64_en-US.msi",
  "Aura_0.5.0_x64_en-US.msi.sig",
  "Aura_0.5.0_amd64.AppImage",
  "Aura_0.5.0_amd64.AppImage.sig",
  "Aura_0.5.0_amd64.deb",
  "Aura_0.5.0_amd64.deb.sig",
  "Aura-0.5.0-1.x86_64.rpm",
  "Aura-0.5.0-1.x86_64.rpm.sig",
];
const signatures = Object.fromEntries(ASSETS.filter((a) => a.endsWith(".sig")).map((a) => [a, `sig of ${a}\n`]));
const build = (over = {}) => buildManifest({ repo: "EldinHb/Aura", tag: "v0.5.0", notes: "What's new", pubDate: "2026-11-27T00:00:00.000Z", assets: ASSETS, signatures, ...over });
const url = (name) => `https://github.com/EldinHb/Aura/releases/download/v0.5.0/${name}`;

test("maps every artifact to its platform and bundle", () => {
  assert.deepEqual(platformOf("Aura_aarch64.app.tar.gz"), { os: "darwin", arch: "aarch64", bundle: "app" });
  assert.deepEqual(platformOf("Aura_x64.app.tar.gz"), { os: "darwin", arch: "x86_64", bundle: "app" });
  assert.deepEqual(platformOf("Aura_0.5.0_x64-setup.exe"), { os: "windows", arch: "x86_64", bundle: "nsis" });
  assert.deepEqual(platformOf("Aura_0.5.0_x64_en-US.msi"), { os: "windows", arch: "x86_64", bundle: "msi" });
  assert.deepEqual(platformOf("Aura-0.5.0-1.x86_64.rpm"), { os: "linux", arch: "x86_64", bundle: "rpm" });
  assert.equal(platformOf("Aura_0.5.0_aarch64.dmg"), null);
  assert.equal(platformOf("Aura_aarch64.app.tar.gz.sig"), null);
});

test("builds one manifest for every platform", () => {
  const m = build();
  assert.equal(m.version, "0.5.0");
  assert.equal(m.notes, "What's new");
  assert.deepEqual(Object.keys(m.platforms).sort(), [
    "darwin-aarch64",
    "darwin-aarch64-app",
    "darwin-x86_64",
    "darwin-x86_64-app",
    "linux-x86_64",
    "linux-x86_64-appimage",
    "linux-x86_64-deb",
    "linux-x86_64-rpm",
    "windows-x86_64",
    "windows-x86_64-msi",
    "windows-x86_64-nsis",
  ]);
  assert.deepEqual(m.platforms["darwin-aarch64"], { signature: "sig of Aura_aarch64.app.tar.gz.sig", url: url("Aura_aarch64.app.tar.gz") });
  assert.equal(m.platforms["darwin-x86_64"].url, url("Aura_x64.app.tar.gz"));
});

test("falls back to NSIS on Windows and the AppImage on Linux, never the MSI or a package", () => {
  const m = build();
  assert.equal(m.platforms["windows-x86_64"].url, url("Aura_0.5.0_x64-setup.exe"));
  assert.equal(m.platforms["windows-x86_64-msi"].url, url("Aura_0.5.0_x64_en-US.msi"));
  assert.equal(m.platforms["linux-x86_64"].url, url("Aura_0.5.0_amd64.AppImage"));
  assert.equal(m.platforms["linux-x86_64-deb"].url, url("Aura_0.5.0_amd64.deb"));
});

test("refuses an unsigned artifact", () => {
  const { ["Aura_0.5.0_amd64.deb.sig"]: _dropped, ...rest } = signatures;
  assert.throws(() => build({ signatures: rest }), /no signature for Aura_0.5.0_amd64.deb/);
});

test("refuses a release missing a platform", () => {
  assert.throws(() => build({ assets: ASSETS.filter((a) => !a.includes("x64.app")) }), /no signed artifact for darwin-x86_64/);
});

test("refuses a blank signature", () => {
  assert.throws(() => build({ signatures: { ...signatures, "Aura_0.5.0_amd64.deb.sig": " \n\t" } }), /no signature for Aura_0.5.0_amd64.deb/);
});

// Made by `tauri signer` with a throwaway key (scripts/fixtures/updater), as the release workflow signs.
const fixture = (name) => readFileSync(new URL(`./fixtures/updater/${name}`, import.meta.url));
const pubkey = fixture("test.key.pub").toString();
const artifact = fixture("artifact.bin");
const signed = fixture("artifact.bin.v9.9.9.sig").toString();
const digest = await digestOf([artifact]);
const check = (over = {}) => verifyArtifact({ name: "artifact.bin", pubkey, signature: signed, digest, version: "9.9.9", ...over });

test("verifies a signature the Tauri CLI made, and its version", () => {
  check();
  check({ version: "v9.9.9" });
});

test("refuses a file that is not the one signed", async () => {
  const other = Buffer.from(artifact);
  other[0] ^= 1;
  assert.throws(() => check({ digest: Buffer.from(createHashOf(other)) }), /does not match the file/);
});

test("refuses a signature made for another version", () => {
  assert.throws(() => check({ version: "9.9.10" }), /signed for version 9.9.9, not 9.9.10/);
});

test("refuses a signature without a version", () => {
  assert.throws(() => check({ signature: fixture("artifact.bin.unversioned.sig").toString() }), /carries no version/);
});

test("refuses a signature by another key", () => {
  const prod = readFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8");
  assert.throws(() => check({ pubkey: JSON.parse(prod).plugins.updater.pubkey }), /not the updater key/);
});

test("refuses a tampered trusted comment", () => {
  const lines = Buffer.from(signed, "base64").toString().split("\n");
  lines[2] = lines[2].replace("version:9.9.9", "version:9.9.10");
  const tampered = Buffer.from(lines.join("\n")).toString("base64");
  assert.throws(() => check({ signature: tampered, version: "9.9.10" }), /trusted comment's signature does not match/);
});

test("refuses garbage and blank signatures", () => {
  assert.throws(() => check({ signature: "   " }), /not a minisign signature/);
  assert.throws(() => check({ signature: Buffer.from("untrusted comment: x\nAAAA\n").toString("base64") }), /malformed/);
});

function createHashOf(buf) {
  return createHash("blake2b512").update(buf).digest();
}
