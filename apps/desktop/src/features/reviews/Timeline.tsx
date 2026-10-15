import { useMemo, type ReactNode } from "react";
import type { PullRequest, ReviewThread, TimelineItem } from "../../gen";
import { ExternalLink } from "../../components/ExternalLink";
import type { PullDetail } from "../../lib/pulls";
import { exactTime, timeAgo } from "../../lib/time";
import { classifyDiffLine } from "../../views/transcript/format";
import { Markdown } from "../../views/transcript/MarkdownView";
import { buildTimeline, type Entry } from "./conversation";

/** Lines of a thread's diff hunk shown above it, ending at the commented line, as on GitHub. */
const HUNK_LINES = 4;

const NOTHING: Pick<PullDetail, "timeline" | "comments" | "reviews" | "threads"> = { timeline: { items: [], threads: [], commits: 0 }, comments: [], reviews: [], threads: [] };

/** The PR's conversation, oldest first. `description` is the body of its first entry. */
export function Timeline({ pull, detail, description, descriptionActions }: { pull: PullRequest; detail: PullDetail | null; description: ReactNode; descriptionActions?: ReactNode }) {
  const entries = useMemo(() => buildTimeline(pull, detail ?? NOTHING), [pull, detail]);
  return <ol className="pr-timeline" aria-label="Conversation">
    {entries.map((entry) => <li key={entry.key} className={`pr-tl-item ${entry.kind}`}>
      {entry.kind === "description" ? <Card author={pull.author} at={pull.created_at} url={pull.url} verb="opened this pull request" actions={descriptionActions}>{description}</Card> : <TimelineEntry entry={entry} />}
    </li>)}
    {!detail && <li className="pr-tl-item event"><span className="pr-muted">Loading conversation…</span></li>}
  </ol>;
}

function TimelineEntry({ entry }: { entry: Exclude<Entry, { kind: "description" }> }) {
  switch (entry.kind) {
    case "comment": return <Card author={entry.item.actor} at={entry.at} url={entry.item.url}><Markdown text={entry.item.body || "No description provided."} /></Card>;
    case "review": return <Review item={entry.item} threads={entry.threads} />;
    case "thread": return <><EventRow icon="◦" actor={entry.thread.comments[0].author} at={entry.at}>commented on <code>{entry.thread.path}</code></EventRow><Thread thread={entry.thread} /></>;
    case "commits": return <Commits items={entry.items} />;
    case "event": return <Event item={entry.item} />;
  }
}

export function Avatar({ login }: { login: string }) {
  let hue = 0;
  for (const ch of login) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return <span className="pr-avatar" aria-hidden style={{ "--hue": hue } as React.CSSProperties}>{(login[0] ?? "?").toUpperCase()}</span>;
}

export function Time({ at }: { at: string }) {
  const ago = timeAgo(at);
  return ago ? <time dateTime={at} title={exactTime(at)}>{ago}</time> : null;
}

function Card({ author, at, url, verb = "commented", actions, children }: { author: string; at: string; url?: string; verb?: string; actions?: ReactNode; children: ReactNode }) {
  return <article className="pr-tl-card">
    <Avatar login={author} />
    <header><strong>{author}</strong><span className="pr-muted">{verb} <Time at={at} /></span><span className="spacer" />{actions}{url && <ExternalLink href={url} aria-label="Open on GitHub">↗</ExternalLink>}</header>
    <div className="pr-tl-body">{children}</div>
  </article>;
}

function EventRow({ icon, tone, actor, at, children }: { icon: string; tone?: string; actor: string; at: string; children: ReactNode }) {
  return <div className="pr-tl-event"><span className={`pr-tl-icon ${tone ?? ""}`} aria-hidden>{icon}</span><span><strong>{actor}</strong> {children} <span className="pr-muted"><Time at={at} /></span></span></div>;
}

const REVIEW: Record<string, { icon: string; tone?: string; verb: string }> = {
  APPROVED: { icon: "✓", tone: "ok", verb: "approved these changes" },
  CHANGES_REQUESTED: { icon: "±", tone: "err", verb: "requested changes" },
  DISMISSED: { icon: "◦", verb: "reviewed (dismissed)" },
  PENDING: { icon: "◦", verb: "has a pending review" },
};

function Review({ item, threads }: { item: TimelineItem; threads: ReviewThread[] }) {
  const look = REVIEW[item.state] ?? { icon: "◦", verb: "reviewed" };
  return <div className="pr-tl-review">
    <EventRow icon={look.icon} tone={look.tone} actor={item.actor} at={item.at}>{look.verb}{item.url && <> · <ExternalLink href={item.url}>View ↗</ExternalLink></>}</EventRow>
    {(item.body.trim() || threads.length > 0) && <div className="pr-tl-nested">
      {item.body.trim() && <Card author={item.actor} at={item.at} verb="left a comment"><Markdown text={item.body} /></Card>}
      {threads.map((t) => <Thread key={t.id} thread={t} />)}
    </div>}
  </div>;
}

export function Thread({ thread }: { thread: ReviewThread }) {
  const hunk = thread.diff_hunk.split("\n").filter((l) => !l.startsWith("@@")).slice(-HUNK_LINES);
  const line = thread.line ?? thread.original_line;
  const last = thread.comments[thread.comments.length - 1];
  return <details className={`pr-thread${thread.resolved ? " resolved" : ""}`} open={!thread.resolved}>
    <summary><code>{thread.path}{line ? `:${line}` : ""}</code>{thread.outdated && <span className="chip">Outdated</span>}{thread.resolved && <span className="chip ok">Resolved{thread.resolved_by && ` by ${thread.resolved_by}`}</span>}{thread.resolved && <span className="pr-muted">{thread.comments.length} {thread.comments.length === 1 ? "comment" : "comments"}</span>}</summary>
    {hunk.length > 0 && <div className="pr-diff-lines pr-thread-hunk">{hunk.map((l, i) => <div key={i} className={`pr-diff-line ${classifyDiffLine(l)}`}><code>{l}</code></div>)}</div>}
    {thread.comments.map((c) => <div key={c.id} className="pr-thread-comment">
      <header><Avatar login={c.author} /><strong>{c.author}</strong><span className="pr-muted"><Time at={c.at} /></span><span className="spacer" />{c.url && <ExternalLink href={c.url} aria-label="Open on GitHub">↗</ExternalLink>}</header>
      <Markdown text={c.body || "No comment body."} />
    </div>)}
    {thread.more > 0 && last && <p className="pr-thread-more"><ExternalLink href={last.url}>{thread.more} more {thread.more === 1 ? "reply" : "replies"} on GitHub ↗</ExternalLink></p>}
  </details>;
}

function Commits({ items }: { items: TimelineItem[] }) {
  const actors = [...new Set(items.map((i) => i.actor || "someone"))];
  return <div className="pr-tl-commits">
    <EventRow icon="●" actor={actors.join(", ")} at={items[items.length - 1].at}>added {items.length} {items.length === 1 ? "commit" : "commits"}</EventRow>
    <ul>{items.map((c) => <li key={c.id}><span className="pr-commit-message">{c.subject}</span>{c.url ? <ExternalLink href={c.url}><code>{c.sha.slice(0, 7)}</code></ExternalLink> : <code>{c.sha.slice(0, 7)}</code>}</li>)}</ul>
  </div>;
}

const short = (sha: string) => <code>{sha.slice(0, 7)}</code>;

function Label({ name, color }: { name: string; color: string }) {
  return <span className="chip pr-label" style={/^[0-9a-f]{6}$/i.test(color) ? { "--label": `#${color}` } as React.CSSProperties : undefined}>{name}</span>;
}

/** An event in GitHub's words. */
function Event({ item }: { item: TimelineItem }) {
  const self = item.actor === item.subject;
  const [icon, tone, text]: [string, string | undefined, ReactNode] = (() => {
    switch (item.kind) {
      case "force_pushed": return ["⇡", undefined, <>force-pushed the branch from {short(item.before)} to {short(item.sha)}</>];
      case "review_requested": return ["◎", undefined, self ? "self-requested a review" : <>requested a review from <strong>{item.subject}</strong></>];
      case "review_request_removed": return ["◎", undefined, <>removed the request for review from <strong>{item.subject}</strong></>];
      case "labeled": return ["◆", undefined, <>added the <Label name={item.subject} color={item.color} /> label</>];
      case "unlabeled": return ["◇", undefined, <>removed the <Label name={item.subject} color={item.color} /> label</>];
      case "assigned": return ["●", undefined, self ? "self-assigned this" : <>assigned <strong>{item.subject}</strong></>];
      case "unassigned": return ["○", undefined, self ? "removed their assignment" : <>unassigned <strong>{item.subject}</strong></>];
      case "ready_for_review": return ["◉", undefined, "marked this pull request as ready for review"];
      case "converted_to_draft": return ["◌", undefined, "marked this pull request as draft"];
      case "merged": return ["⇄", "merged", <>merged commit {short(item.sha)} into <code>{item.subject}</code></>];
      case "closed": return ["✕", "err", "closed this"];
      case "reopened": return ["↺", "ok", "reopened this"];
      case "head_ref_deleted": return ["⌫", undefined, <>deleted the <code>{item.subject}</code> branch</>];
      case "head_ref_restored": return ["↺", undefined, "restored the head branch"];
      case "renamed": return ["✎", undefined, <>changed the title <del>{item.previous}</del> {item.subject}</>];
      case "milestoned": return ["⚑", undefined, <>added this to the <strong>{item.subject}</strong> milestone</>];
      case "demilestoned": return ["⚑", undefined, <>removed this from the <strong>{item.subject}</strong> milestone</>];
      case "referenced": return ["↗", undefined, <>mentioned this in {item.url ? <ExternalLink href={item.url}>{item.subject}</ExternalLink> : item.subject}</>];
      case "review_dismissed": return ["✕", undefined, <>dismissed <strong>{item.subject}</strong>’s review{item.body && <span className="pr-muted"> · {item.body}</span>}</>];
      default: return ["◦", undefined, item.kind.replaceAll("_", " ")];
    }
  })();
  return <EventRow icon={icon} tone={tone} actor={item.actor} at={item.at}>{text}</EventRow>;
}
