// Aura core types a mod sees: sessions, events and session options. Generated
// from the Rust types (scripts/export-ts.sh) into the desktop app; re-exported
// here so a mod depends on the SDK only.
export type {
  Session,
  Event as CoreEvent,
  CreateSessionOpts,
  WorktreeOpts,
  SessionStatus,
  Attention,
  ProviderKind,
  Item,
  ModelInfo,
  BranchStatus,
} from "../../../apps/desktop/src/gen";
