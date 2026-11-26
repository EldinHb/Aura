// Small helpers shared by the daemon half: errors, ids, times, locks and
// background tasks that stop when the mod is deactivated.

/** An error an RPC caller sees with a stable `code` (and the message as is). */
export class Fail extends Error {
  code: string;
  data?: unknown;
  constructor(message: string, code = "failed", data?: unknown) {
    super(message);
    this.name = "Fail";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export function fail(message: string, code = "failed"): never {
  throw new Fail(message, code);
}

/** The text of an error, as anyhow's `{e:#}` would show it. */
export function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** `context: cause`, as anyhow's `.context(...)` shows an error. */
export function context(what: string, e: unknown): Error {
  const err = new Fail(`${what}: ${message(e)}`);
  const rest = e as { name?: string; rejected?: boolean; rateLimited?: boolean };
  // Keep what tells a refusal from a transient failure.
  if (rest?.rejected) Object.assign(err, { rejected: true });
  if (rest?.rateLimited) Object.assign(err, { rateLimited: true });
  return err;
}

export const nowIso = (): string => new Date().toISOString();
export const newId = (): string => crypto.randomUUID();
export const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** A non-empty string parameter. */
export function required(p: any, key: string): string {
  const v = p?.[key];
  if (typeof v !== "string" || v === "") fail(`Missing ${key}`, "invalid");
  return v;
}

/** A PR number: a whole number from 1 to u32::MAX. */
export function prNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 4294967295 ? v : null;
}

/** The login of `host:login`. */
export function loginOf(account: string): string {
  const i = account.indexOf(":");
  return i < 0 ? account : account.slice(i + 1);
}

export const eqi = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Characters (code points) in `s`, stopping once past `limit`. */
export function longerThan(s: string, limit: number): boolean {
  if (s.length <= limit) return false;
  let n = 0;
  for (const _ of s) if (++n > limit) return true;
  return false;
}

/** The first `n` characters (code points) of `s`. */
export function takeChars(s: string, n: number): string {
  if (s.length <= n) return s;
  let out = "";
  let i = 0;
  for (const c of s) {
    if (i++ >= n) break;
    out += c;
  }
  return out;
}

/** A GitHub `owner/repo` (former `validate_repo`). */
export function validRepo(repo: string): boolean {
  const parts = repo.split("/");
  return parts.length === 2 && parts.every((p) => p !== "" && p !== "." && p !== ".." && /^[A-Za-z0-9._-]+$/.test(p));
}

export function validSha(sha: string): boolean {
  return /^[0-9a-fA-F]{40}$/.test(sha);
}

/** GitHub's database id of a GraphQL node (former `database_id`). */
export function databaseId(n: any): number | null {
  const full = n?.fullDatabaseId;
  if (typeof full === "string") {
    if (!/^\d+$/.test(full)) return null;
    const v = Number(full);
    return Number.isSafeInteger(v) ? v : null;
  }
  if (typeof full === "number") return Number.isInteger(full) && full >= 0 ? full : null;
  const db = n?.databaseId;
  return typeof db === "number" && Number.isInteger(db) && db >= 0 ? db : null;
}

/** The string at `key`, or "" (former `s`). */
export function str(v: any, key: string): string {
  const x = v?.[key];
  return typeof x === "string" ? x : "";
}

/** One holder at a time, in arrival order (a tokio Mutex around async work). */
export class Lock {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.chain.then(() => fn());
    this.chain = result.catch(() => {});
    return result;
  }
}

/** At most `free` holders at once. */
export class Semaphore {
  private waiters: Array<() => void> = [];
  constructor(private free: number) {}
  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    };
  }
}

/** Rejects with `why` when `p` takes longer than `ms`. */
export function timeout<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Fail(why, "timeout")), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Background work of the mod: sleeps and loops that end on `stop()`. */
export class Tasks {
  stopped = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private wakers = new Set<() => void>();

  /** Resolves after `ms`, or at once when stopped. */
  sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.timers.delete(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.timers.add(timer);
      this.wakers.add(done);
    });
  }

  /** Run `fn` in the background; its failure is logged, not thrown. */
  spawn(what: string, fn: () => Promise<unknown>): void {
    if (this.stopped) return;
    fn().catch((e) => console.debug(`${what}: ${message(e)}`));
  }

  /** Run `body` until stopped; `body` returns how long to wait before the next round. */
  loop(what: string, body: () => Promise<number>): void {
    this.spawn(what, async () => {
      while (!this.stopped) {
        let wait = 60_000;
        try {
          wait = await body();
        } catch (e) {
          console.warn(`${what}: ${message(e)}`);
        }
        await this.sleep(wait);
      }
    });
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const w of [...this.wakers]) w();
  }
}
