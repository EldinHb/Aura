import { Component, type ErrorInfo, type ReactNode } from "react";
import { isTauri } from "../lib/connection";

type State = { error: Error | null; restarting: boolean; restartError: string | null };

/**
 * Shows what went wrong instead of a blank window when rendering throws. The
 * likeliest cause is a daemon of another version answering in a shape this UI
 * does not expect, so restarting it is offered next to reloading.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, restarting: false, restartError: null };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Aura failed to render:", error, info.componentStack);
  }

  private restart = async () => {
    this.setState({ restarting: true, restartError: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("restart_daemon");
      location.reload();
    } catch (e) {
      this.setState({ restarting: false, restartError: e instanceof Error ? e.message : String(e) });
    }
  };

  render() {
    const { error, restarting, restartError } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app">
        <div className="titlebar" data-tauri-drag-region><span className="title">Aura</span></div>
        <div className="empty error-screen" role="alert">
          <h2>Something went wrong</h2>
          <code>{error.message}</code>
          <span>After an update, restarting the daemon usually fixes this; sessions are resumed.</span>
          {restartError && <code>{restartError}</code>}
          <div className="error-screen-actions">
            {isTauri() && <button className="btn primary" data-hint disabled={restarting} onClick={() => void this.restart()}>{restarting ? "Restarting…" : "Restart daemon"}</button>}
            <button className="btn" data-hint disabled={restarting} onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}
