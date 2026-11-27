/**
 * A window's link to the daemon: one client at a time, with the window's
 * subscriptions on it. When the daemon changes (a restart, or the shell
 * starting it again after a failed update, which gives it a new port and
 * token) the shell tells every window (`aura://daemon-changed`), and the link
 * moves them to a client for the new one; the old client would keep
 * reconnecting to a port nobody listens on.
 *
 * A switch is all or nothing: the new client takes over only once it has
 * connected and the window has subscribed on it; until then the old one
 * stays, and a client that failed is closed. `close()` calls off every
 * switch still under way or waiting.
 */
import type { ConnInfo } from "./connection";

/** What the link needs of a client. */
export type LinkClient = { connect(): Promise<void>; close(): void };

export type DaemonLinkOptions<C extends LinkClient> = {
  /** A client for `info`, not yet connected. */
  makeClient: (info: ConnInfo) => C;
  /**
   * Subscribe on a connected client and load what the window shows, without
   * making it the window's client yet. Returns what undoes the subscriptions.
   * A throw calls the switch off.
   */
  attach: (client: C) => Promise<() => void> | (() => void);
  /** Make `client` the window's: called once a switch has succeeded. */
  commit: (client: C) => void;
};

export class DaemonLink<C extends LinkClient> {
  private client: C | null = null;
  private info: ConnInfo | null = null;
  private detach: (() => void) | null = null;
  /** Switches run one after another. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Bumped by `close()`: a switch from before it is void. */
  private epoch = 0;

  constructor(private opts: DaemonLinkOptions<C>) {}

  get current(): C | null {
    return this.client;
  }

  /** Connect to `info`, unless already on that daemon. True when it switched. */
  switchTo(info: ConnInfo): Promise<boolean> {
    const epoch = this.epoch;
    const run = this.queue.then(() => this.doSwitch(info, epoch));
    this.queue = run.catch(() => {});
    return run;
  }

  private async doSwitch(info: ConnInfo, epoch: number): Promise<boolean> {
    if (epoch !== this.epoch) return false;
    if (this.info && this.info.port === info.port && this.info.token === info.token) return false;
    const next = this.opts.makeClient(info);
    let detach: (() => void) | null = null;
    try {
      await next.connect();
      if (epoch !== this.epoch) throw new Cancelled();
      detach = await this.opts.attach(next);
      if (epoch !== this.epoch) throw new Cancelled();
    } catch (e) {
      detach?.();
      next.close();
      if (e instanceof Cancelled) return false;
      throw e;
    }
    this.drop();
    this.client = next;
    this.info = info;
    this.detach = detach;
    this.opts.commit(next);
    return true;
  }

  private drop() {
    this.detach?.();
    this.detach = null;
    this.client?.close();
    this.client = null;
  }

  close() {
    this.epoch += 1;
    this.drop();
    this.info = null;
  }
}

class Cancelled extends Error {}

/**
 * Connect a window: listen for announcements first (so none is missed while
 * the window finds the daemon), then find it, unless an announcement came in
 * meanwhile, which is newer. Returns what stops listening.
 */
export async function connectWindow<C extends LinkClient>(opts: {
  link: DaemonLink<C>;
  listen: (onChange: (info: ConnInfo) => void) => Promise<() => void>;
  discover: () => Promise<ConnInfo>;
  onError: (e: unknown) => void;
}): Promise<() => void> {
  let announcements = 0;
  const unlisten = await opts.listen((info) => {
    announcements += 1;
    opts.link.switchTo(info).catch(opts.onError);
  });
  const before = announcements;
  let info: ConnInfo;
  try {
    info = await opts.discover();
  } catch (e) {
    // An announcement may still have connected the window.
    if (announcements === before) opts.onError(e);
    return unlisten;
  }
  // No await between this check and queueing the switch: an announcement
  // after it is queued after it, and wins.
  if (announcements === before) opts.link.switchTo(info).catch(opts.onError);
  return unlisten;
}
