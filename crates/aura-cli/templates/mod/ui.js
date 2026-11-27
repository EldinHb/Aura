// {{NAME}}: the UI half.
//
// Runs in Aura's window with Aura's own React. It is NOT sandboxed: keep
// secrets in the daemon half. Without a build step there is no JSX and no
// `import`: React and Aura's components come from globalThis.__aura, and
// elements are made with h(type, props, ...children).
//
// Save the file and Aura reloads this UI half; the daemon half keeps running.
// Errors (with line and column) appear in `aura mods list`, in
// `aura mods logs {{ID}}` and in Settings › Mods. `aura guide mods` is the
// full reference.

const React = __aura.modules.react; // Aura's React: never load another copy
const { useEffect, useState } = React;
const h = React.createElement;

/**
 * A section at the bottom of the sidebar. Aura draws its heading from the
 * `title` given to ctx.ui.sidebarSection below; this draws only the body.
 * @param {{ ctx: Aura.UiApi, focused: boolean }} props
 */
function SidebarPanel({ ctx }) {
  const [message, setMessage] = useState(/** @type {string | null} */ (null));
  const [count, setCount] = useState(0);

//#if daemon
  // Follow what the daemon half emits, and read its state once at start.
  useEffect(() => {
    ctx.rpc("count").then(setCount).catch(() => {});
    return ctx.on("counted", (/** @type {{ count: number }} */ p) => setCount(p.count));
  }, [ctx]);
//#endif

  const sayHello = () => {
//#if daemon
    // A round trip to the daemon half: mod.{{ID}}.hello.
    ctx
      .rpc("hello", { name: "Aura" })
      .then((/** @type {{ message: string }} */ r) => setMessage(r.message))
      .catch((/** @type {Error} */ e) => ctx.toast(`{{NAME}}: ${e.message}`, "error"));
//#endif
//#if !daemon
    setCount((c) => c + 1);
    setMessage(`Hello from {{NAME}} (${count + 1})`);
//#endif
  };

  return h(
    "div",
    { className: "mod-{{ID}}" },
    h(
      "div",
      { className: "mod-{{ID}}-body" },
      h("button", { type: "button", className: "btn small", "data-hint": true, onClick: sayHello }, "Say hello"),
      h("span", { className: "dim" }, `${count} so far`),
    ),
    message && h("div", { className: "mod-{{ID}}-message" }, message),
  );
}

/**
 * A section at the top of the inspector, for the selected session.
 * @param {Aura.InspectorSectionProps} props
 */
function InspectorPanel({ session }) {
  return h(
    "div",
    { className: "inspector-section mod-{{ID}}" },
    h("h4", null, "{{NAME}}"),
    h("div", { className: "dim" }, `${session.title} · ${session.provider} · ${session.status}`),
  );
}

/** @param {Aura.UiApi} ctx */
export default function activate(ctx) {
  // `title` becomes the section's heading, like Aura's own sections.
  ctx.ui.sidebarSection({ id: "panel", title: "{{NAME}}", order: 100, component: (p) => h(SidebarPanel, { ctx, ...p }) });
  ctx.ui.inspectorSection({ id: "session", order: 100, component: InspectorPanel });

  // A command in the command palette (its id becomes "{{ID}}.hello").
  ctx.commands.register({
    id: "hello",
    title: "{{NAME}}: say hello",
    group: "{{NAME}}",
    run: async () => {
//#if daemon
      const reply = await ctx.rpc("hello", { name: "you" });
      ctx.toast(reply.message);
//#endif
//#if !daemon
      ctx.toast("Hello from {{NAME}}");
//#endif
    },
  });

  // Everything registered through ctx is removed when the mod unloads.
  // Return a function to clean up anything else.
  return () => {};
}
