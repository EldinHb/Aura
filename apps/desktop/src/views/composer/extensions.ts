import { Extension, markInputRule, type Extensions } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import Strike from "@tiptap/extension-strike";
import CodeBlock from "@tiptap/extension-code-block";
import HardBreak from "@tiptap/extension-hard-break";
import Image from "@tiptap/extension-image";
import { Link } from "@tiptap/extension-link";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { destination, title } from "./markdown";

/**
 * `**bold**`, `*em*`, `~~gone~~` format as they are typed only where markdown
 * would format them: the delimiters next to the words, not to spaces. Tiptap's
 * own rules also take `2 * 3 * 4`, which would then not be sent as typed.
 * Pasted text is parsed as markdown (see `RichInput`), so there are no paste rules.
 */
const emphasis = (delim: string) => {
  const d = delim.replace(/[*]/g, "\\*");
  const c = delim[0] === "*" ? "\\*" : delim[0];
  return new RegExp(`(?:^|\\s)(${d}(?![\\s${c}])([^${c}]*[^\\s${c}])${d})$`);
};
const ComposerBold = Bold.extend({
  addInputRules() {
    return ["**", "__"].map((marker) => markInputRule({ find: emphasis(marker), type: this.type }));
  },
  addPasteRules: () => [],
});
const ComposerItalic = Italic.extend({
  addInputRules() {
    return ["*", "_"].map((marker) => markInputRule({ find: emphasis(marker), type: this.type }));
  },
  addPasteRules: () => [],
});
const ComposerStrike = Strike.extend({
  addInputRules() {
    return [markInputRule({ find: emphasis("~~"), type: this.type })];
  },
  addPasteRules: () => [],
});

/** A link that is its own address goes out as the bare address, as it was typed; others with a destination and title that read back. */
const ComposerLink = Link.extend({
  renderMarkdown(node, h, ctx) {
    const href = String(node.attrs?.href ?? "");
    const text = (ctx?.meta?.markText as string | undefined) ?? h.renderChildren(node);
    const bare = text === href || `http://${text}` === href || `mailto:${text}` === href;
    if (bare && destination(href) === href) return h.renderChildren(node);
    const t = node.attrs?.title;
    return `[${h.renderChildren(node)}](${destination(href)}${t ? ` ${title(String(t))}` : ""})`;
  },
});

/** A line break is a newline in the markdown, as typed in the markdown textbox (see `fromMarkdown`). */
const ComposerHardBreak = HardBreak.extend({
  renderMarkdown: () => "\n",
});

/** A fence longer than any run of backticks in the code, so a fence inside it stays code. */
const ComposerCodeBlock = CodeBlock.extend({
  renderMarkdown(node, h) {
    const code = node.content ? h.renderChildren(node.content) : "";
    const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${fence}${node.attrs?.language ?? ""}\n${code || ""}\n${fence}`;
  },
});

/**
 * Markdown images stay what they are in a message, a reference: shown as their
 * markdown rather than loaded (a path the agent can read is not one the app can).
 */
const ImageReference = Image.extend({
  parseHTML() {
    return [
      ...(this.parent?.() ?? []),
      { tag: "span[data-image-src]", getAttrs: (el: HTMLElement) => ({ src: el.dataset.imageSrc, alt: el.dataset.imageAlt || null, title: el.dataset.imageTitle || null }) },
    ];
  },
  renderHTML({ node }) {
    const { src, alt, title } = node.attrs as { src: string; alt: string | null; title: string | null };
    return ["span", { class: "composer-image-ref", "data-image-src": src, "data-image-alt": alt ?? "", "data-image-title": title ?? "", title: src }, `![${alt ?? ""}](${src})`];
  },
  renderMarkdown(node) {
    const { src, alt, title: t } = (node.attrs ?? {}) as { src?: string; alt?: string | null; title?: string | null };
    return `![${(alt ?? "").replace(/[\\[\]]/g, "\\$&")}](${destination(src ?? "")}${t ? ` ${title(t)}` : ""})`;
  },
}).configure({ inline: true });

/**
 * Shift+Enter starts a new line, as in the markdown textbox: a line break in a
 * paragraph (`\n` in the markdown), and a second one in a row a blank line, that
 * is a new paragraph. In a list it starts the next item, in code a new code
 * line. Enter itself sends, which the composer handles before this.
 */
const ShiftEnter = Extension.create({
  name: "shiftEnter",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      "Shift-Enter": ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if ($from.parent.type.name === "codeBlock") {
          // Two empty lines at the end of a code block leave it, as in Tiptap's own Enter.
          const atEnd = $from.parentOffset === $from.parent.nodeSize - 2;
          if (empty && atEnd && $from.parent.textContent.endsWith("\n\n")) {
            return editor.chain().command(({ tr }) => { tr.delete($from.pos - 2, $from.pos); return true; }).exitCode().run();
          }
          return editor.commands.newlineInCode();
        }
        return editor.commands.first(({ commands }) => [
          () => commands.splitListItem("taskItem", { checked: false }),
          () => commands.splitListItem("listItem"),
          ({ tr }) => {
            if ($from.parent.type.name !== "paragraph") return false;
            // A table cell keeps to its line of the table: a line break in it is a `<br>`.
            if (["tableCell", "tableHeader"].includes($from.node(-1)?.type.name)) return commands.setHardBreak();
            // In a list, an empty item leaves the list (below).
            if (["listItem", "taskItem"].includes($from.node(-1)?.type.name)) return false;
            if (empty && $from.nodeBefore?.type.name === "hardBreak") {
              tr.delete($from.pos - 1, $from.pos);
              return commands.splitBlock();
            }
            if (empty && $from.parentOffset === 0) return commands.splitBlock();
            return commands.setHardBreak();
          },
          () => commands.createParagraphNear(),
          () => commands.liftEmptyBlock(),
          () => commands.splitBlock(),
        ]);
      },
    };
  },
});

/** A line break as text, other inline nodes as one character, so offsets in the text are positions in the paragraph. */
export const lineText = (node: PMNode) => (node.type.name === "hardBreak" ? "\n" : "\ufffc");

/**
 * What starts a block after a line break: what interrupts a paragraph in
 * markdown (`# `, `- `, `* `, `+ `, `> `, a fence, a `***` or `___` rule, and of
 * ordered lists only `1. `) and the editor has a rule for. `2020. ` and `---`
 * there do not (`---` under a line makes it a heading).
 */
const blockTrigger = /^(?:[ \t]{0,3}[-+*>]\s|1\.\s|#{1,6}\s|```[a-z]*\s|~~~[a-z]*\s|___\s|\*\*\*\s)$/;

/** Where the line break was that a block typed after it replaced, until the next change. */
const lineStartKey = new PluginKey<{ at: number } | null>("lineStartBlocks");

/**
 * Typed at the start of a line made with Shift+Enter, those start the block
 * too, as they would in the markdown: the paragraph splits there, so the
 * editor's own rules apply. Backspace right after takes it back to the line
 * break and the text typed, in one step.
 */
const LineStartBlocks = Extension.create({
  name: "lineStartBlocks",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const made = lineStartKey.getState(editor.state);
        if (!made) return false;
        return editor
          .chain()
          .undoInputRule()
          .command(({ tr }) => {
            tr.join(made.at + 1).insert(made.at, tr.doc.type.schema.nodes.hardBreak.create());
            return true;
          })
          .run();
      },
    };
  },
  addProseMirrorPlugins() {
    let again = false;
    return [
      new Plugin({
        key: lineStartKey,
        state: {
          init: () => null,
          apply: (tr, made: { at: number } | null) => {
            const meta = tr.getMeta(lineStartKey) as { at: number } | undefined;
            if (meta) return meta;
            return tr.docChanged || tr.selectionSet ? null : made;
          },
        },
        props: {
          handleTextInput(view, from, to, text) {
            const { $from } = view.state.selection;
            if (again || $from.parent.type.name !== "paragraph" || from !== to) return false;
            const before = $from.parent.textBetween(0, $from.parentOffset, undefined, lineText);
            const nl = before.lastIndexOf("\n");
            if (nl < 0 || !blockTrigger.test(before.slice(nl + 1) + text)) return false;
            const at = $from.start() + nl;
            view.dispatch(view.state.tr.delete(at, at + 1).split(at));
            const pos = view.state.selection.from;
            again = true;
            let formatted = false;
            try {
              formatted = !!view.someProp("handleTextInput", (f) => f(view, pos, pos, text, () => view.state.tr.insertText(text, pos, pos)));
            } finally {
              again = false;
            }
            if (formatted) {
              view.dispatch(view.state.tr.setMeta(lineStartKey, { at }));
            } else {
              // No rule took it: the line break back, and the text typed.
              const tr = view.state.tr.join(at + 1).insert(at, view.state.schema.nodes.hardBreak.create());
              view.dispatch(tr.insertText(text, tr.mapping.map(pos)));
            }
            return true;
          },
        },
      }),
    ];
  },
});

export function composerExtensions(placeholder: () => string): Extensions {
  return [
    StarterKit.configure({
      // No markdown for underline, nor for a trailing empty line the user did not type.
      underline: false,
      trailingNode: false,
      bold: false,
      italic: false,
      strike: false,
      link: false,
      codeBlock: false,
      hardBreak: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    ComposerBold,
    ComposerItalic,
    ComposerStrike,
    ComposerLink.configure({ openOnClick: false, enableClickSelection: true }),
    ComposerCodeBlock.configure({ exitOnTripleEnter: false, HTMLAttributes: { spellcheck: "false" } }),
    ComposerHardBreak.configure({ keepMarks: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    ImageReference,
    Placeholder.configure({ placeholder }),
    Markdown,
    ShiftEnter,
    LineStartBlocks,
  ];
}
