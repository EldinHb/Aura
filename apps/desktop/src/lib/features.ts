import type { Autonomy, Checkpoint, Feature, FeatureCardKind, FeatureStatus, Item, UserQuestion } from "../gen";

/**
 * Feature owners, as the app shows them. The daemon puts a card in a feature
 * owner's chat as a `system` item whose `data.feature_card` points into the
 * feature record (`aura_core::features::card_data`); the card shows the
 * record's current state.
 */
export type FeatureCardRef = { kind: FeatureCardKind; id: string };

const KINDS: FeatureCardKind[] = ["decision", "report", "suggestion"];

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
