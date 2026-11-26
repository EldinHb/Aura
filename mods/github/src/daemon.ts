// The github mod's daemon half: the one GitHub transport every mod shares (`api.*`), the
// reads the UI half needs, and the issue and PR links of sessions. See README.md for the
// RPC surface.
import { defineDaemon, type DaemonApi } from "@aura/mod-sdk/daemon";
import { branchPull, errorData, messageOf, openIssues } from "@aura/github-client";
import { GhTransport } from "./daemon/transport";
import { githubRepo } from "./daemon/repo";
import { coded, registerLinks } from "./daemon/links";

/** Today as YYYY-MM-DD in local time, for the sprint an issue is in. */
function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * What a handler throws across RPC: GitHub's refusals keep their kind in `data` (see
 * @aura/github-client `errorData` / `reviveError`); errors that already carry a code pass as they are.
 */
export function rpcError(e: unknown): Error {
  const data = errorData(e);
  if (data) return Object.assign(new Error(messageOf(e)), { code: data.kind, data });
  if (e instanceof Error && typeof (e as { code?: unknown }).code === "string") return e;
  return Object.assign(new Error(messageOf(e)), { code: "failed" });
}

function text(params: any, key: string): string {
  const v = params?.[key];
  if (typeof v !== "string" || !v) throw coded("invalid", `${key} is required`);
  return v;
}

export function activate(aura: DaemonApi, gh = new GhTransport({ aura })) {
  const handle = (name: string, fn: (params: any) => unknown) =>
    aura.rpc.handle(name, async (params) => {
      try {
        return await fn(params ?? {});
      } catch (e) {
        throw rpcError(e);
      }
    });

  // The transport, for this mod's UI half and for other mods through remoteGithub().
  handle("api.request", (p) => {
    const method = text(p, "method");
    const path = text(p, "path");
    return typeof p.account === "string" && p.account ? gh.requestFor(p.account, method, path, p.body) : gh.request(method, path, p.body);
  });
  handle("api.diff", (p) => gh.diff(text(p, "repo"), text(p, "base"), text(p, "head")));
  handle("api.account", () => gh.account());
  handle("api.blocked", () => gh.blocked());
  handle("api.pace", (p) => gh.pace(typeof p.baseMs === "number" && p.baseMs >= 0 ? p.baseMs : 60_000));
  handle("api.notified", async () => (await gh.notified())?.toJSON() ?? null);

  // Reads for the new-session dialog and a session's branch status (former github.issues,
  // github.branch_pull and git.github_repo).
  handle("issues", (p) => openIssues(gh, text(p, "repo"), typeof p.query === "string" ? p.query : "", localToday()));
  handle("branch_pull", (p) => branchPull(gh, text(p, "repo"), text(p, "head_repo"), text(p, "branch")));
  handle("repo", (p) => githubRepo(aura.git, text(p, "cwd")));

  registerLinks(aura, handle);
  return gh;
}

export default defineDaemon((aura) => {
  activate(aura);
});
