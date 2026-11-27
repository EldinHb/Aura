// {{NAME}}: the daemon half.
//
// Runs inside Aura's daemon (aurad) in a QuickJS sandbox of its own, whether
// Aura's window is open or not. There is no Node, no npm, no `fetch` and no
// `import`: everything goes through `aura`, and only as far as the
// permissions in mod.json allow. Write plain modern JavaScript (ES2022).
//
// Edit, save, and Aura reloads the mod by itself. `aura mods logs {{ID}}`
// shows what console.log wrote and any error. `aura guide mods` is the full
// reference; types/aura-mod.d.ts has every API with its types.

/** @param {Aura.DaemonApi} aura */
export default function activate(aura) {
  console.log(`{{ID}} ${aura.mod.version} started`);

  // `mod.{{ID}}.hello`: the UI half calls it with ctx.rpc("hello", {...}),
  // and you can call it from a terminal:
  //   aura mods call {{ID}} hello '{"name":"Ada"}'
  aura.rpc.handle("hello", async (params) => {
    // Storage survives restarts and belongs to this mod only.
    const count = Number((await aura.storage.kv.get("count")) ?? 0) + 1;
    await aura.storage.kv.set("count", count);
    // Tell every open window; the UI half listens with ctx.on("counted", fn).
    aura.emit("counted", { count });
    const greeting = aura.settings.get("greeting");
    return { message: `${greeting}, ${params?.name ?? "you"}! (call ${count})`, count };
  });

  aura.rpc.handle("count", async () => Number((await aura.storage.kv.get("count")) ?? 0));

  // What activate returns runs when the mod stops, reloads or is disabled.
  // Handlers registered through `aura` are removed for you; stop your own
  // timers here.
  return () => console.log("{{ID}} stopped");
}
