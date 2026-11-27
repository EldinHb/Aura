# Writing an Aura mod

This page is about mods in this repository, in TypeScript with the SDK, tests
and a build. A mod can also be a few plain JavaScript files with no build at
all; that form, which works on any machine with Aura installed, is described in
[docs/agents/creating-mods.md](../agents/creating-mods.md) (`aura guide mods`).

A mod adds a feature to Aura without changing Aura itself. Aura's own GitHub
and pull-request features are mods (`mods/github`, `mods/pull-requests`), so
they are the best examples of everything below. The design is in
[SPEC.md](SPEC.md); the API reference is the SDK's types in
[`packages/mod-sdk/src`](../../packages/mod-sdk/src) (`daemon.ts`, `ui.ts`,
`host.ts`).

## The two halves

| | Daemon half (`src/daemon.ts`) | UI half (`src/ui.tsx`) |
| --- | --- | --- |
| Runs | inside `aurad`, in a QuickJS runtime of its own | in Aura's window, with Aura's React |
| Lives | as long as the daemon, window open or not | while the window is open |
| May | only what `permissions` in `mod.json` allow | anything Aura's interface may (not sandboxed) |
| Gets | `aura` (`DaemonApi`) | `ctx` (`UiApi`) |

Either half is optional. Keep secrets (tokens) and background work in the
daemon half; the UI half asks it with `ctx.rpc(name, params)` and listens to
`ctx.on(name, fn)` for what the daemon half `aura.emit`s.

## A minimal mod

```
my-mod/
  mod.json
  package.json        { "devDependencies": { "@aura/mod-sdk": "…" }, "scripts": { "build": "aura-mod build ." } }
  src/daemon.ts
  src/ui.tsx
```

```jsonc
// mod.json
{
  "id": "hello",
  "name": "Hello",
  "version": "1.0.0",
  "apiVersion": 1,
  "permissions": { "sessions": "read" },
  "settings": [{ "key": "greeting", "type": "string", "label": "Greeting", "default": "Hello" }]
}
```

```ts
// src/daemon.ts
import { defineDaemon } from "@aura/mod-sdk/daemon";

export default defineDaemon((aura) => {
  let finished = 0;
  aura.events.on("turn_completed", () => {
    finished++;
    aura.emit("count", finished);
  });
  aura.rpc.handle("count", () => finished);
  aura.rpc.handle("greet", ({ name }) => `${aura.settings.get("greeting")}, ${name}!`);
});
```

```tsx
// src/ui.tsx
import { useEffect, useState } from "react";
import { defineUi, type UiApi } from "@aura/mod-sdk/ui";

function Count({ ctx }: { ctx: UiApi }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    void ctx.rpc<number>("count").then(setN);
    return ctx.on("count", setN);
  }, [ctx]);
  return <span>{n} turns finished</span>;
}

export default defineUi((ctx) => {
  ctx.ui.statusBarItem({ id: "count", component: () => <Count ctx={ctx} /> });
  ctx.commands.register({
    id: "greet",
    title: "Say hello",
    group: "Hello",
    run: async () => ctx.toast(await ctx.rpc("greet", { name: "you" })),
  });
  ctx.keys.bind({ keys: "leader h", command: "hello.greet", label: "Say hello" });
});
```

## Build, install, develop

```bash
pnpm exec aura-mod build .          # → dist/ (mod.json, daemon.js, ui.js, ui.css)
cp -r dist ~/.aura/mods/hello       # Aura finds it; approve it in Settings → Mods
```

A mod that is not bundled with Aura waits for your approval, and again whenever
an update asks for more permissions.

While developing, let `aurad` load straight from your build and reload on every
change:

```bash
pnpm exec aura-mod build . --watch
AURA_MODS_DIR=/path/to/folder-with-your-mods aurad --foreground
```

`console.log` in the daemon half goes to `aurad.log` (tagged with the mod id)
and to Settings → Mods → Log.

## Rules of the daemon half

- No Node APIs and no `fetch`: use `aura.http.fetch` (hosts must be listed in
  `permissions.net`), `aura.process.run` (programs listed in
  `permissions.process`), `aura.git.*`, and `aura.fs.*` (only inside
  `aura.mod.dataDir`).
- Everything is async; a synchronous loop that runs longer than 5 seconds is
  interrupted, and memory is capped at 256 MB.
- Store data with `aura.storage` (kv and collections) or per session with
  `aura.sessions.data(id)`; it survives restarts and is namespaced to your mod.
- Return a function from `activate` to stop loops and timers when the mod is
  disabled or reloaded.

## Testing

`@aura/mod-sdk/testing` gives an in-memory `aura` for vitest:

```ts
import { createTestHost } from "@aura/mod-sdk/testing";
import activate from "./daemon";

it("greets", async () => {
  const host = createTestHost({ id: "hello", settings: { greeting: "Hi" } });
  await host.activate(activate);
  expect(await host.call("greet", { name: "Ada" })).toBe("Hi, Ada!");
});
```

`host.http.route(...)` and `host.process.route(...)` answer requests and
programs, `host.fire(event)` delivers a core event, and `host.record` holds what
the mod emitted, notified, sent and stored.
