import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { ImageInput, SlashCommand } from "../gen";
import { useStore } from "../state/store";
import { setFocus } from "../commands/core";
import { formatKeys } from "../lib/keymap";
import { isMac } from "../lib/platform";
import { filterSlashCommands, mergeSlashCommands, mentionQuery, slashQuery, type SlashEntry } from "./transcript/slash";
import { fmtTokens, fmtUsd } from "./transcript/format";

/** Sent-message history per session (survives remounts, not reloads). */
const history = new Map<string, string[]>();
const slashCache = new Map<string, { at: number; entries: SlashCommand[] }>();

type Popover =
  | { kind: "none" }
  | { kind: "slash"; query: string; idx: number }
  | { kind: "mention"; start: number; query: string; idx: number; results: string[] };

async function readImage(file: File): Promise<ImageInput> {
  const buf = await file.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { path: null, data: btoa(bin), media_type: file.type || "image/png" };
}

export function Composer({ sessionId }: { sessionId: string }) {
  const client = useStore((s) => s.client);
  const session = useStore((s) => s.sessions[sessionId]);
  const provider = useStore((s) => s.providers.find((p) => p.kind === session?.provider));
  const toast = useStore((s) => s.toast);
  const openDialog = useStore((s) => s.openDialog);
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageInput[]>([]);
  const [pop, setPop] = useState<Popover>({ kind: "none" });
  const [slashEntries, setSlashEntries] = useState<SlashEntry[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const caps = provider?.capabilities;
  const running = session?.status === "running";
  const errored = session?.status === "error";
  const canSteer = !!caps?.steer && running;

  // auto-grow
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const lineH = 19;
    ta.style.height = `${Math.min(ta.scrollHeight, lineH * 8 + 16)}px`;
  }, [text]);

  // slash commands catalogue
  useEffect(() => {
    if (pop.kind !== "slash" || !client || !session) return;
    const cached = slashCache.get(sessionId);
    const apply = (list: SlashCommand[]) => setSlashEntries(mergeSlashCommands(session.provider, list));
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
  }, [pop.kind, client, session, sessionId]);

  const slashResults = useMemo(() => (pop.kind === "slash" ? filterSlashCommands(slashEntries, pop.query, 12) : []), [pop, slashEntries]);

  const updatePopover = useCallback(
    (value: string, caret: number) => {
      const sq = slashQuery(value);
      if (sq !== null && caps?.slash_commands !== false) {
        setPop((p) => ({ kind: "slash", query: sq, idx: p.kind === "slash" ? Math.min(p.idx, 11) : 0 }));
        return;
      }
      const mq = mentionQuery(value, caret);
      if (mq && client && session) {
        setPop((p) => ({ kind: "mention", start: mq.start, query: mq.query, idx: p.kind === "mention" ? p.idx : 0, results: p.kind === "mention" ? p.results : [] }));
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

  const send = async (steer: boolean) => {
    if (!client || !session) return;
    const body = text.trim();
    if (!body && images.length === 0) return;
    setSending(true);
    try {
      await client.send(sessionId, { text: body, images, steer: steer && canSteer });
      const h = history.get(sessionId) ?? [];
      if (body && h[h.length - 1] !== body) h.push(body);
      history.set(sessionId, h.slice(-100));
      setText("");
      setImages([]);
      setHistIdx(null);
      setPop({ kind: "none" });
    } catch (e) {
      toast(`send: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSending(false);
    }
  };

  const insertSlash = (e: SlashEntry) => {
    setText(`/${e.name} `);
    setPop({ kind: "none" });
    requestAnimationFrame(() => taRef.current?.setSelectionRange(e.name.length + 2, e.name.length + 2));
  };

  const insertMention = (path: string) => {
    if (pop.kind !== "mention") return;
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? text.length;
    const next = text.slice(0, pop.start) + `@${path} ` + text.slice(caret);
    setText(next);
    setPop({ kind: "none" });
    const newCaret = pop.start + path.length + 2;
    requestAnimationFrame(() => ta?.setSelectionRange(newCaret, newCaret));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    if (pop.kind !== "none") {
      const n = pop.kind === "slash" ? slashResults.length : pop.results.length;
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        setPop((p) => (p.kind === "none" ? p : { ...p, idx: n ? (p.idx + 1) % n : 0 }));
        return;
      }
      if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        setPop((p) => (p.kind === "none" ? p : { ...p, idx: n ? (p.idx - 1 + n) % n : 0 }));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setPop({ kind: "none" });
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && n > 0) {
        e.preventDefault();
        if (pop.kind === "slash") insertSlash(slashResults[pop.idx]);
        else insertMention(pop.results[pop.idx]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(e.metaKey || e.ctrlKey);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      ta.blur();
      setFocus("main");
      return;
    }
    if (e.key === "c" && e.ctrlKey && (running || !text)) {
      e.preventDefault();
      void client?.interrupt(sessionId).catch((err) => toast(String(err), "error"));
      return;
    }
    if (e.key === "Backspace" && ta.selectionStart === 0 && ta.selectionEnd === 0 && images.length > 0) {
      e.preventDefault();
      setImages((imgs) => imgs.slice(0, -1));
      return;
    }
    const h = history.get(sessionId) ?? [];
    if (e.key === "ArrowUp" && h.length) {
      const firstLine = !text.slice(0, ta.selectionStart).includes("\n");
      if (firstLine) {
        e.preventDefault();
        const idx = histIdx === null ? h.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(idx);
        setText(h[idx]);
        return;
      }
    }
    if (e.key === "ArrowDown" && histIdx !== null) {
      const lastLine = !text.slice(ta.selectionStart).includes("\n");
      if (lastLine) {
        e.preventDefault();
        const idx = histIdx + 1;
        if (idx >= h.length) {
          setHistIdx(null);
          setText("");
        } else {
          setHistIdx(idx);
          setText(h[idx]);
        }
      }
    }
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.items].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile()).filter((f): f is File => !!f);
    if (files.length === 0) return;
    e.preventDefault();
    if (!caps?.images) {
      toast("This provider does not accept images", "warn");
      return;
    }
    const imgs = await Promise.all(files.map(readImage));
    setImages((cur) => [...cur, ...imgs]);
  };

  if (!session) return null;
  const usage = session.usage;
  const ctxPct = usage.context_window && usage.context_used ? Math.min(100, Math.round((usage.context_used / usage.context_window) * 100)) : null;
  const modKey = formatKeys("mod+enter", isMac);

  return (
    <div className="composer" data-region="composer" style={{ position: "relative" }}>
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
        <div className="row chips">
          {images.map((img, i) => (
            <span key={i} className="chip image-chip">
              🖼 {img.media_type?.replace("image/", "") ?? "image"} {Math.round(((img.data?.length ?? 0) * 3) / 4 / 1024)}k
              <button data-command="composer.remove-image" title="remove" onClick={() => setImages((imgs) => imgs.filter((_, j) => j !== i))}>✕</button>
            </span>
          ))}
        </div>
      )}
      {errored ? (
        <div className="row err-row">
          <span className="dot err" />
          <span className="err-text grow">{session.last_error ?? "Session error"}</span>
          <button className="btn small" data-command="composer.retry" onClick={() => { taRef.current?.focus(); if (text.trim()) void send(false); }}>Retry</button>
        </div>
      ) : null}
      <textarea
        ref={taRef}
        data-autofocus
        value={text}
        placeholder={running ? (canSteer ? "Steer the running turn…" : "Queue a message…") : `Message ${session.provider}…  / commands · @ files`}
        disabled={sending}
        rows={1}
        onChange={(e) => {
          setText(e.target.value);
          setHistIdx(null);
          updatePopover(e.target.value, e.target.selectionStart);
        }}
        onSelect={(e) => {
          const ta = e.currentTarget;
          if (pop.kind === "mention") updatePopover(ta.value, ta.selectionStart);
        }}
        onFocus={() => useStore.getState().setFocus("composer")}
        onKeyDown={onKeyDown}
        onPaste={(e) => void onPaste(e)}
      />
      <div className="row">
        {running && (
          <span>
            <span className="dot info pulse" /> Working… <kbd>⌃C</kbd> interrupt
          </span>
        )}
        <span>
          <kbd>Enter</kbd> {running ? "queue" : "send"}
          {canSteer && <> · <kbd>{modKey}</kbd> steer</>} · <kbd>⇧Enter</kbd> newline
        </span>
        <span className="spacer" />
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
        {ctxPct !== null && (
          <span className="ctx" title={`${fmtTokens(usage.context_used)} / ${fmtTokens(usage.context_window)} tokens`}>
            ctx {ctxPct}%
            <span className="meter inline"><div style={{ width: `${ctxPct}%` }} /></span>
          </span>
        )}
        {usage.total_cost_usd ? <span>{fmtUsd(usage.total_cost_usd)}</span> : null}
      </div>
    </div>
  );
}
