import type { Autonomy, Checkpoint, Feature, FeatureCardKind, FeatureStatus, Item, Meeting, OneOnOne, UserQuestion } from "../gen";

/**
 * Feature owners, as the app shows them. The daemon puts a card in a feature
 * owner's chat as a `system` item whose `data.feature_card` points into the
 * feature record (`aura_core::features::card_data`); the card shows the
 * record's current state.
 */
export type FeatureCardRef = { kind: FeatureCardKind; id: string };

const KINDS: FeatureCardKind[] = ["decision", "report", "suggestion", "meeting"];

/** The card a transcript item stands for, if it is one. */
export function featureCard(item: Item): FeatureCardRef | null {
  if (item.kind !== "system") return null;
  const card = (item.data as { feature_card?: unknown }).feature_card as { kind?: unknown; id?: unknown } | undefined;
  if (!card || typeof card !== "object" || typeof card.id !== "string" || !KINDS.includes(card.kind as FeatureCardKind)) return null;
  return { kind: card.kind as FeatureCardKind, id: card.id };
}

export const STATUS_LABEL: Record<FeatureStatus, string> = {
  planning: "planning",
  in_progress: "in progress",
  waiting_on_user: "waiting on you",
  delivered: "delivered",
};

export const CHECKPOINT_LABEL: Record<Checkpoint, string> = {
  after_design: "After design",
  before_implementation: "Before implementation",
  before_delivery: "Before delivery",
};

export const CHECKPOINTS: Checkpoint[] = ["after_design", "before_implementation", "before_delivery"];

/** "blocking decisions", "checkpoints (after design, before delivery)" — as the daemon words it. */
export function describeAutonomy(a: Autonomy): string {
  if (a.level === "autonomous") return "autonomous";
  if (a.level === "blocking_decisions") return "blocking decisions";
  const chosen = CHECKPOINTS.filter((c) => a.checkpoints.includes(c)).map((c) => CHECKPOINT_LABEL[c].toLowerCase());
  return chosen.length ? `checkpoints (${chosen.join(", ")})` : "checkpoints (none chosen)";
}

export const isOpen = (q: UserQuestion) => !q.answer && !q.withdrawn;

/** Questions the owner put to the user that wait for an answer. */
export function openQuestions(f: Feature | undefined): UserQuestion[] {
  return f ? f.questions.filter(isOpen) : [];
}

/** "collecting · 1 of 3 answered", "held", "held · 1 missing". */
export function meetingState(m: Meeting): string {
  const answered = m.attendees.filter((a) => a.status === "answered").length;
  if (m.status === "collecting") return `collecting · ${answered} of ${m.attendees.length} answered`;
  const missing = m.attendees.length - answered;
  return missing === 0 ? "held" : `held · ${missing} missing`;
}

/** What one attendee's part in a meeting is now, in a word or two. */
export const ATTENDEE_LABEL: Record<Meeting["attendees"][number]["status"], string> = {
  invited: "waiting until free",
  asked: "answering",
  answered: "answered",
  missing: "no answer",
  late: "answered late",
};

/** "Builder → Designer", "Builder → you" for the owner, as the Team tab shows a one-on-one. */
export function oneOnOneLabel(a: OneOnOne): string {
  return `${a.from_name} → ${a.to_owner ? `${a.to_name} (owner)` : a.to_name}`;
}

/** Meetings and one-on-ones the feature has, as sent by a daemon that may predate them. */
export function teamWork(f: Feature): { meetings: Meeting[]; oneOnOnes: OneOnOne[] } {
  return { meetings: f.meetings ?? [], oneOnOnes: f.one_on_ones ?? [] };
}

/** "3 attendees", "2 attendees · 1 missing": who took part in a meeting that is over. */
export function attendeesLine(m: Meeting): string {
  const n = m.attendees.length;
  const missing = m.attendees.filter((a) => a.status !== "answered").length;
  return `${n === 1 ? "1 attendee" : `${n} attendees`}${missing ? ` · ${missing} missing` : ""}`;
}
