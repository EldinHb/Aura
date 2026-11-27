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
// Each platform gets a `{os}-{arch}-{bundle}` entry, which the updater picks by
// the bundle the running app was installed from (an MSI install updates with
// the MSI, an NSIS install with the NSIS installer, a .deb with the .deb), and
// a `{os}-{arch}` fallback: the NSIS installer on Windows, the AppImage on
// Linux, the .app.tar.gz on macOS.
import { writeFileSync } from "node:fs";
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
    if (!signature) {
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
