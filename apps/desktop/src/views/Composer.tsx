import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { SlashCommand } from "../gen";
import { useStore } from "../state/store";
import { setFocus } from "../commands/core";
import { formatKeys } from "../lib/keymap";
import { isMac } from "../lib/platform";
import { folderOf } from "../lib/sessionFolder";
import { filterSlashCommands, mergeSlashCommands, mentionQuery, slashQuery, type SlashEntry } from "./transcript/slash";
import { fmtTokens, fmtUsd } from "./transcript/format";
import { useQuestionKey } from "./transcript/questionKey";
import { acpSessionInfo, acpSlashCommands, sessionProviderLabel } from "../lib/acp";
import { fmtSize, imageCaption, imageLimits, imageSupport, planFor, planNote, prepareImage, toImageInput, type DraftImage } from "../lib/images";
import { emptyDraft, updateDraft, useComposerDrafts } from "../state/composerDrafts";
import { ImageThumb } from "./ImageThumbs";
import type { ComposerInput, KeyLike } from "./composer/input";
import { toggleRichComposer } from "./composer/toggle";

/** Sent-message history per session (survives remounts, not reloads). */
const history = new Map<string, string[]>();
/**
 * Per session, the messages on their way out. They go one after another, so they arrive in the order sent; once one
 * fails, the ones behind it are held back, and when the last has settled they all come back into the box, in order.
 */
type Outbox = { last: Promise<void>; waiting: number; failed: { text: string; images: DraftImage[] }[] };
const outboxes = new Map<string, Outbox>();
const slashCache = new Map<string, { at: number; entries: SlashCommand[] }>();

type Popover =
  | { kind: "none" }
  | { kind: "slash"; query: string; idx: number }
  | { kind: "mention"; query: string; idx: number; results: string[] };

/**
 * The rich editor is a chunk of its own (ProseMirror is most of its size),
 * loaded as the app starts; until it is there the composer is the markdown textbox.
 */
let richInput: typeof import("./composer/RichInput").RichInput | null = null;
export const richInputReady = import("./composer/RichInput").then((m) => {
  richInput = m.RichInput;
});

/** The line `value` has up to `caret`. */
const lineUpTo = (value: string, caret: number) => value.slice(value.lastIndexOf("\n", caret - 1) + 1, caret);

const isImageFile = (f: File) => f.type.startsWith("image/") || (!f.type && /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i.test(f.name));
const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");

export function Composer({ sessionId }: { sessionId: string }) {
  const client = useStore((s) => s.client);
  const session = useStore((s) => s.sessions[sessionId]);
  const provider = useStore((s) => s.providers.find((p) => p.kind === session?.provider));
  const agentName = useStore((s) => (session ? sessionProviderLabel(session, s.providers) : "This agent"));
  const acpInfo = useStore((s) => acpSessionInfo(s.transcripts[sessionId]?.providerInfo));
  const toast = useStore((s) => s.toast);
  const openDialog = useStore((s) => s.openDialog);
  // A question card never takes the keyboard from here; while one waits, the hint row says how to get to it.
  const questionWaiting = useStore((s) => Object.keys(s.transcripts[sessionId]?.inputs ?? {}).length > 0 && s.focus === "composer");
  const questionKey = useQuestionKey();
  const [RichInput, setRichInput] = useState(() => richInput);
  const rich = useStore((s) => s.settings.composerRich) && RichInput !== null;
  useEffect(() => {
    if (!RichInput) void richInputReady.then(() => setRichInput(() => richInput));
  }, [RichInput]);
  const { text, images, sending } = useComposerDrafts((s) => s.drafts[sessionId] ?? emptyDraft);
  const setText = (value: string) => updateDraft(sessionId, () => ({ text: value, start: value.length, end: value.length }));
  const setImages = (value: (images: DraftImage[]) => DraftImage[]) => updateDraft(sessionId, (draft) => ({ images: value(draft.images) }));
  const [pop, setPop] = useState<Popover>({ kind: "none" });
  const [slashEntries, setSlashEntries] = useState<SlashEntry[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const historyDraft = useRef("");
  const [dragging, setDragging] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const richRef = useRef<ComposerInput>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const caps = provider?.capabilities;
  const running = session?.status === "running";
  const errored = session?.status === "error";
  const canSteer = !!caps?.steer && running;
  const imageSupported = imageSupport(caps, acpInfo, agentName);
  const limits = imageLimits(session?.provider);

  useLayoutEffect(() => {
    const draft = useComposerDrafts.getState().drafts[sessionId] ?? emptyDraft;
    if (draft.richSelection) taRef.current?.setSelectionRange(draft.text.length, draft.text.length);
    else taRef.current?.setSelectionRange(draft.start, draft.end);
  }, [sessionId, rich]);
  useEffect(() => () => { if (mentionTimer.current) clearTimeout(mentionTimer.current); }, []);

  // auto-grow
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const lineH = 19;
    ta.style.height = `${Math.min(ta.scrollHeight, lineH * 8 + 16)}px`;
  }, [text, rich]);

  // The markdown textbox as a `ComposerInput`; the rich editor provides its own.
  const textareaInput = useMemo<ComposerInput>(() => ({
    element: () => taRef.current,
    focus: () => taRef.current?.focus(),
    caret: () => {
      const ta = taRef.current;
      const value = ta?.value ?? "";
      const at = ta?.selectionStart ?? value.length;
      return { before: lineUpTo(value, at), firstLine: !value.slice(0, at).includes("\n"), lastLine: !value.slice(ta?.selectionEnd ?? at).includes("\n") };
    },
    replaceBeforeCaret: (length, insert) => {
      const ta = taRef.current;
      if (!ta) return;
      const at = ta.selectionStart;
      const from = Math.max(0, at - length);
      const value = ta.value.slice(0, from) + insert + ta.value.slice(at);
      updateDraft(sessionId, () => ({ text: value, start: value.length, end: value.length }));
      requestAnimationFrame(() => ta.setSelectionRange(from + insert.length, from + insert.length));
    },
  }), [sessionId]);
  const input = () => (rich ? richRef.current : textareaInput);
  const inputNow = useRef(input);
  useLayoutEffect(() => {
    inputNow.current = input;
  });

  /**
   * The app's focus (`focus` in the store, which the region outline shows) says
   * where the keyboard is; when it says the composer, the keyboard is in the box.
   * Moved elsewhere in the app, the app's focus follows it. Lost to the page
   * (the field went away or stopped taking it), the box takes it back.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const lost = () => !document.activeElement || document.activeElement === document.body;
    const takeBack = () => {
      const st = useStore.getState();
      if (st.focus === "composer" && lost() && document.hasFocus() && st.dialog.kind === "none" && !st.paletteOpen && !st.hintMode) inputNow.current()?.focus();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      const st = useStore.getState();
      if (st.focus !== "composer" || !el || root.contains(el)) return;
      const region = el.closest<HTMLElement>("[data-region]")?.dataset.region;
      if (region === "sidebar" || region === "main" || region === "inspector") st.setFocus(region);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (!e.relatedTarget) requestAnimationFrame(takeBack);
    };
    // Mounted with the app's focus here (another session, the other mode of the box): the keyboard comes along.
    const frame = requestAnimationFrame(takeBack);
    document.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
    };
  }, [sessionId]);

  // slash commands catalogue
  useEffect(() => {
    if (pop.kind !== "slash" || !client || !session) return;
    const cached = slashCache.get(sessionId);
    const apply = (list: SlashCommand[]) => setSlashEntries(mergeSlashCommands(session.provider, list));
    // ACP agents announce their commands in the session itself.
    if (session.provider === "acp") {
      apply(acpSlashCommands(acpInfo));
      return;
    }
    if (cached && Date.now() - cached.at < 60_000) {
      apply(cached.entries);
      return;
    }
    apply([]);
    client
      .commands(session.provider, session.cwd)
      .then((list) => {
        slashCache.set(sessionId, { at: Date.now(), entries: list });
        apply(list);
      })
      .catch(() => {});
  }, [pop.kind, client, session, sessionId, acpInfo]);

  const slashResults = useMemo(() => (pop.kind === "slash" ? filterSlashCommands(slashEntries, pop.query, 12) : []), [pop, slashEntries]);

  /** `before`: the caret's line up to the caret. */
  const updatePopover = useCallback(
    (value: string, before: string) => {
      const sq = slashQuery(value);
      if (sq !== null && caps?.slash_commands !== false) {
        setPop((p) => ({ kind: "slash", query: sq, idx: p.kind === "slash" ? Math.min(p.idx, 11) : 0 }));
        return;
      }
      // An orchestrator without a folder has no files to mention.
      const mq = session && folderOf(session) !== null ? mentionQuery(before, before.length) : null;
      if (mq && client && session) {
        setPop((p) => ({ kind: "mention", query: mq.query, idx: p.kind === "mention" ? p.idx : 0, results: p.kind === "mention" ? p.results : [] }));
        if (mentionTimer.current) clearTimeout(mentionTimer.current);
        mentionTimer.current = setTimeout(() => {
          client
            .searchFiles(session.cwd, mq.query, 30)
            .then((results) => setPop((p) => (p.kind === "mention" ? { ...p, results, idx: Math.min(p.idx, Math.max(0, results.length - 1)) } : p)))
            .catch(() => {});
        }, 120);
        return;
      }
      setPop({ kind: "none" });
    },
    [caps, client, session],
  );

  /**
   * The box empties at once and stays as it is, editable and with the keyboard,
   * so the next message can be typed while this one goes out. It used to be
   * disabled while sending: the rich editor, switched off and on again while
   * focused (within milliseconds, as the daemon answers), kept the focus in
   * WebKit but took no more typing until it was focused anew; and a slow send
   * dropped the keyboard to the page, where letters are shortcuts. A message
   * that fails comes back into the box, ahead of anything typed since.
   */
  const send = async (steer: boolean) => {
    if (!client || !session) return;
    const body = text.trim();
    if (!body && images.length === 0) return;
    if (images.length > 0 && !imageSupported.ok) {
      toast(`${imageSupported.reason}; remove the images to send`, "warn");
      return;
    }
    const blocked = images.map((img) => planFor(img, limits)).find((plan) => plan.kind === "blocked");
    if (blocked?.kind === "blocked") {
      toast(`${blocked.reason}; remove it to send`, "warn");
      return;
    }
    const message = { text, images };
    updateDraft(sessionId, (draft) => ({ text: "", start: 0, end: 0, richSelection: false, images: [], sending: draft.sending + 1 }));
    setHistIdx(null);
    setPop({ kind: "none" });
    const outbox = outboxes.get(sessionId) ?? { last: Promise.resolve(), waiting: 0, failed: [] };
    outboxes.set(sessionId, outbox);
    outbox.waiting++;
    const job = (outbox.last = outbox.last.then(async () => {
      if (outbox.failed.length) {
        outbox.failed.push(message);
        return;
      }
      try {
        const inputs = message.images.length ? await Promise.all(message.images.map((img) => toImageInput(img, limits))) : [];
        await client.send(sessionId, { text: body, images: inputs, steer: steer && canSteer });
        const h = history.get(sessionId) ?? [];
        if (body && h[h.length - 1] !== body) h.push(body);
        history.set(sessionId, h.slice(-100));
      } catch (e) {
        toast(`send: ${e instanceof Error ? e.message : String(e)}`, "error");
        outbox.failed.push(message);
      }
    }));
    await job;
    updateDraft(sessionId, (draft) => ({ sending: draft.sending - 1 }));
    if (--outbox.waiting > 0) return;
    outboxes.delete(sessionId);
    if (outbox.failed.length === 0) return;
    updateDraft(sessionId, (draft) => {
      const restored = [...outbox.failed.map((m) => m.text), draft.text].filter((t) => t.trim()).join("\n\n");
      return { text: restored, start: restored.length, end: restored.length, richSelection: false, images: [...outbox.failed.flatMap((m) => m.images), ...draft.images] };
    });
  };

  const insertSlash = (e: SlashEntry) => {
    setText(`/${e.name} `);
    setPop({ kind: "none" });
    // The rich editor puts the caret at the end of a draft changed elsewhere.
    requestAnimationFrame(() => taRef.current?.setSelectionRange(e.name.length + 2, e.name.length + 2));
  };

  const insertMention = (path: string) => {
    const field = input();
    if (pop.kind !== "mention" || !field) return;
    const { before } = field.caret();
    const mq = mentionQuery(before, before.length);
    if (mq) field.replaceBeforeCaret(before.length - mq.start, `@${path} `);
    setPop({ kind: "none" });
  };

  /** True when the key was the composer's. */
  const onKeyDown = (e: KeyLike): boolean => {
    // Enter that confirms an input method's composition is not a send.
    if (e.isComposing) return false;
    const field = input();
    if (pop.kind !== "none") {
      const n = pop.kind === "slash" ? slashResults.length : pop.results.length;
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        setPop((p) => (p.kind === "none" ? p : { ...p, idx: n ? (p.idx + 1) % n : 0 }));
        return true;
      }
      if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        setPop((p) => (p.kind === "none" ? p : { ...p, idx: n ? (p.idx - 1 + n) % n : 0 }));
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setPop({ kind: "none" });
        return true;
      }
      if (e.key === "Enter" && !e.shiftKey && n > 0) {
        e.preventDefault();
        if (pop.kind === "slash") insertSlash(slashResults[pop.idx]);
        else insertMention(pop.results[pop.idx]);
        return true;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(e.metaKey || e.ctrlKey);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      field?.element()?.blur();
      setFocus("main");
      return true;
    }
    if (e.key === "c" && e.ctrlKey && (running || !text)) {
      e.preventDefault();
      void client?.interrupt(sessionId).catch((err) => toast(String(err), "error"));
      return true;
    }
    if (e.key === "Backspace" && !text && images.length > 0) {
      e.preventDefault();
      setImages((imgs) => imgs.slice(0, -1));
      return true;
    }
    const h = history.get(sessionId) ?? [];
    if (e.key === "ArrowUp" && h.length && field) {
      if (field.caret().firstLine) {
        e.preventDefault();
        if (histIdx === null) historyDraft.current = text;
        const idx = histIdx === null ? h.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(idx);
        setText(h[idx]);
        return true;
      }
    }
    if (e.key === "ArrowDown" && histIdx !== null && field) {
      if (field.caret().lastLine) {
        e.preventDefault();
        const idx = histIdx + 1;
        if (idx >= h.length) {
          setHistIdx(null);
          setText(historyDraft.current);
        } else {
          setHistIdx(idx);
          setText(h[idx]);
        }
        return true;
      }
    }
    return false;
  };

  const addImages = async (files: File[]) => {
    if (files.length === 0) return;
    if (!imageSupported.ok) {
      toast(imageSupported.reason, "warn");
      return;
    }
    const results = await Promise.allSettled(files.map(prepareImage));
    const added = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    for (const r of results) if (r.status === "rejected") toast(r.reason instanceof Error ? r.reason.message : String(r.reason), "warn");
    if (added.length) setImages((cur) => [...cur, ...added]);
  };

  /** True when the clipboard held images, which are attached rather than pasted as text. */
  const onPaste = (e: { clipboardData: DataTransfer | null; preventDefault: () => void }): boolean => {
    const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile()).filter((f): f is File => !!f);
    if (files.length === 0) return false;
    e.preventDefault();
    void addImages(files);
    return true;
  };

  const onDrop = (e: React.DragEvent) => {
    setDragging(false);
    if (!hasFiles(e)) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const other = files.filter((f) => !isImageFile(f));
    if (other.length) toast(`Only images can be attached; not ${other.map((f) => f.name).join(", ")}`, "warn");
    void addImages(files.filter(isImageFile));
    input()?.focus();
  };

  const removeImage = (key: string, refocus: boolean) => {
    const idx = images.findIndex((img) => img.key === key);
    setImages((imgs) => imgs.filter((img) => img.key !== key));
    if (!refocus) return;
    // Keep the keyboard in the strip: the next thumbnail, else the previous, else the textbox.
    requestAnimationFrame(() => {
      const thumbs = stripRef.current?.querySelectorAll<HTMLElement>(".image-thumb-open");
      const next = thumbs?.[Math.min(idx, thumbs.length - 1)];
      if (next) next.focus();
      else input()?.focus();
    });
  };

  const openImage = (img: DraftImage) => {
    openDialog({ kind: "image", caption: imageCaption(img), preview: img.thumbnail, load: () => Promise.resolve(img.blob) });
  };

  const onThumbKey = (img: DraftImage) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      removeImage(img.key, true);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const thumbs = [...(stripRef.current?.querySelectorAll<HTMLElement>(".image-thumb-open") ?? [])];
      const i = thumbs.indexOf(e.currentTarget) + (e.key === "ArrowLeft" ? -1 : 1);
      if (i >= thumbs.length) input()?.focus();
      else thumbs[Math.max(0, i)]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      input()?.focus();
    }
  };

  if (!session) return null;
  const usage = session.usage;
  const ctxPct = usage.context_window && usage.context_used ? Math.min(100, Math.round((usage.context_used / usage.context_window) * 100)) : null;
  const modKey = formatKeys("mod+enter", isMac);
  const placeholder = running ? (canSteer ? "Steer the running turn…" : "Queue a message…") : `Message ${session.agent ?? session.provider}…  / commands${folderOf(session) === null ? "" : " · @ files"}`;
  const draft = useComposerDrafts.getState().drafts[sessionId];
  // Read once, when the rich editor starts.
  const selection = draft?.richSelection ? { start: draft.start, end: draft.end } : null;

  return (
    <div
      className={clsx("composer", dragging && "dragging")}
      data-region="composer"
      ref={rootRef}
      style={{ position: "relative" }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {pop.kind === "slash" && slashResults.length > 0 && (
        <div className="popover list" role="listbox">
          {slashResults.map((s, i) => (
            <button key={s.name} className={clsx("list-item", i === pop.idx && "active")} data-command="composer.insert-slash" onMouseDown={(e) => e.preventDefault()} onClick={() => insertSlash(s)}>
              <span className="mono">/{s.name}</span>
              <span className="grow dim">{s.description}</span>
              {s.source && <span className="chip">{s.source}</span>}
            </button>
          ))}
        </div>
      )}
      {pop.kind === "mention" && (
        <div className="popover list" role="listbox">
          {pop.results.length === 0 && <div className="list-item dim">{pop.query ? "no matching files" : "type to search files…"}</div>}
          {pop.results.map((p, i) => (
            <button key={p} className={clsx("list-item", i === pop.idx && "active")} data-command="composer.insert-mention" onMouseDown={(e) => e.preventDefault()} onClick={() => insertMention(p)}>
              <span className="mono grow">{p}</span>
            </button>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="image-strip" ref={stripRef} aria-label="Attached images">
          {images.map((img) => {
            const note = planNote(planFor(img, limits));
            return (
              <ImageThumb
                key={img.key}
                src={img.thumbnail}
                caption={[imageCaption(img), fmtSize(img.blob.size), note?.detail].filter(Boolean).join(" · ")}
                badge={note?.badge}
                badgeKind={note?.badge === "too large" ? "err" : "info"}
                onOpen={() => openImage(img)}
                onRemove={() => removeImage(img.key, false)}
                onKeyDown={onThumbKey(img)}
              />
            );
          })}
          {!imageSupported.ok && <span className="warn-text">{imageSupported.reason}; remove them to send.</span>}
        </div>
      )}
      {dragging && <div className="drop-hint">{imageSupported.ok ? "Drop images to attach" : imageSupported.reason}</div>}
      {errored ? (
        <div className="row err-row">
          <span className="dot err" />
          <span className="err-text grow">{session.last_error ?? "Session error"}</span>
          <button className="btn small" data-command="composer.retry" onClick={() => { input()?.focus(); if (text.trim() || images.length > 0) void send(false); }}>Retry</button>
        </div>
      ) : null}
      {rich && RichInput ? (
        <RichInput
          value={text}
          placeholder={placeholder}
          selection={selection}
          inputRef={richRef}
          onChange={(markdown, start, end, before) => {
            updateDraft(sessionId, () => ({ text: markdown, start, end, richSelection: true }));
            setHistIdx(null);
            updatePopover(markdown, before);
          }}
          onSelect={(start, end, before) => {
            updateDraft(sessionId, () => ({ start, end, richSelection: true }));
            if (pop.kind === "mention") updatePopover(text, before);
          }}
          onFocus={() => useStore.getState().setFocus("composer")}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
      ) : (
        <textarea
          ref={taRef}
          data-autofocus
          aria-label="Message"
          value={text}
          placeholder={placeholder}
          rows={1}
          spellCheck
          onChange={(e) => {
            setText(e.target.value);
            setHistIdx(null);
            updatePopover(e.target.value, lineUpTo(e.target.value, e.target.selectionStart));
          }}
          onSelect={(e) => {
            const ta = e.currentTarget;
            updateDraft(sessionId, () => ({ start: ta.selectionStart, end: ta.selectionEnd, richSelection: false }));
            if (pop.kind === "mention") updatePopover(ta.value, lineUpTo(ta.value, ta.selectionStart));
          }}
          onFocus={() => useStore.getState().setFocus("composer")}
          onKeyDown={(e) => void onKeyDown(e)}
          onPaste={(e) => void onPaste(e)}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          void addImages(files);
          input()?.focus();
        }}
      />
      <div className="row">
        {sending > 0 && (
          <span role="status">
            <span className="dot info pulse" /> Sending…
          </span>
        )}
        {running && (
          <span>
            <span className="dot info pulse" /> Working… <kbd>⌃C</kbd> interrupt
          </span>
        )}
        <span>
          <kbd>Enter</kbd> {running ? "queue" : "send"}
          {canSteer && <> · <kbd>{modKey}</kbd> steer</>} · <kbd>⇧Enter</kbd> newline
        </span>
        {questionWaiting && questionKey && (
          <span className="question-hint" role="status">
            <span className="dot info pulse" /> The agent has a question · <kbd>{questionKey}</kbd> go to it
          </span>
        )}
        <span className="spacer" />
        <button className="chip" data-command="composer.toggle-rich" aria-pressed={rich} onClick={() => toggleRichComposer(true)}
          title={rich ? "Formatting as you type; switch to plain markdown" : "Plain markdown; switch to formatting as you type"}>
          {rich ? "Rich text" : "Markdown"}
        </button>
        {caps?.images && (
          <button className="chip" data-command="composer.attach-image" onClick={() => fileRef.current?.click()} title={imageSupported.ok ? "Attach images (or paste / drop them)" : imageSupported.reason}>
            + image
          </button>
        )}
        {caps?.models && (
          <button className="chip" data-command="session.pick-model" onClick={() => openDialog({ kind: "models", sessionId })} title="Change model">
            {session.model ?? "model"}
          </button>
        )}
        {caps?.effort && (
          <button className="chip" data-command="session.pick-effort" onClick={() => openDialog({ kind: "effort", sessionId })} title="Change effort">
            {session.effort ?? "effort"}
          </button>
        )}
        {caps && caps.permission_modes.length > 0 && (
          <button className="chip" data-command="session.pick-permission" onClick={() => openDialog({ kind: "permission", sessionId })} title="Change permission mode">
            {session.permission_mode ?? "permissions"}
          </button>
        )}
        {caps && caps.sandbox_modes.length > 0 && (
          <button className="chip" data-command="session.pick-sandbox" onClick={() => openDialog({ kind: "sandbox", sessionId })} title="Change sandbox">
            {session.sandbox_mode ?? "sandbox"}
          </button>
        )}
        {ctxPct !== null ? (
          <span className="ctx" title={`${fmtTokens(usage.context_used ?? 0)} / ${fmtTokens(usage.context_window ?? 0)} tokens`}>
            ctx {ctxPct}%
            <span className="meter inline"><div style={{ width: `${ctxPct}%` }} /></span>
          </span>
        ) : usage.context_used ? (
          // Claude reports a new session's window only when its first turn ends.
          <span className="ctx" title={`${usage.context_used} tokens`}>ctx {fmtTokens(usage.context_used)}</span>
        ) : null}
        {usage.total_cost_usd ? <span>{fmtUsd(usage.total_cost_usd)}</span> : null}
      </div>
    </div>
  );
}
