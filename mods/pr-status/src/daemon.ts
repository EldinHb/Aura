// The pr-status mod's daemon half: finds the PRs of a session tree and keeps the ones on
// screen up to date. Read-only on GitHub, through the github mod's shared transport.
//
// RPC (`mod.pr-status.*`), each answering a SessionView:
//   watch   {viewer, sessionId, refresh?}  the viewer shows the session (a lease of LEASE_MS)
//   unwatch {viewer}                       → true
//   view    {sessionId}                    what is known, without reading GitHub
//   refresh {sessionId}                    collect and read every PR of the session now
// Notification `changed {sessionIds}`: ask `view` again for those sessions.
import { defineDaemon, type DaemonApi } from "@aura/mod-sdk/daemon";
import { remoteGithub, type Github } from "@aura/github-client";
import { PrPoller } from "./daemon/poller";

function text(params: any, key: string): string {
  const v = params?.[key];
  if (typeof v !== "string" || !v) throw Object.assign(new Error(`${key} is required`), { code: "invalid" });
  return v;
}

export function activate(aura: DaemonApi, opts: { gh?: Github; now?: () => number; loop?: boolean } = {}) {
  const github = (name: string, params?: unknown) => aura.mods.call<any>("github", name, params);
  const poller = new PrPoller({ aura, gh: opts.gh ?? remoteGithub(github), github, now: opts.now });

  const off = [
    aura.rpc.handle("watch", (p) => poller.watch(text(p, "viewer"), text(p, "sessionId"), p?.refresh === true)),
    aura.rpc.handle("unwatch", (p) => {
      poller.unwatch(text(p, "viewer"));
      return true;
    }),
    aura.rpc.handle("view", (p) => poller.view(text(p, "sessionId"))),
    aura.rpc.handle("refresh", (p) => poller.refresh(text(p, "sessionId"))),
    // A new worker, a finished turn (it may have pushed or opened a PR) or changed links
    // can change which PRs a tree has.
    aura.events.on("session_created", () => poller.invalidate()),
    aura.events.on("session_removed", (e) => poller.forgetSession(e.session_id)),
    aura.events.on("turn_completed", () => poller.invalidate()),
    aura.mods.on("github", "links.changed", () => poller.invalidate()),
  ];
  if (opts.loop !== false) off.push(poller.launch());
  return { poller, dispose: () => off.forEach((d) => d()) };
}

export default defineDaemon((aura) => activate(aura).dispose);
