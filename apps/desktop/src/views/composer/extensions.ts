import { Extension, markInputRule, type Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import Strike from "@tiptap/extension-strike";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extension-placeholder";

/**
 * How a node or mark was written (`*` or `_`, `-` or `+`, the code fence, a
 * blank line between list items), kept so it is written back the same way.
 * Never rendered.
 */
const SourceStyle = Extension.create({
  name: "sourceStyle",
  addGlobalAttributes() {
    const kept = (names: string[]) => Object.fromEntries(names.map((n) => [n, { default: null, rendered: false, keepOnSplit: true }]));
    return [
      { types: ["bold", "italic", "horizontalRule"], attributes: kept(["marker"]) },
      { types: ["codeBlock"], attributes: kept(["marker", "meta"]) },
      { types: ["bulletList", "orderedList", "taskList"], attributes: kept(["marker", "loose"]) },
    ];
  },
});

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
    return ["**", "__"].map((marker) => markInputRule({ find: emphasis(marker), type: this.type, getAttributes: { marker } }));
  },
  addPasteRules: () => [],
});
const ComposerItalic = Italic.extend({
  addInputRules() {
    return ["*", "_"].map((marker) => markInputRule({ find: emphasis(marker), type: this.type, getAttributes: { marker } }));
  },
  addPasteRules: () => [],
});
const ComposerStrike = Strike.extend({
  addInputRules() {
    return [markInputRule({ find: emphasis("~~"), type: this.type })];
  },
  addPasteRules: () => [],
});

/**
 * Shift+Enter starts a new line the way Enter does in other editors: the next
 * list item, a new line in code, else a new paragraph (a line of its own in
 * the markdown). Enter itself sends, which the composer handles before this.
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
          () => commands.createParagraphNear(),
          () => commands.liftEmptyBlock(),
          () => commands.splitBlock(),
        ]);
      },
    };
  },
});

export function composerExtensions(placeholder: () => string): Extensions {
  return [
    StarterKit.configure({
      // No markdown for these: underline, and a trailing empty line the user did not type.
      underline: false,
      trailingNode: false,
      bold: false,
      italic: false,
      strike: false,
      hardBreak: { keepMarks: true },
      link: { autolink: false, linkOnPaste: false, openOnClick: false, enableClickSelection: true },
      codeBlock: { exitOnTripleEnter: false, HTMLAttributes: { spellcheck: "false" } },
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    ComposerBold,
    ComposerItalic,
    ComposerStrike,
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder }),
    SourceStyle,
    ShiftEnter,
  ];
}
