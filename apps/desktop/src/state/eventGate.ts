/**
 * Holds the daemon's events while a snapshot (the session list, the
 * workspace list) is being fetched, and replays them over it once it is
 * applied. Subscribe first, then fetch: an event sent during the fetch is
 * not lost, and a snapshot older than an event cannot overwrite it, because
 * every change the daemon makes after the fetch began comes as an event
 * applied after the snapshot.
 */
export class EventGate<E> {
  private loading = 0;
  private held: E[] = [];

  constructor(private readonly apply: (ev: E) => void) {}

  /** An event from the daemon: applied now, or held while a snapshot loads. */
  push(ev: E) {
    if (this.loading > 0) this.held.push(ev);
    else this.apply(ev);
  }

  /** Fetch a snapshot with `load` and apply it with `applySnapshot`, holding events meanwhile; a failed fetch still releases them. */
  async during<T>(load: () => Promise<T>, applySnapshot: (snapshot: T) => void): Promise<void> {
    this.loading++;
    try {
      applySnapshot(await load());
    } finally {
      this.loading--;
      if (this.loading === 0) {
        const held = this.held;
        this.held = [];
        for (const ev of held) this.apply(ev);
      }
    }
  }
}
