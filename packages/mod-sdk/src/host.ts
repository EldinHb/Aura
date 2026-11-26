// "@aura/host": Aura's own UI building blocks, for a mod's UI half.
//
// A mod imports from "@aura/host"; the SDK build replaces the import with
// Aura's live module (globalThis.__aura.modules["@aura/host"]), so these are
// the exact components Aura renders, sharing its theme, focus handling and
// keyboard conventions. This file exists for type checking only; the list
// must match apps/desktop/src/mods/host.ts.
export { Modal, KeyList, useListNav, type KeyListItem, type ModalProps } from "../../../apps/desktop/src/components/Modal";
export { ModalC } from "../../../apps/desktop/src/components/ModalC";
export { ExternalLink } from "../../../apps/desktop/src/components/ExternalLink";
export { Markdown } from "../../../apps/desktop/src/views/transcript/MarkdownView";
export { DiffRenderer } from "../../../apps/desktop/src/components/diff/DiffRenderer";
export * as diff from "../../../apps/desktop/src/components/diff/parse";
export { timeAgo, exactTime } from "../../../apps/desktop/src/lib/time";
export { isMac, modLabel, shortId, basename, relTime } from "../../../apps/desktop/src/lib/platform";
export { useStore } from "../../../apps/desktop/src/state/store";
export { setFocus } from "../../../apps/desktop/src/commands/core";
export { openExternal } from "../../../apps/desktop/src/mods/hostExtras";
