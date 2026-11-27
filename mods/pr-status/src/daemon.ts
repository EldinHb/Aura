// The pr-status mod's daemon half: finds the PRs of a session tree and keeps the ones on
// screen up to date, through the github mod's shared transport. Its one write is "Squash and
// merge" (`merge`), asked for by the user.
//
// RPC (`mod.pr-status.*`), each answering a SessionView:
//   watch   {viewer, sessionId, refresh?, background?}
//                                          the viewer shows the session (a lease of LEASE_MS); with
//                                          `background` (open in a tab) it is kept, not polled → null
//   unwatch {viewer}                       → true
//   view    {sessionId}                    what is known, without reading GitHub
//   refresh {sessionId}                    collect and read every PR of the session now
//   merge.defaults {repo, number}          → MergeDefaults: the squash commit GitHub would suggest
//   merge {repo, number, sha, account, title, message, deleteBranch}
//                                          → MergeResult; as `account`, re-checks the PR, squash-merges
//                                            at head `sha`, then deletes a same-repository head branch when asked
// Notification `changed {sessionIds}`: ask `view` again for those sessions.
import { defineDaemon, type DaemonApi } from "@aura/mod-sdk/daemon";
import { remoteGithub, type Github } from "@aura/github-client";
import { Merger, mergeError, mergeRequest, readMergeDefaults } from "./daemon/merge";
import { PrPoller } from "./daemon/poller";

function text(params: any, key: string): string {
  const v = params?.[key];
  if (typeof v !== "string" || !v) throw Object.assign(new Error(`${key} is required`), { code: "invalid" });
  return v;
}

export function activate(aura: DaemonApi, opts: { gh?: Github; now?: () => number; loop?: boolean } = {}) {
  const github = (name: string, params?: unknown) => aura.mods.call<any>("github", name, params);
  const gh = opts.gh ?? remoteGithub(github);
  const poller = new PrPoller({ aura, gh, github, now: opts.now });
  const merger = new Merger(gh);

  const off = [
    aura.rpc.handle("watch", (p) => poller.watch(text(p, "viewer"), text(p, "sessionId"), p?.refresh === true, p?.background === true)),
    aura.rpc.handle("unwatch", (p) => {
      poller.unwatch(text(p, "viewer"));
      return true;
    }),
    aura.rpc.handle("view", (p) => poller.view(text(p, "sessionId"))),
    aura.rpc.handle("refresh", (p) => poller.refresh(text(p, "sessionId"))),
    aura.rpc.handle("merge.defaults", (p) => {
      if (!Number.isSafeInteger(p?.number)) throw mergeError("invalid", "number is required");
      return readMergeDefaults(gh, text(p, "repo"), p.number);
    }),
    aura.rpc.handle("merge", (p) => {
      const req = mergeRequest(p);
      return merger.merge(req, poller.statusOf(req.repo, req.number)?.merge.headSha ?? null);
    }),
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
