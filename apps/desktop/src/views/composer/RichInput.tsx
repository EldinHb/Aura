import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { Selection, TextSelection } from "@tiptap/pm/state";
import { Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { composerExtensions, lineText } from "./extensions";
import type { ComposerInput } from "./input";
import { fromMarkdown, toMarkdown } from "./markdown";

type Props = {
  /** The draft as markdown. */
  value: string;
  placeholder: string;
  /** Where the caret was, as editor positions, when the draft was last edited here. */
  selection: { start: number; end: number } | null;
  /** `start`, `end`: the selection, as editor positions; `before`: the caret's line up to the caret. */
  onChange: (markdown: string, start: number, end: number, before: string) => void;
  onSelect: (start: number, end: number, before: string) => void;
  onFocus: () => void;
  /** True when the composer handled the key. */
  onKeyDown: (event: KeyboardEvent) => boolean;
  /** True when the composer took the pasted data (images). */
  onPaste: (event: ClipboardEvent) => boolean;
  inputRef: Ref<ComposerInput>;
};

/** The caret's line up to the caret: from the start of its block or its last line break. */
function lineBefore(view: EditorView): string {
  const { $from } = view.state.selection;
  return $from.parent.textBetween(0, $from.parentOffset, undefined, lineText).split("\n").pop() ?? "";
}

function caretLines(view: EditorView) {
  const { state } = view;
  const { $from, $to } = state.selection;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, lineText);
  const after = $to.parent.textBetween($to.parentOffset, $to.parent.content.size, undefined, lineText);
  return {
    before: before.split("\n").pop() ?? "",
    firstLine: $from.start() === Selection.atStart(state.doc).from && !before.includes("\n"),
    lastLine: $to.end() === Selection.atEnd(state.doc).to && !after.includes("\n"),
  };
}

/** Pasted text is markdown: it arrives formatted, and comes out again as written. */
function pasteMarkdown(editor: Editor, text: string) {
  const { view, state } = editor;
  if (state.selection.$from.parent.type.spec.code) {
    view.dispatch(state.tr.insertText(text).scrollIntoView());
    return;
  }
  const doc = state.schema.nodeFromJSON(fromMarkdown(editor, text));
  const slice = new Slice(doc.content, doc.firstChild?.isTextblock ? 1 : 0, doc.lastChild?.isTextblock ? 1 : 0);
  view.dispatch(state.tr.replaceSelection(slice).scrollIntoView());
}

/**
 * The rich composer, a Tiptap editor: markdown typed (`**`, `#`, `-`, `1.`,
 * ```` ``` ````, `>`, `` ` ``, `[text](url)`) formats as you go, as do the usual
 * shortcuts (Mod+B, Mod+I, Mod+E, ...); pasted markdown arrives formatted, and
 * every change is passed on as markdown.
 */
export function RichInput(props: Props) {
  const { value, placeholder, inputRef } = props;
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  /** The markdown last passed on, so a draft changed elsewhere can be told apart. */
  const emitted = useRef(value);

  const editor: Editor = useEditor({
    extensions: composerExtensions(() => latest.current.placeholder),
    content: value,
    contentType: "markdown",
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { role: "textbox", "aria-multiline": "true", "aria-label": "Message", "data-autofocus": "", class: "composer-rich", spellcheck: "true" },
      handleKeyDown: (_view, event) => latest.current.onKeyDown(event),
      handlePaste: (_view, event) => {
        if (latest.current.onPaste(event)) return true;
        const data = event.clipboardData;
        // Copied from this editor: ProseMirror keeps the structure itself.
        if (!data || data.getData("text/html").includes("data-pm-slice")) return false;
        const text = data.getData("text/plain");
        if (!text) return false;
        pasteMarkdown(editor, text);
        return true;
      },
      // Dropped files are the composer's (images); the editor would insert their names.
      handleDrop: (_view, event) => !!event.dataTransfer && [...event.dataTransfer.types].includes("Files"),
      clipboardTextSerializer: (slice, view): string => toMarkdown(editor, view.state.schema.topNodeType.create(null, slice.content)),
    },
    onUpdate: ({ editor }) => {
      const markdown = toMarkdown(editor);
      emitted.current = markdown;
      const { from, to } = editor.state.selection;
      latest.current.onChange(markdown, from, to, lineBefore(editor.view));
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      latest.current.onSelect(from, to, lineBefore(editor.view));
    },
    onFocus: () => latest.current.onFocus(),
  }, []);

  // Back to the caret this draft had (Tiptap's own create event comes a tick late).
  useLayoutEffect(() => {
    const { doc } = editor.state;
    const sel = latest.current.selection;
    const clamp = (n: number) => doc.resolve(Math.max(0, Math.min(n, doc.content.size)));
    const selection = sel ? TextSelection.between(clamp(sel.start), clamp(sel.end)) : Selection.atEnd(doc);
    editor.view.dispatch(editor.state.tr.setSelection(selection).setMeta("addToHistory", false));
  }, [editor]);

  // The draft changed elsewhere: history, a slash command, sending. Before the next key comes in.
  useLayoutEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    editor.commands.setTextSelection(Selection.atEnd(editor.state.doc).from);
  }, [editor, value]);

  // The placeholder is read when the editor redraws.
  useEffect(() => {
    editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
  }, [editor, placeholder]);

  useImperativeHandle(inputRef, () => ({
    element: () => editor.view.dom,
    // Now, not in a later frame as Tiptap's `focus` command does: by then a dialog may have taken the keyboard.
    focus: () => editor.view.focus(),
    caret: () => caretLines(editor.view),
    replaceBeforeCaret: (length, text) => {
      const { from } = editor.state.selection;
      editor.view.dispatch(editor.state.tr.insertText(text, Math.max(0, from - length), from).scrollIntoView());
    },
  }), [editor]);

  return <EditorContent editor={editor} className="composer-rich-wrap" />;
}
