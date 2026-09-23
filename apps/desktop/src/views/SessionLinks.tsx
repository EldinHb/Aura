import { useMemo } from "react";
import type { Item } from "../gen";
import { ExternalLink } from "../components/ExternalLink";
import { selectedSessionLinks, sessionLinks, type LinkPreferences } from "./issueLinks";

export function SessionLinks({ items, title, preferences, onEdit, loading, error }: {
  items: Record<string, Item>; title: string; preferences?: LinkPreferences;
  onEdit?: () => void; loading?: boolean; error?: string;
}) {
  const automatic = useMemo(() => sessionLinks(items, title), [items, title]);
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
      {onEdit && <button className="btn small" data-command="session.links" onClick={onEdit}>Edit issue &amp; PR…</button>}
    </div>
  );
}
