// The pull-requests mod's daemon half: the PR inbox and PR pages, Aura's
// pre-reviews, the PR change inbox, reviewer watches and agents following up
// on review activity (former crates/aura-review and aura-git review.rs).
//
// RPC methods and notifications keep the names the Rust daemon used; see
// README.md for the full surface. GitHub is reached through the `github` mod's
// transport, so every mod shares one token, one cache and one rate limit.
import { defineDaemon } from "@aura/mod-sdk/daemon";
import type { DaemonApi } from "@aura/mod-sdk";
import { remoteGithub, type Github } from "@aura/github-client";
import { FollowService } from "./daemon/follow";
import { realLib, type Lib } from "./daemon/github";
import { Links } from "./daemon/links";
import { orchestratorMethods } from "./daemon/orchestrated";
import { ReviewService } from "./daemon/reviews";
import type { ReviewRunner } from "./daemon/runner";
import { reply, request, tools } from "./daemon/tools";
import { Tasks } from "./daemon/util";
import { WatchService } from "./daemon/watch";
import type { ReviewWorkspace } from "./daemon/workspace";

export interface Parts {
  /** The GitHub transport; by default the `github` mod's. */
  gh?: Github;
  lib?: Lib;
  workspace?: ReviewWorkspace;
  runner?: ReviewRunner;
  /** Start the refresh, watch and follow-up loops (default true). */
  loops?: boolean;
}

export type Running = Awaited<ReturnType<typeof start>>;

/** Load the services, register every method and tool, and start the loops. */
export async function start(aura: DaemonApi, parts: Parts = {}) {
  const gh = parts.gh ?? remoteGithub((name, params) => aura.mods.call("github", name, params));
  const lib = parts.lib ?? realLib;
  const tasks = new Tasks();
  const links = new Links(aura);
  const reviews = new ReviewService({ aura, gh, lib, tasks, links, workspace: parts.workspace, runner: parts.runner });
  const watches = new WatchService(aura, gh, lib, tasks);
  const follows = new FollowService(aura, gh, lib, links, tasks);
  await reviews.load();
  await watches.load();
  await follows.load();

  const methods: Record<string, (p: any) => Promise<unknown>> = {
    ...reviews.methods(),
    ...orchestratorMethods(reviews),
    ...watches.methods(),
  };
  const disposers: Array<() => void> = [];
  for (const [name, fn] of Object.entries(methods)) disposers.push(aura.rpc.handle(name, (p) => fn(p ?? {})));
  // Orchestrator tools: the host names them `pull-requests_<name>` for the agent.
  for (const def of tools()) {
    disposers.push(
      aura.orchestrator.tool(def, async (args, ctx) => {
        const [method, params] = request(def.name, ctx.sessionId, args)!;
        return reply(def.name, args, await methods[method](params));
      }),
    );
  }
  if (parts.loops !== false) {
    reviews.launch();
    watches.launch();
    disposers.push(...follows.launch());
  }
  // Muting a kind of PR change in the UI half re-filters Aura's inbox.
  disposers.push(
    aura.settings.onChange((key) => {
      if (key === "pullChangesMuted") void reviews.publishInbox();
    }),
  );
  await reviews.publishInbox();

  return {
    reviews,
    watches,
    follows,
    tasks,
    methods,
    stop() {
      tasks.stop();
      reviews.shutdown();
      for (const d of disposers) d();
    },
  };
}

export default defineDaemon(async (aura) => {
  const running = await start(aura);
  return () => running.stop();
});
