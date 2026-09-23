import type { Item } from "../gen";

export type SessionLink = { url: string; kind: "Issue" | "PR"; repo: string; number: string };

function linksIn(text: string): SessionLink[] {
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

export type LinkPreferences = { issue?: string | null; pr?: string | null };

export function parseSessionLink(value: string, kind: SessionLink["kind"]): SessionLink | undefined {
  try {
    const url = new URL(value.trim());
    if (url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.port) return;
    if (!/^\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/[1-9]\d*(?:\/.*)?$/.test(url.pathname)) return;
    const link = linksIn(url.href)[0];
    return link?.kind === kind ? link : undefined;
  } catch { return; }
}

/** Broad collection is for the picker only, never automatic selection. */
export function mentionedSessionLinks(items: Record<string, Item>, title = ""): SessionLink[] {
  const links = new Map<string, SessionLink>();
  const add = (link: SessionLink) => links.set(link.url.toLowerCase(), link);
  function scan(value: unknown) {
    if (typeof value === "string") linksIn(value).forEach(add);
    else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === "object") Object.values(value).forEach(scan);
  }
  scan(title);
  for (const item of Object.values(items)) {
    scan(item.text);
    scan(item.data);
    if (typeof item.data.command === "string") commandLinks(item.data.command, "", true).forEach(add);
  }
  return [...links.values()];
}

export function selectedSessionLinks(automatic: SessionLink[], preferences: LinkPreferences = {}): SessionLink[] {
  return (["Issue", "PR"] as const).flatMap((kind) => {
    const value = preferences[kind === "Issue" ? "issue" : "pr"];
    if (value === undefined) return automatic.filter((link) => link.kind === kind);
    const link = value === null ? undefined : parseSessionLink(value, kind);
    return link ? [link] : [];
  });
}

/** Only explicit task context establishes a link; incidental mentions do not. */
export function sessionLinks(items: Record<string, Item>, title = ""): SessionLink[] {
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
  select(linksIn(title));
  for (const item of Object.values(items)) {
    if (item.parent_id) continue;
    if (item.kind === "user_message") {
      requestedLink = /\b(?:where|link|url)\b/i.test(item.text)
        ? /\b(?:PR|pull request)\b/i.test(item.text) ? "PR" : /\bissue\b/i.test(item.text) ? "Issue" : undefined
        : undefined;
      const targets = item.text.split(/\n/).flatMap((line) => {
        const links = linksIn(line);
        // A bare link is a direct user target. Otherwise require an action
        // immediately before the link, so "compare with" references stay out.
        if (/^\s*https?:\/\/\S+\s*$/.test(line)) return links;
        const target = line.match(/\b(?:work on|working on|fix|implement|address|resolve|review|continue with|switch to|pick up)\s+(?:(?:this|the)\s+)?(?:(?:issue|pr|pull request)\s*)?(?:for\s+(?:me|us)\s*)?(?:please\s*)?[:：]?\s*(\[[^\]]*\]\()?https?:\/\/github\.com\/\S+/i);
        return target ? linksIn(target[0]) : [];
      });
      select(targets, true);
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
