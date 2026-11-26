// Issue and PR links of a session: parsing, the saved preferences, and detection in a
// transcript. Pure, so both halves use it (former views/issueLinks.ts, the decoding of
// state/sessionLinkPreferences.ts, and parse_pr_url / session_prs of aura-review follow.rs).
import type { Item } from "@aura/mod-sdk";

export type SessionLink = { url: string; kind: "Issue" | "PR"; repo: string; number: string };

/**
 * Links the user chose for a session. A missing list follows the conversation
 * (automatic); a list, empty or not, is fixed until the user changes it.
 * `reviews: false` stops Aura handing review activity on the PRs to the session.
 */
export type LinkPreferences = { issues?: string[]; prs?: string[]; reviews?: boolean };

/** What the github mod keeps per session (session data keys `links`, `detected`, `pulls`), as stored. */
export type StoredLinks = { links: unknown; detected: unknown; pulls: string[] };

export function linksIn(text: string): SessionLink[] {
  const links = new Map<string, SessionLink>();
  for (const match of text.matchAll(/\bhttps?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/([1-9]\d*)(?=$|[\s/#?\])}>.,;:!"'`])/gi)) {
    const [, repo, type, number] = match;
    const kind = type.toLowerCase() === "pull" ? "PR" : "Issue";
    const url = `https://github.com/${repo}/${kind === "PR" ? "pull" : "issues"}/${number}`;
    if (!links.has(url.toLowerCase())) links.set(url.toLowerCase(), { url, kind, repo, number });
  }
  return [...links.values()];
}

// Tokenize only simple commands, preserving quoted arguments. Never execute
// transcript text. Compound shell scripts are deliberately left ambiguous.
function commandArgs(command: string, depth = 0): string[] {
  if (depth > 3) return [];
  // Claude commonly sends the PR body on stdin via a heredoc. Parse just
  // the command header; body text must never be interpreted as commands.
  const heredoc = command.match(/^([^\n]*?)\s+<<(-?)(?:'([\w]+)'|"([\w]+)"|([\w]+))\r?\n/);
  if (heredoc) {
    const delimiter = heredoc[3] ?? heredoc[4] ?? heredoc[5];
    const lines = command.slice(heredoc[0].length).split(/\r?\n/);
    const end = lines.findIndex((line) => (heredoc[2] ? line.replace(/^\t+/, "") : line) === delimiter);
    if (end < 0 || lines.slice(end + 1).some((line) => line.trim())) return [];
    return commandArgs(heredoc[1], depth + 1);
  }
  const args: string[] = [];
  let word = "", quote = "", started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\" && quote !== "'") {
      if (i + 1 === command.length) return [];
      word += command[++i];
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/[;&|<>`$\n]/.test(char)) return [];
    else if (/\s/.test(char)) {
      if (started) args.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return [];
  if (started) args.push(word);
  if (/^(?:.*\/)?(?:ba|z|da)?sh$/.test(args[0] ?? "") && /^-[a-z]*c[a-z]*$/.test(args[1] ?? "") && args.length === 3) {
    return commandArgs(args[2], depth + 1);
  }
  return args;
}

function commandLinks(command: string, output: string, includeReadOnly = false): SessionLink[] {
  const args = commandArgs(command);
  if (!/^(?:.*\/)?gh$/.test(args[0] ?? "") || !["pr", "issue"].includes(args[1])) return [];
  const kind = args[1] === "pr" ? "PR" : "Issue";
  const action = args[2];
  if (action === "create") return linksIn(output).filter((link) => link.kind === kind);
  // Viewing/listing an unrelated PR is common research. Actions on a specific
  // target (including the screenshot's reviewer edit) establish active work.
  if (!["edit", "review", "checkout", "ready", "merge", "close", "reopen", "comment", ...(includeReadOnly ? ["view", "checks", "diff"] : [])].includes(action)) return [];
  const target = args[3] ?? "";
  const direct = linksIn(target).filter((link) => link.kind === kind);
  if (direct.length === 1) return direct;
  if (!/^[1-9]\d*$/.test(target)) return [];
  let repo = "";
  for (let i = 4; i < args.length; i++) {
    if (args[i] === "--repo" || args[i] === "-R") repo = args[++i] ?? "";
    else if (args[i].startsWith("--repo=")) repo = args[i].slice(7);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return [];
  return linksIn(`https://github.com/${repo}/${kind === "PR" ? "pull" : "issues"}/${target}`);
}

export function parseSessionLink(value: string, kind: SessionLink["kind"]): SessionLink | undefined {
  try {
    const url = new URL(value.trim());
    if (url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.port) return;
    if (!/^\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/[1-9]\d*(?:\/.*)?$/.test(url.pathname)) return;
    const link = linksIn(url.href)[0];
    return link?.kind === kind ? link : undefined;
  } catch {
    return;
  }
}

/** Ends the first line of every message Aura, not the user, sends an agent (`aura_core::prompts::AURA_MARK`). */
const AURA_MARK = "This message comes from Aura, not the user.";

/** The user's own message: a user message that is not from Aura (former lib/auraMessage `isUserMessage`). */
export function isUserMessage(item: Pick<Item, "kind" | "text">): boolean {
  if (item.kind !== "user_message") return false;
  if (!item.text.startsWith("[Aura] ")) return true;
  const end = item.text.indexOf("\n");
  const first = end < 0 ? item.text : item.text.slice(0, end);
  return !first.endsWith(AURA_MARK);
}

/** Broad collection is for the picker only, never automatic selection. */
export function mentionedSessionLinks(items: Record<string, Item>, title = "", repo?: string): SessionLink[] {
  const links = new Map<string, SessionLink>();
  const add = (link: SessionLink) => links.set(link.url.toLowerCase(), link);
  function scan(value: unknown) {
    if (typeof value === "string") linksIn(value).forEach(add);
    else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === "object") Object.values(value).forEach(scan);
  }
  scan(title);
  requestedLinks(title, repo).forEach(add);
  for (const item of Object.values(items)) {
    scan(item.text);
    if (isUserMessage(item)) requestedLinks(item.text, repo).forEach(add);
    scan(item.data);
    if (typeof item.data.command === "string") commandLinks(item.data.command, "", true).forEach(add);
  }
  return [...links.values()];
}

export function selectedSessionLinks(automatic: SessionLink[], preferences: LinkPreferences = {}): SessionLink[] {
  return (["Issue", "PR"] as const).flatMap((kind) => {
    const chosen = preferences[kind === "Issue" ? "issues" : "prs"];
    if (!chosen) return automatic.filter((link) => link.kind === kind);
    return chosen.flatMap((url) => parseSessionLink(url, kind) ?? []);
  });
}

// Asking an agent to act on an issue or PR. Past tense and reading verbs
// ("fixed", "look at") are deliberately absent.
const WORK_VERB = /\b(?:work(?:ing)? on|start(?:ing)? (?:work(?:ing)? )?on|fix|implement|address|resolve|review|continue (?:with|on)|switch to|pick up|tackle|handle|solve|investigate|look into|take a look at|finish)\b/i;
// A link after one of these is background for the task, not the task.
const REFERENCE = /\b(?:like|similar|same|compare[ds]?|comparing|see|unlike|than|related|vs|versus|based|inspired|mentioned|context|except)\b/i;
// "Issue: <url>" and "Here is the issue: <url>" name the task without a verb.
const LABEL = /^\s*(?:here(?:'s| is)\s+)?(?:the\s+|my\s+)?(?:issue|task|ticket|pr|pull request)\s*[:：]/i;
const MAX_WORDS_BEFORE_TARGET = 6;
const REF = /https?:\/\/github\.com\/[^\s)\]]+|\b([\w.-]+\/[\w.-]+)#([1-9]\d*)\b|\b(issues?|prs?|pull requests?)\s*#?([1-9]\d*)\b|(?<![\w/&])#([1-9]\d*)\b/gi;

function uniqueLinks(links: SessionLink[]): SessionLink[] {
  return [...new Map(links.map((link) => [link.url.toLowerCase(), link])).values()];
}

function issueOrPr(repo: string, kind: SessionLink["kind"], number: string): SessionLink[] {
  return linksIn(`https://github.com/${repo}/${kind === "PR" ? "pull" : "issues"}/${number}`);
}

/** Issue and PR references in text: URLs, owner/repo#12, "issue 12", and #12 in `repo`. */
function refsIn(text: string, kind: SessionLink["kind"], repo?: string): { index: number; links: SessionLink[] }[] {
  const refs: { index: number; links: SessionLink[] }[] = [];
  for (const match of text.matchAll(REF)) {
    const [whole, fullRepo, fullNumber, word, wordNumber, number] = match;
    let links: SessionLink[] = [];
    if (fullRepo) links = issueOrPr(fullRepo, kind, fullNumber);
    else if (word) links = repo ? issueOrPr(repo, /^p/i.test(word) ? "PR" : "Issue", wordNumber) : [];
    else if (number) links = repo ? issueOrPr(repo, kind, number) : [];
    else links = linksIn(whole);
    if (links.length) refs.push({ index: match.index ?? 0, links });
  }
  return refs;
}

/**
 * Issues and PRs the user asks the agent to work on: a work verb followed
 * closely by the reference, a "Issue:" label, or a link alone on its line.
 * `repo` resolves bare numbers such as "#12".
 */
function requestedLinks(text: string, repo?: string): SessionLink[] {
  const targets: SessionLink[] = [];
  for (const line of text.split(/\n/)) {
    if (/^\s*https?:\/\/\S+\s*$/.test(line)) {
      targets.push(...linksIn(line));
      continue;
    }
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
      const verb = sentence.match(WORK_VERB);
      const label = verb ? undefined : sentence.match(LABEL);
      if (!verb && !label) continue;
      const start = verb ? verb.index! + verb[0].length : label![0].length;
      let span = sentence.slice(start);
      const cut = span.search(REFERENCE);
      if (cut >= 0) span = span.slice(0, cut);
      const kind = (verb && /^review$/i.test(verb[0])) || /\b(?:pr|pull request)\b/i.test(span) ? "PR" : "Issue";
      const refs = refsIn(span, kind, repo);
      if (!refs.length) continue;
      if (span.slice(0, refs[0].index).split(/\s+/).filter(Boolean).length > MAX_WORDS_BEFORE_TARGET) continue;
      for (const ref of refs) targets.push(...ref.links);
    }
  }
  return uniqueLinks(targets);
}

/** Only explicit task context establishes a link; incidental mentions do not. */
export function sessionLinks(items: Record<string, Item>, title = "", repo?: string): SessionLink[] {
  const selected = new Map<SessionLink["kind"], SessionLink>();
  let requestedLink: SessionLink["kind"] | undefined;
  function select(links: SessionLink[], switchTask = false) {
    // Multiple candidates of the same kind are ambiguous, not a work target.
    const targets = links.filter((link) => links.filter((other) => other.kind === link.kind).length === 1);
    if (switchTask && targets.some((link) => {
      const previous = selected.get(link.kind);
      return previous && previous.url.toLowerCase() !== link.url.toLowerCase();
    })) selected.clear();
    for (const link of targets) selected.set(link.kind, link);
  }
  select(uniqueLinks([...linksIn(title), ...requestedLinks(title, repo)]));
  for (const item of Object.values(items)) {
    if (item.parent_id) continue;
    // What Aura tells the agent (a worker's report, say) is no request of the user's.
    if (isUserMessage(item)) {
      requestedLink = /\b(?:where|link|url)\b/i.test(item.text)
        ? /\b(?:PR|pull request)\b/i.test(item.text) ? "PR" : /\bissue\b/i.test(item.text) ? "Issue" : undefined
        : undefined;
      select(requestedLinks(item.text, repo), true);
    } else if (item.kind === "agent_message") {
      const targets: SessionLink[] = [];
      for (const line of item.text.split(/\n/)) {
        const prose = line.replace(/^\s*[-*]\s+/, "").replace(/\*\*/g, "").trim().replace(/^Done[.!]\s*/i, "");
        if (/^(?:(?:I(?:'ve| have)?|We(?:'ve| have)?)\s+)?(?:created|opened|updated|fixed|resolved|working on|current)\b/i.test(prose)
          || /^(?:(?:I|We)\s+)?requested\b.*\breview\s+on\s+/i.test(prose)
          || /^(?:PR|Pull request|Issue)\s*:\s*/i.test(prose)
          || /^(?:Draft\s+)?(?:PR|Pull request|Issue)\s+#?\d+\s+(?:is|has been)\s+(?:open(?:ed)?|created|updated)\b/i.test(prose)) {
          targets.push(...linksIn(line));
        } else if (requestedLink && /^https?:\/\/\S+$/.test(prose)) {
          targets.push(...linksIn(prose).filter((link) => link.kind === requestedLink));
        }
      }
      select([...new Map(targets.map((link) => [link.url.toLowerCase(), link])).values()]);
    } else if (item.kind === "command_exec" && item.status === "completed" && item.data.exit_code === 0) {
      const command = item.data.command;
      const output = item.data.output;
      if (typeof command === "string") {
        select(commandLinks(command, typeof output === "string" ? output : ""));
      }
    }
  }
  return [selected.get("Issue"), selected.get("PR")].filter((link): link is SessionLink => !!link);
}

/** A stored value as JSON: values copied from the former settings may still be JSON text. */
function parsed(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * The saved preferences, validated: the current form and the older one, which held one issue
 * and one PR (null for none). Throws on anything else, so a bad value is reported, not used.
 */
export function decodePreferences(raw: unknown): LinkPreferences {
  if (raw === null || raw === undefined || raw === "") return {};
  const value = parsed(raw) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved issue and PR selection");
  const preferences: LinkPreferences = {};
  for (const [key, old, kind] of [["issues", "issue", "Issue"], ["prs", "pr", "PR"]] as const) {
    const list = value[key] ?? (value[old] === undefined ? undefined : value[old] === null ? [] : [value[old]]);
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error("Invalid saved issue or PR selection");
    const urls: string[] = [];
    for (const url of list) {
      const link = typeof url === "string" ? parseSessionLink(url, kind) : undefined;
      if (!link) throw new Error("Invalid saved issue or PR URL");
      if (!urls.some((other) => other.toLowerCase() === link.url.toLowerCase())) urls.push(link.url);
    }
    preferences[key] = urls;
  }
  if (value.reviews !== undefined) {
    if (typeof value.reviews !== "boolean") throw new Error("Invalid saved review follow-up setting");
    if (!value.reviews) preferences.reviews = false;
  }
  return preferences;
}

/** The saved automatic links: a list of issue and PR URLs. Throws on anything else. */
export function decodeDetected(raw: unknown): SessionLink[] {
  if (raw === null || raw === undefined || raw === "") return [];
  const value = parsed(raw);
  if (!Array.isArray(value)) throw new Error("Invalid saved detected links");
  return value.map((url) => {
    const link = typeof url === "string" ? parseSessionLink(url, "Issue") ?? parseSessionLink(url, "PR") : undefined;
    if (!link) throw new Error("Invalid saved detected link");
    return link;
  });
}

const SAFE = /^[A-Za-z0-9_.-]+$/;
const safeRepo = (owner: string, name: string) => [owner, name].every((p) => p !== "" && p !== "." && p !== ".." && SAFE.test(p));

/** `owner/repo` and number of a github.com pull request URL (former `parse_pr_url`). */
export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const prefix = "https://github.com/";
  const trimmed = url.trim();
  if (!trimmed.startsWith(prefix)) return null;
  const [owner, name, kind, number] = trimmed.slice(prefix.length).split("/");
  if (owner === undefined || name === undefined || kind === undefined || number === undefined || kind !== "pull") return null;
  if (!safeRepo(owner, name) || !/^\d+$/.test(number)) return null;
  const n = Number(number);
  if (n <= 0 || n > 0xffffffff) return null;
  return { repo: `${owner}/${name}`, number: n };
}

/** `owner/repo` and number of a pull request URL, on github.com or an Enterprise host. */
export function pullOfUrl(url: string): { repo: string; number: number } | null {
  const match = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(url.trim());
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}

export const prUrl = (pr: { repo: string; number: number }) => `https://github.com/${pr.repo}/pull/${pr.number}`;

const samePr = (a: { repo: string; number: number }, b: { repo: string; number: number }) =>
  a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();

/**
 * The PRs a session is linked to: the links the user chose, else the ones detected in the
 * conversation (former `session_prs`). Lenient: what cannot be read counts as nothing.
 */
export function sessionPrs(links: unknown, detected: unknown): Array<{ repo: string; number: number }> {
  let prefs: any = null;
  let auto: unknown = null;
  try { prefs = parsed(links); } catch { prefs = null; }
  try { auto = parsed(detected); } catch { auto = null; }
  const isObject = prefs && typeof prefs === "object" && !Array.isArray(prefs);
  const urls: unknown[] = isObject && Array.isArray(prefs.prs)
    ? prefs.prs
    : isObject && "pr" in prefs
      ? [prefs.pr] // The older one-PR form; null meant none.
      : Array.isArray(auto) ? auto : [];
  const out: Array<{ repo: string; number: number }> = [];
  for (const url of urls) {
    if (typeof url !== "string") continue;
    const pr = parsePrUrl(url);
    if (pr && !out.some((other) => samePr(other, pr))) out.push(pr);
  }
  return out;
}

/** Whether review activity may go to the session: the user can turn it off per session (former `follows_reviews`). */
export function followsReviews(links: unknown): boolean {
  try {
    const prefs: any = parsed(links);
    return !(prefs && typeof prefs === "object" && prefs.reviews === false);
  } catch {
    return true;
  }
}

/** The PRs whose review activity may go to the session (former `linked_prs`): none when follow-ups are off. */
export function linkedPrs(links: unknown, detected: unknown): Array<{ repo: string; number: number }> {
  return followsReviews(links) ? sessionPrs(links, detected) : [];
}

export { samePr };
