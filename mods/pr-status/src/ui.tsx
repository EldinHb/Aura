// The pr-status mod's UI half: the "Pull requests" cards in the Inspector, a PR page in a
// main-area tab (`pr` view), and a command to read the selected session's PRs again.
import { defineUi, type UiApi } from "@aura/mod-sdk/ui";
import { useStore } from "@aura/host";
import "./ui.css";
import { setCtx } from "./ui/ctx";
import { PrStatusSection } from "./ui/PrStatusSection";
import { LINK_DIALOG, LinkDialog } from "./ui/LinkPr";
import { PAGE_VIEW, PrPageView } from "./ui/page/PrPageView";
import { keepOpenSessions } from "./ui/openSessions";

export function activate(ctx: UiApi) {
  setCtx(ctx);
  const off = [
    // Above the github mod's "Issues & PRs" (order 0): the state of the work comes first.
    ctx.ui.inspectorSection({ id: "status", order: -10, component: PrStatusSection }),
    keepOpenSessions(ctx),
    ctx.ui.view({ id: PAGE_VIEW, title: "Pull request", component: PrPageView }),
    ctx.ui.dialog({ id: LINK_DIALOG, component: LinkDialog }),
    ctx.commands.register({
      id: "link",
      title: "Link a pull request…",
      keywords: ["pull request", "PR", "GitHub", "link"],
      group: "Session",
      when: "hasSelection",
      run: () => {
        const id = useStore.getState().selectedId;
        if (id) ctx.openDialog(LINK_DIALOG, { sessionId: id });
      },
    }),
    ctx.commands.register({
      id: "refresh",
      title: "Refresh PR status",
      keywords: ["pull request", "checks", "reviews", "GitHub"],
      group: "Session",
      when: "hasSelection",
      run: async () => {
        const id = useStore.getState().selectedId;
        if (!id) return;
        // The section hears the result through the `changed` notification.
        await ctx.rpc("refresh", { sessionId: id }).catch((e: unknown) => ctx.toast(`Could not refresh PR status: ${e instanceof Error ? e.message : String(e)}`, "error"));
      },
    }),
  ];
  return () => {
    off.forEach((dispose) => dispose());
    setCtx(null);
  };
}

export default defineUi(activate);
