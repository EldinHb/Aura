import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { useStore } from "../state/store";
import { base64ToBytes } from "../lib/rpc";
import { formatKeys } from "../lib/keymap";
import { isMac } from "../lib/platform";

/**
 * Embedded terminal for a PTY-backed session. Attaches on mount, replays the
 * scrollback, streams output, forwards keys. Ctrl+\ (or Escape twice quickly)
 * returns focus to Aura without leaving the session.
 */
export function TerminalView({ sessionId }: { sessionId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const client = useStore((s) => s.client);
  const session = useStore((s) => s.sessions[sessionId]);
  const fontSize = useStore((s) => s.settings.fontSize);
  const setFocus = useStore((s) => s.setFocus);
  const leader = useStore((s) => s.settings.leader);

  useEffect(() => {
    if (!ref.current || !client) return;
    const term = new Terminal({
      fontFamily: "JetBrains Mono, SF Mono, Menlo, Consolas, monospace",
      fontSize,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: {
        background: "#0b0d13",
        foreground: "#e6e8ef",
        cursor: "#8b7cff",
        selectionBackground: "rgba(139,124,255,0.35)",
        black: "#1b1f2d", red: "#ff6b7a", green: "#4ad295", yellow: "#f2b84b", blue: "#62b0ff", magenta: "#c792ea", cyan: "#5ee0c8", white: "#d0d4e0",
        brightBlack: "#6b7490", brightRed: "#ff8a95", brightGreen: "#7fe0b3", brightYellow: "#ffd07a", brightBlue: "#8cc6ff", brightMagenta: "#dcb3f5", brightCyan: "#8fece0", brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* canvas fallback */
    }
    let disposed = false;
    let lastEsc = 0;
    // Keys Aura reserves even while the terminal has focus.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.key === "\\" && e.ctrlKey) {
        setFocus("sidebar");
        (document.querySelector('[data-region="sidebar"]') as HTMLElement | null)?.focus();
        return false;
      }
      if (e.key === "Escape") {
        const now = Date.now();
        if (now - lastEsc < 350) {
          lastEsc = 0;
          setFocus("sidebar");
          (document.querySelector('[data-region="sidebar"]') as HTMLElement | null)?.focus();
          return false;
        }
        lastEsc = now;
      }
      // leader chord and cmd-chords are handled by the global keymap (capture phase)
      if (isMac && e.metaKey) return false;
      if (e.ctrlKey && e.code === "Space") return false;
      return true;
    });

    const resize = () => {
      if (disposed) return;
      try {
        fit.fit();
        client.ptyResize(sessionId, term.cols, term.rows).catch(() => {});
      } catch {
        /* not visible yet */
      }
    };
    const ro = new ResizeObserver(() => resize());
    ro.observe(ref.current);

    const offPty = client.onPty(sessionId, (data) => term.write(data));
    const onData = term.onData((d) => client.ptyInput(sessionId, d));
    const onBinary = term.onBinary((d) => {
      const bytes = new Uint8Array(d.length);
      for (let i = 0; i < d.length; i++) bytes[i] = d.charCodeAt(i) & 255;
      client.ptyInput(sessionId, bytes);
    });
    client
      .ptyAttach(sessionId)
      .then((r) => {
        if (disposed) return;
        term.reset();
        if (r.scrollback) term.write(base64ToBytes(r.scrollback));
        resize();
      })
      .catch(() => {});
    const onFocus = () => setFocus("main");
    term.textarea?.addEventListener("focus", onFocus);
    requestAnimationFrame(() => {
      resize();
      if (useStore.getState().focus === "main") term.focus();
    });
    return () => {
      disposed = true;
      ro.disconnect();
      offPty();
      onData.dispose();
      onBinary.dispose();
      term.textarea?.removeEventListener("focus", onFocus);
      client.ptyDetach(sessionId).catch(() => {});
      term.dispose();
    };
  }, [client, sessionId, fontSize, setFocus]);

  return (
    <>
      <div className="terminal-wrap" ref={ref} data-autofocus-terminal />
      <div className="terminal-bar">
        <span>
          {session?.status === "exited" ? `exited (${session.exit_code ?? "?"})` : session?.status ?? ""}
        </span>
        <span>{session?.command?.join(" ")}</span>
        <span style={{ flex: 1 }} />
        <span>
          <kbd>Ctrl+\</kbd> or <kbd>Esc Esc</kbd> back to Aura · <kbd>{formatKeys(leader, isMac)}</kbd> menu
        </span>
        {session?.status === "exited" && (
          <button className="btn small" data-command="session.restart" onClick={() => void import("../lib/commands").then((m) => m.runCommand("session.restart"))}>
            Restart <kbd>{formatKeys("leader s x", isMac)}</kbd>
          </button>
        )}
      </div>
    </>
  );
}
