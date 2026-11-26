// An orchestrator's tools for Aura's pull request reviews (former aura-cli
// mcp/reviews.rs): they read the user's review inbox and record, change and
// discard pre-review drafts, which the user then sees in Aura as if Aura's own
// pre-review had written them. Each calls an `orchestrator.reviews.*` method.
// Posting a review to GitHub stays the user's: no tool here does it.
import type { Json, ToolDef } from "@aura/mod-sdk";
import type { PreReview, PullRequest, ReviewInbox } from "@aura/github-client";
import { signature } from "./reviews";

/** Tool names, in the order the tools are listed. */
export const NAMES = [
  "list_pull_requests",
  "read_pull_review",
  "create_review",
  "update_review",
  "add_review_comment",
  "edit_review_comment",
  "delete_review_comment",
  "discard_review",
  "start_pre_review",
  "hide_pull_request",
] as const;

const METHODS: Record<string, string> = {
  list_pull_requests: "orchestrator.reviews.list",
  read_pull_review: "orchestrator.reviews.get",
  create_review: "orchestrator.reviews.create",
  update_review: "orchestrator.reviews.update",
  add_review_comment: "orchestrator.reviews.add_comment",
  edit_review_comment: "orchestrator.reviews.edit_comment",
  delete_review_comment: "orchestrator.reviews.delete_comment",
  discard_review: "orchestrator.reviews.discard",
  start_pre_review: "orchestrator.reviews.start",
  hide_pull_request: "orchestrator.reviews.hide",
};

/** The method a tool calls, and its parameters: the tool's own arguments, as given, for the orchestrator `o`. */
export function request(tool: string, o: string, a: unknown): [string, Record<string, unknown>] | null {
  const method = METHODS[tool];
  if (!method) return null;
  const p: Record<string, unknown> = a && typeof a === "object" && !Array.isArray(a) ? { ...(a as object) } : {};
  p.orchestrator = o;
  return [method, p];
}

/** What the tool says back, from the method's reply. */
export function reply(tool: string, a: any, v: any): string {
  const diff = a?.include_diff === true;
  switch (tool) {
    case "list_pull_requests":
      return describeInbox(v as ReviewInbox, a?.include_hidden === true);
    case "read_pull_review": {
      if (v && v.pull !== undefined && v.config === undefined) {
        const pull = v.pull as PullRequest;
        const reviews = (v.reviews ?? []) as PreReview[];
        let out = `${pullLine(pull)}\n`;
        if (reviews.length === 0) out += "\nNo pre-reviews of it yet. Record one with create_review.";
        else {
          out += "\nPre-reviews, latest first (read one with `review` for its findings and diff):\n";
          for (const r of reviews) {
            out += `- \`${r.id}\` ${r.status} · ${r.result.verdict} · ${r.result.comments.filter((c) => !c.deleted).length} findings · ${r.created_at}\n`;
          }
        }
        return out;
      }
      return describeReview(v as PreReview, diff);
    }
    case "create_review": {
      const r = v as PreReview;
      return `Recorded pre-review \`${r.id}\`.\n\n${describeReview(r, false)}`;
    }
    case "add_review_comment":
      return `Added finding \`${typeof v?.comment === "string" ? v.comment : ""}\`.\n\n${describeReview(v.review as PreReview, false)}`;
    case "update_review":
    case "edit_review_comment":
    case "delete_review_comment":
      return describeReview(v as PreReview, false);
    case "discard_review": {
      const r = v as PreReview;
      return `Discarded pre-review \`${r.id}\` of ${r.pull.id}; nothing was posted to GitHub.`;
    }
    case "start_pre_review": {
      const r = v as PreReview;
      return `Aura's own pre-review \`${r.id}\` of ${r.pull.id} is ${r.status} with ${
        r.agent ? signature(r.agent) : r.config.provider
      }. It runs on its own; read_pull_review shows when it is ready.`;
    }
    case "hide_pull_request":
      return a?.hidden !== false
        ? "Hidden from the user's pull request list; they can show hidden PRs to see it again."
        : "Restored to the user's pull request list.";
    default:
      return JSON.stringify(v);
  }
}

/** What a draft's status means to the user and to the orchestrator. */
function statusMeaning(status: string): string {
  switch (status) {
    case "ready":
      return "ready for the user: it shows in Aura's pull request list and they can edit it and post it to GitHub";
    case "drafting":
      return "being written: the user sees it but cannot edit it until you set `ready`";
    case "queued":
    case "running":
      return "Aura's own pre-review is running";
    case "submitted":
      return "the user posted it to GitHub";
    case "submitting":
    case "uncertain":
      return "the user is posting it to GitHub";
    case "failed":
      return "Aura's pre-review failed";
    case "cancelled":
      return "cancelled";
    case "discarded":
      return "discarded";
    default:
      return "unknown";
  }
}

/** One line about a PR: who, where it stands, and why the user has it. */
function pullLine(p: PullRequest): string {
  const facts = [`by ${p.author}`];
  if (p.draft) facts.push("draft");
  if (p.state !== "open") facts.push(p.state);
  if (p.checks) facts.push(`checks ${p.checks.toLowerCase()}`);
  if (p.review_decision) facts.push(p.review_decision.toLowerCase().replaceAll("_", " "));
  if (p.my_review) facts.push(`the user ${p.my_review.state.toLowerCase().replaceAll("_", " ")}`);
  if (p.hidden) facts.push("hidden");
  return `${p.id} "${p.title}" (${facts.join(", ")})`;
}

export function describeInbox(inbox: ReviewInbox, includeHidden: boolean): string {
  if (!inbox.account) {
    return `Aura has no GitHub login yet${inbox.error ? ` (${inbox.error})` : ""}. The user signs in with \`gh auth login\`.`;
  }
  let out = `The user's pull requests on GitHub as ${inbox.account}`;
  if (inbox.last_synced) out += `, read ${inbox.last_synced}`;
  out += ".\n";
  const why = inbox.blocked ?? inbox.error;
  if (why) out += `Note: ${why}\n`;
  const listed: string[] = [];
  for (const [title, pulls] of [
    ["Needs the user's review", inbox.pulls],
    ["The user reviewed", inbox.reviewed ?? []],
    ["The user's own", inbox.mine ?? []],
  ] as Array<[string, PullRequest[]]>) {
    const shown = pulls.filter((p) => includeHidden || !p.hidden);
    out += `\n${title} (${shown.length}):\n`;
    if (shown.length === 0) out += "- none\n";
    for (const p of shown) {
      listed.push(p.id);
      out += `- ${pullLine(p)}`;
      const r = latest(inbox, p.id);
      if (r) out += ` · pre-review \`${r.id}\` ${r.status}`;
      out += "\n";
    }
  }
  const others = inbox.reviews.filter((r) => r.status !== "discarded" && !listed.includes(r.pull.id));
  if (others.length > 0) {
    out += "\nPre-reviews of PRs not on these lists:\n";
    for (const r of others) out += `- \`${r.id}\` ${r.status} of ${r.pull.id} "${r.pull.title}"\n`;
  }
  return out;
}

/** The latest pre-review of a PR the user has not discarded, as the app shows it. */
function latest(inbox: ReviewInbox, pull: string): PreReview | undefined {
  return inbox.reviews.find((r) => r.pull.id === pull && r.status !== "discarded");
}

/** Diffs longer than this (in characters) are cut short in read_pull_review. */
const DIFF_LIMIT = 60_000;

export function describeReview(r: PreReview, includeDiff: boolean): string {
  let out = `Pre-review \`${r.id}\` of ${r.pull.id} "${r.pull.title}" at revision ${r.revision}: ${r.status} (${statusMeaning(r.status)}).\n`;
  if (r.agent) out += `Signed: ${signature(r.agent)}\n`;
  if (r.source) {
    const s = r.source;
    const from = s.worker_title != null && s.worker != null ? `, from the review by its worker ${s.worker_title} (\`${s.worker}\`)` : "";
    out += `Recorded by the orchestrator ${s.orchestrator_title} (\`${s.orchestrator}\`)${from}\n`;
  }
  if (r.reviewed_sha) {
    out += `Reviewed commit: ${short(r.reviewed_sha)}`;
    if (r.reviewed_sha !== r.pull.head_sha) out += ` (the PR was at ${short(r.pull.head_sha)} when Aura last read it)`;
    out += "\n";
  }
  if (r.error) out += `Error: ${r.error}\n`;
  if (r.submitted_url) out += `Posted: ${r.submitted_url}\n`;
  const res = r.result;
  out += `Verdict: ${res.verdict} · risk ${res.risk}`;
  if (res.confidence != null) out += ` · confidence ${Math.round(res.confidence * 100)}%`;
  out += "\n\nSummary:\n";
  out += res.summary.trim() === "" ? "(none)" : res.summary.trim();
  out += `\n\nFindings (${res.comments.length}):\n`;
  if (res.comments.length === 0) out += "- none\n";
  for (const c of res.comments) {
    const lines = c.start_line != null ? `${c.start_line}-${c.line}` : `${c.line}`;
    const tags = [c.severity];
    if (c.user_authored) tags.push("the user's");
    else if (c.edited) tags.push("edited by the user");
    if (c.deleted) tags.push("deleted");
    out += `- \`${c.id}\` ${c.path}:${lines} ${c.side} [${tags.join(", ")}]: ${c.body.trim()}\n`;
    if (c.position_note) out += `  ${c.position_note}\n`;
    if (c.rationale != null) out += `  Rationale (never posted): ${c.rationale.trim()}\n`;
  }
  if (includeDiff && r.diff) {
    const chars = Array.from(r.diff);
    const cut = chars.length > DIFF_LIMIT;
    out += `\nReviewed diff:\n\`\`\`diff\n${cut ? chars.slice(0, DIFF_LIMIT).join("") : r.diff}\n\`\`\`\n`;
    if (cut) out += `(cut short after ${DIFF_LIMIT} characters)\n`;
  }
  if (r.status === "ready" || r.status === "drafting") out += "\nPosting it to GitHub is the user's: they review and submit it in Aura.";
  return out;
}

const short = (sha: string) => sha.slice(0, 10);

const pullProp = (): Json => ({
  type: "string",
  description: "The pull request as `owner/repo#number`, e.g. `wortell/vidara.portal#2730`, or its GitHub URL.",
});
const reviewProp = (): Json => ({
  type: "string",
  description: "The pre-review's id, from list_pull_requests, read_pull_review or create_review.",
});
const revisionProp = (): Json => ({
  type: "integer",
  minimum: 0,
  description:
    "The revision you last read. When given, the change is refused if the draft changed since, for example because the user edited it.",
});
function findingProps(): Record<string, Json> {
  return {
    path: { type: "string", description: "Repository-relative file path." },
    line: { type: "integer", minimum: 1, description: "The line in the diff: in the new file for RIGHT, in the old file for LEFT." },
    start_line: { type: ["integer", "null"], minimum: 1, description: "First line of a multi-line finding; null for one line." },
    side: { type: "string", enum: ["RIGHT", "LEFT"], description: "RIGHT (default) for added or unchanged lines, LEFT for deleted ones." },
    severity: { type: "string", enum: ["blocker", "major", "minor", "nit", "praise"], description: "Default minor." },
    body: { type: "string", description: "The comment as it would be posted. Markdown." },
    rationale: { type: "string", description: "Private reasoning the user sees but that is never posted." },
  };
}
const findingsProp = (what: string): Json => ({
  type: "array",
  description: what,
  items: { type: "object", properties: findingProps(), required: ["path", "line", "body"] },
});

/**
 * The tools' definitions. SDK-GAP: `ToolDef` has no `annotations`, so the old
 * `readOnlyHint` (list_pull_requests, read_pull_review) and `destructiveHint`
 * (discard_review) are not sent.
 */
export function tools(): ToolDef[] {
  return [
    {
      name: "list_pull_requests",
      description:
        "List the user's pull requests as Aura's pull request list shows them: the ones that need the user's review, the ones they reviewed, and their own, each with the state of its latest pre-review. A pre-review is a review draft in Aura that the user edits and posts to GitHub.",
      inputSchema: {
        type: "object",
        properties: {
          refresh: {
            type: "boolean",
            description: "Read GitHub again first, as the user's refresh button does. Default false: Aura's last read, at most a few minutes old.",
          },
          include_hidden: { type: "boolean", description: "Include PRs the user hid. Default false." },
        },
      },
    },
    {
      name: "read_pull_review",
      description:
        "Read a pre-review: its status, revision, verdict, summary and findings with their ids, whether each finding falls inside the reviewed diff, and optionally the diff itself. Or give `pull` to see a PR and the ids of its pre-reviews.",
      inputSchema: {
        type: "object",
        properties: {
          review: reviewProp(),
          pull: pullProp(),
          include_diff: { type: "boolean", description: "With `review`: include the reviewed diff, to place findings on its lines. Default false." },
        },
      },
    },
    {
      name: "create_review",
      description:
        "Record a review of a pull request, usually one a worker did, as a pre-review in Aura: it shows in the user's pull request list as ready, signed with the agent that did it, and the user edits and posts it to GitHub as they do Aura's own pre-reviews. You cannot post it. Findings must be on lines of the PR's diff to post inline; others go in the review body. Give everything at once, or set `ready` false while you add findings and true when done.",
      inputSchema: {
        type: "object",
        properties: {
          pull: pullProp(),
          verdict: { type: "string", enum: ["approve", "comment", "request_changes"] },
          summary: { type: "string", description: "The review body: what the PR does and the overall judgement. Markdown." },
          risk: { type: "string", enum: ["low", "medium", "high"], description: "Default medium." },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          comments: findingsProp("Inline findings."),
          worker: {
            type: "string",
            description:
              "The worker session that did the review (id, unique prefix or title); the review is signed with its agent, model and effort. Default: you.",
          },
          agent: {
            type: "object",
            description: "Sign the review with this agent instead of the worker's or yours.",
            properties: {
              provider: { type: "string", description: "e.g. `Codex`, `Claude Code`." },
              model: { type: "string" },
              model_id: { type: "string", description: "The exact model id, when known." },
              effort: { type: "string" },
            },
            required: ["provider"],
          },
          commit: { type: "string", description: "The commit that was reviewed, when not the PR's current head." },
          ready: {
            type: "boolean",
            description:
              "Default true: ready for the user now. False keeps it as being written, which the user sees but cannot edit, until update_review sets ready.",
          },
        },
        required: ["pull", "verdict"],
      },
    },
    {
      name: "update_review",
      description:
        "Change a pre-review that is ready or being written: summary, verdict, risk or confidence, replace your findings, or set it ready for the user. Findings the user wrote or edited are never changed or removed.",
      inputSchema: {
        type: "object",
        properties: {
          review: reviewProp(),
          revision: revisionProp(),
          summary: { type: "string" },
          verdict: { type: "string", enum: ["approve", "comment", "request_changes"] },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          comments: findingsProp("Replaces every finding that is not the user's."),
          ready: { type: "boolean", description: "True hands a draft being written to the user. A ready draft cannot go back." },
        },
        required: ["review"],
      },
    },
    {
      name: "add_review_comment",
      description: "Add an inline finding to a pre-review that is ready or being written.",
      inputSchema: {
        type: "object",
        properties: { ...findingProps(), review: reviewProp(), revision: revisionProp() },
        required: ["review", "path", "line", "body"],
      },
    },
    {
      name: "edit_review_comment",
      description:
        "Change a finding of a pre-review: its text, severity, line, side or file. Only the given fields change. Findings the user wrote or edited are theirs and cannot be changed.",
      inputSchema: {
        type: "object",
        properties: {
          ...findingProps(),
          review: reviewProp(),
          comment: { type: "string", description: "The finding's id, from read_pull_review." },
          revision: revisionProp(),
        },
        required: ["review", "comment"],
      },
    },
    {
      name: "delete_review_comment",
      description:
        "Delete a finding from a pre-review, as the user's Delete button does: it is struck through and never posted, and `restore` brings it back. Findings the user wrote or edited cannot be deleted.",
      inputSchema: {
        type: "object",
        properties: {
          review: reviewProp(),
          comment: { type: "string", description: "The finding's id, from read_pull_review." },
          restore: { type: "boolean", description: "Bring a deleted finding back. Default false." },
          revision: revisionProp(),
        },
        required: ["review", "comment"],
      },
    },
    {
      name: "discard_review",
      description:
        "Discard a pre-review, as the user's Discard button does, or cancel one of Aura's own that is still running. Nothing is posted to GitHub. A review the user posted cannot be discarded.",
      inputSchema: { type: "object", properties: { review: reviewProp() }, required: ["review"] },
    },
    {
      name: "start_pre_review",
      description:
        "Start Aura's own pre-review of a PR, as the user's Pre-review button does: Aura checks the PR out and has Claude Code or Codex review it read-only, then the draft is ready for the user. Use it instead of a worker when Aura's built-in review is enough.",
      inputSchema: {
        type: "object",
        properties: {
          pull: pullProp(),
          agent: { type: "string", enum: ["codex", "claude"], description: "Default: the user's last choice." },
          model: { type: "string", description: "Model id from list_agents. Default: the agent's default." },
          effort: { type: "string", description: "Reasoning effort from list_agents." },
          instructions: { type: "string", description: "What to look at, added to Aura's review instructions." },
        },
        required: ["pull"],
      },
    },
    {
      name: "hide_pull_request",
      description: "Hide a PR from the user's pull request list, as the × on it does, or restore it.",
      inputSchema: {
        type: "object",
        properties: {
          pull: pullProp(),
          hidden: { type: "boolean", description: "Default true; false restores it." },
        },
        required: ["pull"],
      },
    },
  ];
}
