// "Issues & PRs" in the Inspector (former views/SessionLinks.tsx and its use in Inspector.tsx).
import { useMemo } from "react";
import type { Item } from "@aura/mod-sdk";
import type { InspectorSectionProps } from "@aura/mod-sdk/ui";
import { ExternalLink, useStore } from "@aura/host";
import { getCtx } from "./ctx";
import { useSessionLinkPreferences } from "./links";
import { folderOf, useGithubRepo } from "./repos";
import { selectedSessionLinks, sessionLinks, type LinkPreferences } from "../shared/links";

/** The dialog and command that edit a session's links. */
export const LINKS_DIALOG = "links";
export const LINKS_COMMAND = "session.links";

export function SessionLinks({ items, title, repo, preferences, onEdit, loading, error }: {
  items: Record<string, Item>; title: string; repo?: string; preferences?: LinkPreferences;
  onEdit?: () => void; loading?: boolean; error?: string;
}) {
  const automatic = useMemo(() => sessionLinks(items, title, repo), [items, title, repo]);
  const links = selectedSessionLinks(automatic, preferences);
  if (links.length === 0 && !onEdit) return null;
  return (
    <div className="inspector-section session-links">
      <h4>Issues &amp; PRs</h4>
      {loading || error ? <p className="dim">{error ? "Could not load saved links" : "Loading links…"}</p> : links.map((link) => (
        <ExternalLink key={link.url} href={link.url} title={link.url} className="session-link">
          <span>{link.kind} #{link.number}</span>
          <span className="dim session-link-repo">{link.repo}</span>
        </ExternalLink>
      ))}
      {!loading && !error && links.length === 0 && <p className="dim">No issue or PR selected</p>}
      {!loading && !error && links.some((link) => link.kind === "PR") && (
        <p className="dim">{preferences?.reviews === false ? "Reviews on these PRs are not handed to this session" : "New reviews on your PRs here go to this session"}</p>
      )}
      {onEdit && <button className="btn small" data-command={`github.${LINKS_COMMAND}`} onClick={onEdit}>Edit issues &amp; PRs…</button>}
    </div>
  );
}

/** The Inspector section of the selected session. */
export function SessionLinksSection({ session }: InspectorSectionProps) {
  const entry = useSessionLinkPreferences(session.id);
  const transcript = useStore((st) => st.transcripts[session.id]);
  const repo = useGithubRepo(folderOf(session) ?? undefined);
  return (
    <SessionLinks items={transcript?.items ?? {}} title={session.title} repo={repo} preferences={entry?.preferences}
      loading={!entry} error={entry?.error}
      onEdit={() => getCtx()?.openDialog(LINKS_DIALOG, { sessionId: session.id })} />
  );
}
