/**
 * A window's link to the daemon: one client at a time, with the window's
 * subscriptions on it. When the daemon changes (a restart, or the shell
 * starting it again after a failed update, which gives it a new port and
 * token) the shell tells every window (`aura://daemon-changed`), and the link
 * moves them to a client for the new one; the old client would keep
 * reconnecting to a port nobody listens on.
 */
import type { ConnInfo } from "./connection";

/** What the link needs of a client. */
export type LinkClient = { connect(): Promise<void>; close(): void };

export type DaemonLinkOptions<C extends LinkClient> = {
  /** A client for `info`, not yet connected. */
  makeClient: (info: ConnInfo) => C;
  /**
   * Called with each client once it is connected: subscribe and load what the
   * window shows. Returns what undoes the subscriptions.
   */
  attach: (client: C) => Promise<() => void> | (() => void);
};

export class DaemonLink<C extends LinkClient> {
  private client: C | null = null;
  private info: ConnInfo | null = null;
  private detach: (() => void) | null = null;
  /** Switches run one after another, the last one winning. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private opts: DaemonLinkOptions<C>) {}

  get current(): C | null {
    return this.client;
  }

  /** Connect to `info`, unless already connected to the same daemon. True when it switched. */
  switchTo(info: ConnInfo): Promise<boolean> {
    const run = this.queue.then(() => this.doSwitch(info));
    this.queue = run.catch(() => {});
    return run;
  }

  private async doSwitch(info: ConnInfo): Promise<boolean> {
    if (this.info && this.info.port === info.port && this.info.token === info.token) return false;
    const next = this.opts.makeClient(info);
    await next.connect();
    this.drop();
    this.client = next;
    this.info = info;
    this.detach = await this.opts.attach(next);
    return true;
  }

  private drop() {
    this.detach?.();
    this.detach = null;
    this.client?.close();
    this.client = null;
  }

  close() {
    this.drop();
    this.info = null;
  }
}
