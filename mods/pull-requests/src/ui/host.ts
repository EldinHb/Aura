// Aura's own building blocks, the only part of Aura this UI uses directly.
// Everything else goes through the `ctx` given to `activate` (see ./ctx.ts).
// One module re-exports them so tests can swap in Aura's sources (see ./test/host.ts).
export { Modal, ExternalLink, Markdown, diff, timeAgo, exactTime, relTime, useStore, setFocus } from "@aura/host";
