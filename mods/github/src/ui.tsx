// The github mod's UI half: the issue picker in the new-session dialog, issue and PR links on
// sessions (inspector, dialog, sidebar chips, transcript), and the PR next to a branch.
import { defineUi, type TranscriptLink, type UiApi } from "@aura/mod-sdk/ui";
import type { Session } from "@aura/mod-sdk";
import { useStore } from "@aura/host";
import "./ui.css";
import { setCtx } from "./ui/ctx";
import { BranchDecoration } from "./ui/BranchPull";
import { IssueField } from "./ui/IssuePicker";
import { linksChanged, reloadLinks, startDetectedLinksSync } from "./ui/links";
import { folderOf, useGithubRepos } from "./ui/repos";
import { RowChips } from "./ui/RowChips";
import { LINKS_COMMAND, LINKS_DIALOG, SessionLinksSection } from "./ui/SessionLinks";
import { SessionLinksDialog } from "./ui/SessionLinksDialog";
import { linksIn } from "./shared/links";

/** Issue and PR URLs in transcript text, labelled "#12" in the session's own repository. */
export function detectLinks(text: string, session: Session): TranscriptLink[] {
  const folder = folderOf(session);
  const repo = folder !== null ? useGithubRepos.getState().repos[folder] ?? undefined : undefined;
  return linksIn(text).map((link) => ({
    label: repo && link.repo.toLowerCase() === repo.toLowerCase() ? `#${link.number}` : `${link.repo}#${link.number}`,
    url: link.url,
    kind: link.kind,
  }));
}

export function activate(ctx: UiApi) {
  setCtx(ctx);
  const off = [
    ctx.ui.newSessionField({ id: "issues", component: IssueField }),
    ctx.ui.inspectorSection({ id: "links", order: 0, component: SessionLinksSection }),
    ctx.ui.dialog({ id: LINKS_DIALOG, component: SessionLinksDialog }),
    ctx.ui.sessionRowChips({ id: "links", component: RowChips }),
    ctx.ui.branchDecoration({ id: "pull", component: BranchDecoration }),
    ctx.ui.transcriptLinks({ id: "github", detect: detectLinks }),
    ctx.commands.register({
      id: LINKS_COMMAND,
      title: "Edit issues & PRs…",
      keywords: ["GitHub", "pull request", "links"],
      group: "Session",
      when: "hasSelection",
      run: () => {
        const id = useStore.getState().selectedId;
        if (id) ctx.openDialog(LINKS_DIALOG, { sessionId: id });
      },
    }),
    ctx.on("links.changed", linksChanged),
    ctx.onConnection((state) => {
      if (state === "open") reloadLinks();
    }),
    startDetectedLinksSync(),
  ];
  return () => {
    for (const dispose of off) dispose();
    setCtx(null);
  };
}

export default defineUi(activate);
