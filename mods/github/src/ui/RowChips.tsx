// The issue and PR chips of a sidebar row (former SessionRowLinks in components/Sidebar.tsx).
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import clsx from "clsx";
import type { SessionRowProps } from "@aura/mod-sdk/ui";
import { useStore } from "@aura/host";
import { BranchPullChip } from "./BranchPull";
import { useSessionBranch } from "./branch";
import { useDetectedLinksStore, useLinkPreferencesStore, useRecordBranchPull, useSidebarLinks } from "./links";
import { describeBranchPull } from "./pullStatus";
import { folderOf, useGithubRepo } from "./repos";
import { selectedSessionLinks, sessionLinks } from "../shared/links";

/**
 * How many of the chips in `ref` fit on its one line whole, leaving room for
 * the "+N" chip after them when some do not. Chips past that stay laid out,
 * out of sight, so they can be measured again when the sidebar widens.
 */
function useFittingChips(ref: RefObject<HTMLDivElement | null>, key: string) {
  const [fit, setFit] = useState(Infinity);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const widths = [...el.querySelectorAll<HTMLElement>(":scope > .link-slot")].map((c) => c.offsetWidth);
      const more = el.querySelector<HTMLElement>(":scope > .links-more")?.offsetWidth ?? 0;
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const width = (n: number) => widths.slice(0, n).reduce((sum, w) => sum + w, 0) + gap * Math.max(0, n - 1);
      let n = widths.length;
      if (width(n) > el.clientWidth) do n--; while (n > 0 && width(n) + gap + more > el.clientWidth);
      setFit(n);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, key]);
  return fit;
}

/**
 * The pull request of the session's branch with its status, then the issue and
 * PR numbers linked to the session as the Inspector shows them. As many whole
 * chips as fit, then "+N" with the rest in its tooltip.
 */
export function RowChips({ session, selected }: SessionRowProps) {
  useSidebarLinks();
  // SDK-GAP: SessionRowProps carries no branch status, though core reads it for the row. The
  // chips read `git.branch_status` themselves (or take it from a row branchDecoration's status).
  const { pull: branchPull } = useSessionBranch(session, selected);
  useRecordBranchPull(session, branchPull);
  const transcript = useStore((s) => s.transcripts[session.id]);
  const preferences = useLinkPreferencesStore((s) => s.entries[session.id]?.preferences);
  const detected = useDetectedLinksStore((s) => s.links[session.id]);
  const repo = useGithubRepo(folderOf(session) ?? undefined);
  const links = useMemo(() => {
    const automatic = transcript?.loaded ? sessionLinks(transcript.items, session.title, repo) : detected ?? sessionLinks({}, session.title, repo);
    return selectedSessionLinks(automatic, preferences);
  }, [transcript?.loaded, transcript?.items, session.title, repo, detected, preferences]);
  // The branch's pull request replaces the same PR linked from the transcript.
  const shown = branchPull ? links.filter((l) => !(l.kind === "PR" && Number(l.number) === branchPull.number && l.repo.toLowerCase() === branchPull.repo.toLowerCase())) : links;
  const chips = [
    ...(branchPull ? [{ key: branchPull.url, tip: describeBranchPull(branchPull), chip: <BranchPullChip pull={branchPull} /> }] : []),
    ...shown.map((link) => ({ key: link.url, tip: link.url, chip: <span className="session-row-link" title={link.url}>{link.kind} #{link.number}</span> })),
  ];
  const ref = useRef<HTMLDivElement>(null);
  // The branch PR's labels change its width, so they are part of what is measured.
  const fit = useFittingChips(ref, chips.map((c) => c.key).join(" ") + (branchPull ? describeBranchPull(branchPull) : ""));
  if (chips.length === 0) return null;
  const rest = chips.slice(fit);
  return (
    <div className="links" ref={ref}>
      {chips.map((c, i) => <span key={c.key} className={clsx("link-slot", i >= fit && "overflow")} aria-hidden={i >= fit || undefined}>{c.chip}</span>)}
      {/* Measured even while every chip fits, at its widest. */}
      <span className={clsx("chip", "links-more", rest.length === 0 && "overflow")} aria-hidden={rest.length === 0 || undefined} title={rest.map((c) => c.tip).join("\n")}>
        +{rest.length || chips.length}
      </span>
    </div>
  );
}
