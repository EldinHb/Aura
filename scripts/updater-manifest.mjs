#!/usr/bin/env node
// Assemble the updater manifest (latest.json) of a GitHub release from the
// signed artifacts the build jobs uploaded into it, for tauri-plugin-updater:
//
//   GH_TOKEN=… node scripts/updater-manifest.mjs --repo OWNER/REPO --release-id ID --out latest.json
//
// The release workflow runs this once every platform has uploaded, rather than
// letting tauri-action write latest.json from each build job: those jobs run in
// parallel, and each reads, rewrites and re-uploads the file, so one can drop
// the platforms another just added. Given only a release id, tauri-action also
// leaves the notes empty and points the URLs at /latest/.
//
// Before anything is published, every artifact is downloaded and its signature
// verified against the updater public key in tauri.conf.json, including the
// version the signature was made for: the same checks the app makes, so a
// release the app would refuse never reaches it.
//
// Each platform gets a `{os}-{arch}-{bundle}` entry, which the updater picks by
// the bundle the running app was installed from (an MSI install updates with
// the MSI, an NSIS install with the NSIS installer, a .deb with the .deb), and
// a `{os}-{arch}` fallback: the NSIS installer on Windows, the AppImage on
// Linux, the .app.tar.gz on macOS.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The updater's name for an architecture in an asset name. */
function archOf(name) {
  if (/(^|[_.-])(aarch64|arm64)([_.-]|$)/.test(name)) return "aarch64";
  if (/(^|[_.-])(x64|amd64|x86_64)([_.-]|$)/.test(name)) return "x86_64";
  return null;
}

/** The platform an updater artifact installs on, from its file name (as tauri-action uploads them). */
export function platformOf(name) {
  const arch = archOf(name);
  if (!arch) return null;
  if (name.endsWith(".app.tar.gz")) return { os: "darwin", arch, bundle: "app" };
  if (name.endsWith("-setup.exe")) return { os: "windows", arch, bundle: "nsis" };
  if (name.endsWith(".msi")) return { os: "windows", arch, bundle: "msi" };
  if (name.endsWith(".AppImage")) return { os: "linux", arch, bundle: "appimage" };
  if (name.endsWith(".deb")) return { os: "linux", arch, bundle: "deb" };
  if (name.endsWith(".rpm")) return { os: "linux", arch, bundle: "rpm" };
  return null;
}

/** The lines of a base64-encoded minisign file (as Tauri writes keys and signatures). */
function minisignLines(b64, what) {
  const text = Buffer.from(String(b64).trim(), "base64").toString("utf8");
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  if (!lines[0]?.startsWith("untrusted comment:")) throw new Error(`${what} is not a minisign ${what}`);
  return lines;
}

/** The updater public key (`plugins.updater.pubkey`): its id and Ed25519 key. */
export function parsePublicKey(b64) {
  const raw = Buffer.from(minisignLines(b64, "public key")[1] ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("the public key is not an Ed25519 minisign key");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(10).toString("base64url") }, format: "jwk" });
  return { id: raw.subarray(2, 10), key };
}

/** A `.sig` file's parts. */
export function parseSignature(b64) {
  const lines = minisignLines(b64, "signature");
  const raw = Buffer.from(lines[1] ?? "", "base64");
  const trusted = lines[2] ?? "";
  if (raw.length !== 74 || !trusted.startsWith("trusted comment: ")) throw new Error("the signature is malformed");
  return {
    algorithm: raw.subarray(0, 2).toString("latin1"),
    id: raw.subarray(2, 10),
    signature: raw.subarray(10),
    trustedComment: trusted.slice("trusted comment: ".length),
    globalSignature: Buffer.from(lines[3] ?? "", "base64"),
  };
}

/** The BLAKE2b-512 digest minisign signs for a prehashed signature, of a stream of chunks. */
export async function digestOf(chunks) {
  const hash = createHash("blake2b512");
  for await (const chunk of chunks) hash.update(chunk);
  return hash.digest();
}

/**
 * Throw unless `signature` (a `.sig` file's contents) is a valid signature by
 * `pubkey` of the file whose BLAKE2b-512 digest is `digest`, made for
 * `version`: what the updater checks with requireSignedVersion on.
 */
export function verifyArtifact({ name, pubkey, signature, digest, version }) {
  const key = parsePublicKey(pubkey);
  let sig;
  try {
    sig = parseSignature(signature);
  } catch (e) {
    throw new Error(`${name}: ${e.message}`);
  }
  if (sig.algorithm !== "ED") throw new Error(`${name}: not a prehashed signature, which Tauri always makes`);
  if (!sig.id.equals(key.id)) throw new Error(`${name}: signed with key ${sig.id.toString("hex")}, not the updater key ${key.id.toString("hex")}`);
  if (!verify(null, digest, key.key, sig.signature)) throw new Error(`${name}: the signature does not match the file`);
  // The trusted comment, which carries the version, is only trustworthy once its own signature checks.
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (sig.globalSignature.length !== 64 || !verify(null, global, key.key, sig.globalSignature)) {
    throw new Error(`${name}: the trusted comment's signature does not match`);
  }
  const signed = sig.trustedComment.split("\t").find((f) => f.startsWith("version:"))?.slice("version:".length);
  if (!signed) throw new Error(`${name}: the signature carries no version (signed by a Tauri CLI before 2.12?)`);
  if (signed.replace(/^v/, "") !== version.replace(/^v/, "")) throw new Error(`${name}: signed for version ${signed}, not ${version}`);
}

/** The bundle an `{os}-{arch}` entry falls back to. */
const FALLBACK = { darwin: "app", windows: "nsis", linux: "appimage" };

/** Every platform a release must carry, so no installed copy is left without updates. */
export const REQUIRED = [
  "darwin-aarch64",
  "darwin-x86_64",
  "windows-x86_64",
  "windows-x86_64-nsis",
  "windows-x86_64-msi",
  "linux-x86_64",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
  "linux-x86_64-rpm",
];

/**
 * The manifest for release `tag` of `repo`, from its asset names and the
 * contents of their `.sig` files. Throws when an artifact has no signature or
 * a required platform is missing.
 */
export function buildManifest({ repo, tag, notes, pubDate, assets, signatures, required = REQUIRED }) {
  const version = tag.replace(/^v/, "");
  const platforms = {};
  const unsigned = [];
  for (const name of [...assets].sort()) {
    const platform = platformOf(name);
    if (!platform) continue;
    const signature = signatures[`${name}.sig`];
    if (!signature?.trim()) {
      unsigned.push(name);
      continue;
    }
    const entry = {
      signature: signature.trim(),
      url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
    };
    const { os, arch, bundle } = platform;
    platforms[`${os}-${arch}-${bundle}`] = entry;
    if (FALLBACK[os] === bundle) platforms[`${os}-${arch}`] = entry;
  }
  if (unsigned.length > 0) throw new Error(`no signature for ${unsigned.join(", ")}: is TAURI_SIGNING_PRIVATE_KEY set?`);
  const missing = required.filter((key) => !platforms[key]);
  if (missing.length > 0) throw new Error(`the release has no signed artifact for ${missing.join(", ")}`);
  return { version, notes: notes ?? "", pub_date: pubDate, platforms };
}

async function github(path, token, accept = "application/vnd.github+json") {
  const url = path.startsWith("https://") ? path : `https://api.github.com/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${await res.text()}`);
  return accept.includes("json") ? res.json() : res.text();
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const repo = arg("repo");
  const id = arg("release-id");
  const out = arg("out") ?? "latest.json";
  const config = arg("config") ?? "apps/desktop/src-tauri/tauri.conf.json";
  const pubkey = JSON.parse(readFileSync(config, "utf8")).plugins?.updater?.pubkey;
  if (!pubkey) throw new Error(`${config} has no plugins.updater.pubkey`);
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!repo || !id || !token) throw new Error("usage: GH_TOKEN=… updater-manifest.mjs --repo OWNER/REPO --release-id ID [--out latest.json]");
  const release = await github(`repos/${repo}/releases/${id}`, token);
  const assets = [];
  for (let page = 1; ; page++) {
    const batch = await github(`repos/${repo}/releases/${id}/assets?per_page=100&page=${page}`, token);
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  const signatures = {};
  for (const asset of assets.filter((a) => a.name.endsWith(".sig"))) {
    // A draft's assets only download through the API.
    signatures[asset.name] = await github(asset.url, token, "application/octet-stream");
  }
  const version = release.tag_name.replace(/^v/, "");
  for (const asset of assets.filter((a) => platformOf(a.name))) {
    const signature = signatures[`${asset.name}.sig`];
    if (!signature?.trim()) continue; // buildManifest names every unsigned artifact
    const res = await fetch(asset.url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/octet-stream" } });
    if (!res.ok || !res.body) throw new Error(`download ${asset.name}: ${res.status}`);
    verifyArtifact({ name: asset.name, pubkey, signature, digest: await digestOf(res.body), version });
    console.log(`verified ${asset.name}`);
  }
  const manifest = buildManifest({
    repo,
    tag: release.tag_name,
    notes: release.body,
    pubDate: new Date().toISOString(),
    assets: assets.map((a) => a.name),
    signatures,
  });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${out}: Aura ${manifest.version} for ${Object.keys(manifest.platforms).sort().join(", ")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}
