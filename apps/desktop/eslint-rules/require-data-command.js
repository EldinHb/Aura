/** Every JSX element with onClick must carry data-command or data-hint. */
export default {
  meta: {
    type: "problem",
    docs: { description: "Clickable elements must be reachable by keyboard hint mode / the palette" },
    schema: [],
    messages: { missing: "Clickable elements need data-command or data-hint so hint mode and the palette can reach them" },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const attrs = node.attributes.filter((a) => a.type === "JSXAttribute");
        const names = attrs.map((a) => (typeof a.name.name === "string" ? a.name.name : ""));
        if (!names.includes("onClick")) return;
        if (names.includes("data-command") || names.includes("data-hint")) return;
        context.report({ node, messageId: "missing" });
      },
    };
  },
};
