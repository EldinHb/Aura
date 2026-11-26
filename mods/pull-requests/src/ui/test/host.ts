// "@aura/host" for tests: the same Aura modules the SDK's host.ts names, imported from
// Aura's sources (which resolve React and zustand to the same copies as the mod). Tests swap
// it in with `vi.mock("<path to>/host", () => import("<path to>/test/host"))`.
export { Modal } from "../../../../../apps/desktop/src/components/Modal";
export { ExternalLink } from "../../../../../apps/desktop/src/components/ExternalLink";
export { Markdown } from "../../../../../apps/desktop/src/views/transcript/MarkdownView";
export * as diff from "../../../../../apps/desktop/src/components/diff/parse";
export { timeAgo, exactTime } from "../../../../../apps/desktop/src/lib/time";
export { relTime } from "../../../../../apps/desktop/src/lib/platform";
export { useStore } from "../../../../../apps/desktop/src/state/store";
export { setFocus } from "../../../../../apps/desktop/src/commands/core";
