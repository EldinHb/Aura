// HTTPS to GitHub's API, signed in with gh's token (former aura-github transport.rs `GhCli`).
// One transport serves the mod: it keeps the token, rate-limit budgets and login state that
// every caller shares. Conditional requests go through the host's ETag cache (`cache: "etag"`),
// which keys answers on the URL and the Authorization header, so one login's answers never
// serve another.
import type { DaemonApi, HttpResponse } from "@aura/mod-sdk/daemon";
import {
  LOGIN_EXPIRED,
  Memo,
  NO_GH,
  Notified,
  RateLimited,
  RejectedRequest,
  messageOf,
  pace,
  validateRepo,
  validateSha,
  type Budget,
  type Github,
} from "@aura/github-client";

/** Concurrent requests. GitHub's secondary rate limit punishes bursts, and a refresh fans out over every listed PR. */
export const MAX_CONCURRENT = 4;
/** How long GitHub is left alone after a rate limit that names no wait; its docs ask for at least a minute. */
export const RATE_LIMIT_PAUSE_MS = 60_000;
/** Waits before retrying a read that failed with a GitHub server error. */
export const RETRY_DELAYS_MS = [2_000, 5_000];
/** gh's token is read again after this long, so `gh auth switch` and a new login are noticed. */
export const TOKEN_TTL_MS = 60_000;
/** While signed out, how often gh is asked for a new token. Reading it costs no request. */
export const SIGNED_OUT_TOKEN_TTL_MS = 15_000;
/** A token GitHub refused is tried again after this long, in case the refusal passed. */
export const LOGIN_RECHECK_MS = 10 * 60_000;
/** Recent notifications, read as a hint of which PRs changed. */
const NOTIFICATIONS = "notifications?all=true&per_page=50";
const NOTIFICATIONS_PAGE = 50;
/** Without notifications (a token lacking the scope), they are not asked for again for this long. */
const NOTIFICATIONS_OFF_MS = 60 * 60_000;
/** The token's request timeout, as the former client's. */
const REQUEST_TIMEOUT_MS = 60_000;
const GH_TIMEOUT_MS = 15_000;
const NOT_SIGNED_IN = "Not signed in to GitHub. Run `gh auth login`; Aura reconnects by itself.";

type Headers = Record<string, string>;
type Clock = () => number;

/** "HH:MM:SS" local time of `ms`. */
function clock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A short fingerprint of a token, so state is kept per credential without keying on the token itself. */
export function fingerprint(token: string): string {
  let h1 = 0xdeadbeef ^ token.length;
  let h2 = 0x41c6ce57 ^ token.length;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** GitHub refused the credentials (HTTP 401). */
export class Unauthorized extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unauthorized";
  }
}

/** gh reports primary, secondary and GraphQL limits with these words. */
export const isRateLimited = (message: string) => message.toLowerCase().includes("rate limit");
export const isServerError = (message: string) => ["HTTP 500", "HTTP 502", "HTTP 503", "HTTP 504"].some((s) => message.includes(s));

/** Reads can be repeated. A write that failed with a server error may still have been applied, so it is never retried. */
export function isRead(method: string, path: string, body?: unknown): boolean {
  if (path === "graphql") {
    const query = (body as { query?: unknown } | undefined)?.query;
    return !(typeof query === "string" && query.trimStart().startsWith("mutation"));
  }
  return method.toUpperCase() === "GET";
}

/** The rate limit a request draws on. */
export function resource(path: string): string {
  return path === "graphql" ? "graphql" : path.startsWith("search/") ? "search" : "core";
}

/** One at a time (former `tokio::sync::Mutex<()>`). */
class Lock {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Paces every request: a few at a time, nothing during a rate limit's pause, and budgets per credential. */
export class Gate {
  private active = 0;
  private queue: Array<() => void> = [];
  private pausedUntil: number | null = null;
  /** Per credential (token fingerprint): each login has its own limits. */
  private budgets: Array<[string, Budget]> = [];

  constructor(
    private slots = MAX_CONCURRENT,
    private pauseMs = RATE_LIMIT_PAUSE_MS,
    private retryDelays: number[] = RETRY_DELAYS_MS,
    private now: Clock = () => Date.now(),
  ) {}

  /** Why requests are refused unsent right now: a rate limit's pause. */
  paused(): string | null {
    const until = this.pausedUntil;
    return until !== null && until > this.now() ? `GitHub rate limit reached; Aura resumes GitHub requests at ${clock(until)}` : null;
  }

  pauseFor(ms: number): void {
    const until = this.now() + ms;
    if (this.pausedUntil === null || this.pausedUntil < until) this.pausedUntil = until;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.slots) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }

  /**
   * Run `call`, retrying server errors when `retry` says the request is safe to repeat.
   * After a rate limit every request is refused unsent until the pause ends.
   */
  async run<T>(retry: boolean, call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const message = this.paused();
      if (message) throw new RejectedRequest(message);
      await this.acquire();
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await call() };
      } catch (error) {
        outcome = { ok: false, error };
      } finally {
        // Released before any retry's wait, so waiting holds no slot.
        this.release();
      }
      if (outcome.ok) return outcome.value;
      const e = outcome.error;
      const text = messageOf(e);
      if (e instanceof RateLimited) {
        if (!e.resourceOnly) this.pauseFor(e.waitMs ?? this.pauseMs);
        throw e;
      }
      if (isRateLimited(text)) {
        this.pauseFor(this.pauseMs);
        throw e;
      }
      const delay = this.retryDelays[attempt];
      if (!(retry && delay !== undefined && isServerError(text))) throw e;
      console.debug(`GitHub server error, retrying in ${delay}ms: ${text}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  record(credential: string, headers: Headers): void {
    const num = (name: string) => {
      const v = headers[name];
      return v !== undefined && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null;
    };
    const res = headers["x-ratelimit-resource"];
    const limit = num("x-ratelimit-limit");
    const remaining = num("x-ratelimit-remaining");
    const reset = num("x-ratelimit-reset");
    if (res === undefined || limit === null || remaining === null || reset === null) return;
    this.budgets = this.budgets.filter(([c, b]) => c !== credential || b.resource !== res);
    this.budgets.push([credential, { resource: res, limit, remaining, reset }]);
  }

  budgetsOf(credential: string): Budget[] {
    return this.budgets.filter(([c]) => c === credential).map(([, b]) => ({ ...b }));
  }

  /** When the budget of `credential` that `res` draws on is spent: its reset, as a message. */
  exhausted(credential: string, res: string): string | null {
    const nowSec = Math.floor(this.now() / 1000);
    const b = this.budgetsOf(credential).find((b) => b.resource === res && b.remaining === 0 && b.reset > nowSec);
    return b ? `GitHub ${res} rate limit reached; Aura resumes those requests at ${clock(b.reset * 1000)}` : null;
  }

  pace(credential: string, baseMs: number): number {
    return pace(baseMs, this.budgetsOf(credential), Math.floor(this.now() / 1000));
  }
}

/** How long GitHub asked to wait: Retry-After, else until the reset of a spent budget. */
function waitFrom(headers: Headers, nowMs: number): number | null {
  const after = headers["retry-after"];
  if (after !== undefined && /^\d+$/.test(after.trim())) return Number(after.trim()) * 1000;
  const reset = headers["x-ratelimit-reset"];
  if (reset === undefined || !/^\d+$/.test(reset.trim())) return null;
  if (headers["x-ratelimit-remaining"] !== "0") return null;
  return (Math.max(0, Number(reset.trim()) - Math.floor(nowMs / 1000)) + 1) * 1000;
}

/** GitHub's refusal as an error: a rate limit, a 401, a request it rejected, or a failure. */
export function failure(status: number, headers: Headers, text: string, nowMs = Date.now()): Error {
  let said: string | null = null;
  try {
    const v = JSON.parse(text);
    if (typeof v?.message === "string") said = v.message;
  } catch {
    // not JSON
  }
  said ??= Array.from(text.trim()).slice(0, 300).join("");
  const message = `${said} (HTTP ${status})`;
  const spent = headers["x-ratelimit-remaining"] === "0";
  const retryAfter = "retry-after" in headers;
  if ((status === 403 || status === 429) && (spent || retryAfter || isRateLimited(message))) {
    return new RateLimited(message, waitFrom(headers, nowMs), spent && !retryAfter);
  }
  if (status === 401) return new Unauthorized(message);
  if ([400, 403, 404, 405, 422, 429].includes(status)) return new RejectedRequest(message);
  return new Error(message);
}

/** A GraphQL answer without data fails as a whole; one with data is kept, and callers read its `errors`. */
export function graphqlFailure(headers: Headers, text: string, nowMs = Date.now()): void {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    return;
  }
  const data = v?.data;
  if ((data && typeof data === "object" && !Array.isArray(data)) || !Array.isArray(v?.errors)) return;
  const errors: any[] = v.errors;
  const message = errors.flatMap((e) => (typeof e?.message === "string" ? [e.message] : [])).join("; ");
  if (errors.some((e) => e?.type === "RATE_LIMITED") || isRateLimited(message)) {
    throw new RateLimited(message, waitFrom(headers, nowMs), headers["x-ratelimit-remaining"] === "0");
  }
  throw new Error(message);
}

function json(raw: string): any {
  return raw.trim() === "" ? null : JSON.parse(raw);
}

/** Why GitHub is not asked anything, and the token it refused. */
interface SignedOut {
  reason: string;
  token: string | null;
  checked: number;
}

/** Whether `token` should be tried: a different token than the refused one is tried at once. */
export function shouldRetry(out: SignedOut, token: string, now: number): boolean {
  return out.token !== token || now - out.checked >= LOGIN_RECHECK_MS;
}

interface Reply {
  body: string;
  pollInterval: number | null;
}

export interface TransportOptions {
  aura: Pick<DaemonApi, "process" | "http"> & { mod?: { version: string } };
  host?: string;
  gate?: Gate;
  /** The API's address, when not the host's (tests). */
  api?: string;
  now?: Clock;
}

/** GitHub through its API, signed in as gh is. */
export class GhTransport implements Github {
  private readonly aura: TransportOptions["aura"];
  private readonly hostName: string;
  private readonly api?: string;
  readonly gate: Gate;
  private readonly now: Clock;
  private cached: { token: string; at: number } | null = null;
  private loading: Promise<string> | null = null;
  /** The fingerprint of gh's token as last read. */
  private current: string | null = null;
  /** Token fingerprint -> `host:login`. */
  private accounts = new Map<string, string>();
  /** Held while an account is looked up, so callers starting together ask once. */
  private lookingUp = new Lock();
  private signedOut: SignedOut | null = null;
  private checking = false;
  private notes: {
    read: { credential: string; at: number; everyMs: number; last: Notified | null } | null;
    off: { credential: string; until: number } | null;
  } = { read: null, off: null };
  private notesLock = new Lock();
  private readonly shared = new Memo();

  constructor(opts: TransportOptions) {
    this.aura = opts.aura;
    this.hostName = opts.host ?? "github.com";
    this.api = opts.api;
    this.now = opts.now ?? (() => Date.now());
    this.gate = opts.gate ?? new Gate(MAX_CONCURRENT, RATE_LIMIT_PAUSE_MS, RETRY_DELAYS_MS, this.now);
  }

  url(path: string): string {
    if (path.startsWith("https://")) return path;
    if (this.api) return `${this.api}/${path}`;
    let api: string;
    if (this.hostName === "github.com") api = "https://api.github.com";
    else if (this.hostName.endsWith(".ghe.com")) api = `https://api.${this.hostName}`;
    else if (path === "graphql") return `https://${this.hostName}/api/graphql`;
    else api = `https://${this.hostName}/api/v3`;
    return `${api}/${path.replace(/^\/+/, "")}`;
  }

  /** As if gh had just handed out `token` (tests). */
  primeToken(token: string): void {
    this.cached = { token, at: this.now() };
  }

  /** gh's token for `host`, of `user` when given. */
  private async ghToken(host: string, user?: string): Promise<string> {
    const args = ["auth", "token", "--hostname", host, ...(user ? ["--user", user] : [])];
    let out;
    try {
      out = await this.aura.process.run("gh", args, { env: { GH_PROMPT_DISABLED: "1" }, timeoutMs: GH_TIMEOUT_MS });
    } catch (e) {
      throw new Error((e as { code?: string })?.code === "timeout" ? "GitHub CLI timed out" : NO_GH);
    }
    const token = out.stdout.trim();
    if (out.code !== 0 || !token) throw new Error(NOT_SIGNED_IN);
    return token;
  }

  /** gh's token for the active account, read again now and then. */
  private async token(): Promise<string> {
    const ttl = this.signedOut ? SIGNED_OUT_TOKEN_TTL_MS : TOKEN_TTL_MS;
    let token: string;
    if (this.cached && this.now() - this.cached.at < ttl) {
      token = this.cached.token;
    } else {
      this.loading ??= this.ghToken(this.hostName)
        .then((t) => {
          this.cached = { token: t, at: this.now() };
          return t;
        })
        .finally(() => {
          this.loading = null;
        });
      token = await this.loading;
    }
    this.current = fingerprint(token);
    return token;
  }

  private signOut(reason: string, token: string | null): void {
    if (!this.signedOut) console.warn(`GitHub requests stopped: ${reason}`);
    this.signedOut = { reason, token, checked: this.now() };
  }

  /**
   * The token to send, or why GitHub is not asked: no login, or one GitHub refused. A token
   * that may work again is tried with one cheap request.
   */
  private async readyToken(): Promise<string> {
    let token: string;
    try {
      token = await this.token();
    } catch (e) {
      const reason = messageOf(e);
      this.signOut(reason, null);
      throw new RejectedRequest(reason);
    }
    const fp = fingerprint(token);
    const out = this.signedOut;
    if (!out) return token;
    if (!shouldRetry(out, fp, this.now())) throw new RejectedRequest(out.reason);
    // One check at a time; requests meanwhile are refused.
    if (this.checking) throw new RejectedRequest(LOGIN_EXPIRED);
    this.checking = true;
    try {
      const reply = await this.fetch("GET", "user", undefined, false, token, true);
      const user = json(reply.body);
      if (typeof user?.login === "string") this.accounts.set(fp, `${this.hostName}:${user.login}`);
      this.signedOut = null;
      console.info("GitHub requests resumed");
      return token;
    } catch (e) {
      // A refusal waits for a new token or the next check; anything else (no network) is
      // tried again in a minute.
      if (this.signedOut) {
        this.signedOut.token = fp;
        this.signedOut.checked = messageOf(e) === LOGIN_EXPIRED ? this.now() : this.now() - (LOGIN_RECHECK_MS - 60_000);
      }
      console.debug(`GitHub login check failed: ${messageOf(e)}`);
      throw new RejectedRequest(LOGIN_EXPIRED);
    } finally {
      this.checking = false;
    }
  }

  /** Send one request through the gate. A 401 on gh's own token stops GitHub requests until the login works again. */
  private async fetch(method: string, path: string, body: unknown, diff: boolean, token: string, own: boolean): Promise<Reply> {
    const credential = fingerprint(token);
    const spent = this.gate.exhausted(credential, resource(path));
    if (spent) throw new RejectedRequest(spent);
    try {
      return await this.gate.run(isRead(method, path, body), () => this.send(method, path, body, diff, token));
    } catch (e) {
      if (!(e instanceof Unauthorized)) throw e;
      if (!own) throw new RejectedRequest(`Sign in to the account's GitHub login again: ${e.message}`);
      this.signOut(LOGIN_EXPIRED, credential);
      this.cached = null;
      throw new RejectedRequest(LOGIN_EXPIRED);
    }
  }

  private async send(method: string, path: string, body: unknown, diff: boolean, token: string): Promise<Reply> {
    const url = this.url(path);
    const verb = method.toUpperCase();
    const headers: Headers = {
      Authorization: `Bearer ${token}`,
      Accept: diff ? "application/vnd.github.diff" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": `Aura/${this.aura.mod?.version ?? "mod"}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: HttpResponse;
    try {
      response = await this.aura.http.fetch(url, {
        method: verb,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs: REQUEST_TIMEOUT_MS,
        // Answers kept for conditional requests: a 304 does not count against the rate limit.
        cache: verb === "GET" && !diff ? "etag" : undefined,
      });
    } catch (e) {
      throw new Error((e as { code?: string })?.code === "timeout" ? "GitHub request timed out" : `GitHub request failed: ${messageOf(e)}`);
    }
    const h = response.headers ?? {};
    this.gate.record(fingerprint(token), h);
    console.debug(`GitHub ${verb} ${path}: ${response.status}${response.cached ? " (cached)" : ""}`);
    const poll = h["x-poll-interval"];
    const pollInterval = poll !== undefined && /^\d+$/.test(poll.trim()) ? Number(poll.trim()) : null;
    const text = response.text ?? "";
    if (response.status < 200 || response.status >= 300) throw failure(response.status, h, text, this.now());
    if (path === "graphql") graphqlFailure(h, text, this.now());
    return { body: text, pollInterval };
  }

  private async call(method: string, path: string, body: unknown, diff: boolean): Promise<string> {
    const token = await this.readyToken();
    return (await this.fetch(method, path, body, diff, token, true)).body;
  }

  host(): string {
    return this.hostName;
  }

  async request(method: string, path: string, body?: unknown): Promise<any> {
    return json(await this.call(method, path, body, false));
  }

  async requestFor(account: string, method: string, path: string, body?: unknown): Promise<any> {
    // Resolve and validate a token for the reviewed identity, then pin it to the actual
    // mutation. Switching gh accounts between requests cannot cause a review to be posted
    // as a different person.
    let token: string;
    try {
      const colon = account.indexOf(":");
      if (colon < 0) throw new Error("Invalid GitHub account");
      const host = account.slice(0, colon);
      const login = account.slice(colon + 1);
      if (host !== this.hostName) throw new Error("Wrong GitHub host");
      try {
        token = await this.ghToken(host, login);
      } catch {
        throw new Error("Sign in to the review's GitHub account again");
      }
      const user = json((await this.fetch("GET", "user", undefined, false, token, false)).body);
      if (user?.login !== login) throw new Error("GitHub credentials do not match the reviewed account");
    } catch (e) {
      throw new RejectedRequest(messageOf(e));
    }
    return json((await this.fetch(method, path, body, false, token, false)).body);
  }

  async diff(repo: string, base: string, head: string): Promise<string> {
    validateRepo(repo);
    validateSha(base);
    validateSha(head);
    return this.call("GET", `repos/${repo}/compare/${base}...${head}`, undefined, true);
  }

  /** Looked up once per token: an account only changes with the login. */
  async account(): Promise<string> {
    const token = await this.readyToken();
    const fp = fingerprint(token);
    return this.lookingUp.run(async () => {
      const known = this.accounts.get(fp);
      if (known) return known;
      const user = json((await this.fetch("GET", "user", undefined, false, token, true)).body);
      if (typeof user?.login !== "string") throw new Error("GitHub did not return an account");
      const account = `${this.hostName}:${user.login}`;
      this.accounts.set(fp, account);
      return account;
    });
  }

  async blocked(): Promise<string | null> {
    try {
      await this.readyToken();
    } catch (e) {
      return messageOf(e);
    }
    return this.gate.paused();
  }

  async pace(baseMs: number): Promise<number> {
    return this.current === null ? baseMs : this.gate.pace(this.current, baseMs);
  }

  async notified(): Promise<Notified | null> {
    let token: string;
    try {
      token = await this.readyToken();
    } catch {
      return null;
    }
    const credential = fingerprint(token);
    return this.notesLock.run(async () => {
      const read = this.notes.read;
      if (read && read.credential === credential && this.now() - read.at < read.everyMs) return read.last;
      const off = this.notes.off;
      if (off && off.credential === credential && off.until > this.now()) return null;
      try {
        const reply = await this.fetch("GET", NOTIFICATIONS, undefined, false, token, true);
        let last: Notified | null = null;
        try {
          last = Notified.parse(JSON.parse(reply.body), NOTIFICATIONS_PAGE);
        } catch {
          last = null;
        }
        this.notes.read = { credential, at: this.now(), everyMs: (reply.pollInterval ?? 60) * 1000, last };
        return last;
      } catch (e) {
        const message = messageOf(e);
        // A token without the notifications scope; PRs are then read on a schedule.
        if (message.includes("HTTP 403") || message.includes("HTTP 404")) {
          console.debug(`notifications unavailable: ${message}`);
          this.notes.off = { credential, until: this.now() + NOTIFICATIONS_OFF_MS };
        }
        return null;
      }
    });
  }

  memo(): Memo {
    return this.shared;
  }
}
