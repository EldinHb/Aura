import { SchedulesDialog } from "../features/schedules/SchedulesDialog";
import { useEffect, useState } from "react";
import { ModDialog } from "../mods/Slots";
import { useStore } from "../state/store";
import { Toasts } from "./Toasts";
import { WhichKey } from "./WhichKey";
import { HintMode } from "./HintMode";
import { CommandPalette } from "./CommandPalette";
import { HelpOverlay } from "./HelpOverlay";
import { ConfirmDialog } from "./dialogs/ConfirmDialog";
import { RenameDialog } from "./dialogs/RenameDialog";
import { SystemPromptDialog } from "./dialogs/SystemPromptDialog";
import { GroupDialog } from "./dialogs/GroupDialog";
import { PickerDialog } from "./dialogs/PickerDialog";
import { NewSessionDialog } from "./dialogs/NewSessionDialog";
import { ImportDialog } from "./dialogs/ImportDialog";
import { SlashDialog } from "./dialogs/SlashDialog";
import { DiffDialog } from "./dialogs/DiffDialog";
import { SearchDialog } from "./dialogs/SearchDialog";
import { InboxDialog } from "./dialogs/InboxDialog";
import { ComputersDialog } from "./dialogs/ComputersDialog";
import { SettingsDialog } from "./dialogs/SettingsDialog";
import { GitCleanupDialog } from "./dialogs/GitCleanupDialog";
import { WorkspaceDeleteDialog, WorkspaceEditDialog, WorkspaceGatherDialog, WorkspaceMoveDialog } from "./dialogs/WorkspaceDialogs";
import { WorkersCleanupDialog } from "./dialogs/WorkersCleanupDialog";
import { StepsDialog } from "../views/transcript/Steps";
import { ImageDialog } from "../views/ImageThumbs";
import { getDialog, onDialogsChanged } from "./dialogRegistry";

function CurrentDialog() {
  const dialog = useStore((s) => s.dialog);
  const [, setTick] = useState(0);
  useEffect(() => onDialogsChanged(() => setTick((t) => t + 1)), []);
  switch (dialog.kind) {
    case "mod":
      return <ModDialog />;
    case "none":
      return null;
    case "help":
      return <HelpOverlay />;
    case "confirm":
      return <ConfirmDialog title={dialog.title} message={dialog.message} onConfirm={dialog.onConfirm} danger={dialog.danger} confirmLabel={dialog.confirmLabel} focusCancel={dialog.focusCancel} />;
    case "workspace-edit":
      return <WorkspaceEditDialog key={dialog.id ?? "new"} id={dialog.id} moveSessionId={dialog.moveSessionId} />;
    case "workspace-delete":
      return <WorkspaceDeleteDialog key={dialog.id} id={dialog.id} />;
    case "workspace-move":
      return <WorkspaceMoveDialog key={dialog.sessionId} sessionId={dialog.sessionId} />;
    case "workspace-gather":
      return <WorkspaceGatherDialog />;
    case "workers-cleanup":
      return <WorkersCleanupDialog key={`${dialog.orchestratorId ?? ""}-${dialog.scope ?? ""}`} orchestratorId={dialog.orchestratorId} scope={dialog.scope} />;
    case "rename":
      return <RenameDialog sessionId={dialog.sessionId} />;
    case "system-prompt":
      return <SystemPromptDialog key={dialog.sessionId} sessionId={dialog.sessionId} />;
    case "schedules":
      return <SchedulesDialog key={`${dialog.taskId ?? ""}-${dialog.create ? "new" : ""}`} taskId={dialog.taskId} create={dialog.create} />;
    case "git-cleanup":
      return <GitCleanupDialog key={`${dialog.cwd ?? ""}-${dialog.repo ?? ""}`} cwd={dialog.cwd} repo={dialog.repo} />;
    case "group":
      return <GroupDialog sessionId={dialog.sessionId} />;
    case "models":
    case "effort":
    case "permission":
    case "sandbox":
      return <PickerDialog kind={dialog.kind} sessionId={dialog.sessionId} />;
    case "new-session":
      return <NewSessionDialog key={`${dialog.provider ?? ""}-${dialog.cwd ?? ""}-${dialog.featureOwner ? "owner" : ""}`} preset={dialog.provider} cwd={dialog.cwd} featureOwner={dialog.featureOwner} />;
    case "import":
      return <ImportDialog />;
    case "image":
      return <ImageDialog caption={dialog.caption} preview={dialog.preview} load={dialog.load} />;
    case "slash":
      return <SlashDialog sessionId={dialog.sessionId} />;
    case "diff":
      return <DiffDialog key={`${dialog.sessionId}-${dialog.path ?? ""}`} sessionId={dialog.sessionId} path={dialog.path} />;
    case "steps":
      return <StepsDialog key={dialog.groupId} sessionId={dialog.sessionId} groupId={dialog.groupId} />;
    case "search":
      return <SearchDialog />;
    case "inbox":
      return <InboxDialog />;
    case "computers":
      return <ComputersDialog key={`${dialog.add ? "add" : ""}-${dialog.repair ?? ""}`} add={dialog.add} repair={dialog.repair} />;
    case "settings": {
      const Registered = getDialog("settings");
      if (Registered) return <Registered dialog={dialog} />;
      return <SettingsDialog tab={dialog.tab} />;
    }
  }
}

export function Overlays() {
  const paletteOpen = useStore((s) => s.paletteOpen);
  return (
    <>
      <CurrentDialog />
      {paletteOpen && <CommandPalette />}
      <WhichKey />
      <HintMode />
      <Toasts />
    </>
  );
}
