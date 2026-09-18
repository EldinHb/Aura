import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { Toasts } from "./Toasts";
import { WhichKey } from "./WhichKey";
import { HintMode } from "./HintMode";
import { CommandPalette } from "./CommandPalette";
import { HelpOverlay } from "./HelpOverlay";
import { ConfirmDialog } from "./dialogs/ConfirmDialog";
import { RenameDialog } from "./dialogs/RenameDialog";
import { GroupDialog } from "./dialogs/GroupDialog";
import { PickerDialog } from "./dialogs/PickerDialog";
import { NewSessionDialog } from "./dialogs/NewSessionDialog";
import { ImportDialog } from "./dialogs/ImportDialog";
import { SlashDialog } from "./dialogs/SlashDialog";
import { DiffDialog } from "./dialogs/DiffDialog";
import { SearchDialog } from "./dialogs/SearchDialog";
import { InboxDialog } from "./dialogs/InboxDialog";
import { SettingsDialog } from "./dialogs/SettingsDialog";
import { getDialog, onDialogsChanged } from "./dialogRegistry";

function CurrentDialog() {
  const dialog = useStore((s) => s.dialog);
  const [, setTick] = useState(0);
  useEffect(() => onDialogsChanged(() => setTick((t) => t + 1)), []);
  switch (dialog.kind) {
    case "none":
      return null;
    case "help":
      return <HelpOverlay />;
    case "confirm":
      return <ConfirmDialog title={dialog.title} message={dialog.message} onConfirm={dialog.onConfirm} danger={dialog.danger} />;
    case "rename":
      return <RenameDialog sessionId={dialog.sessionId} />;
    case "group":
      return <GroupDialog sessionId={dialog.sessionId} />;
    case "models":
    case "effort":
    case "permission":
    case "sandbox":
      return <PickerDialog kind={dialog.kind} sessionId={dialog.sessionId} />;
    case "new-session":
      return <NewSessionDialog key={`${dialog.provider ?? ""}-${dialog.cwd ?? ""}`} preset={dialog.provider} cwd={dialog.cwd} />;
    case "import":
      return <ImportDialog />;
    case "slash":
      return <SlashDialog sessionId={dialog.sessionId} />;
    case "diff":
      return <DiffDialog key={`${dialog.sessionId}-${dialog.path ?? ""}`} sessionId={dialog.sessionId} path={dialog.path} />;
    case "search":
      return <SearchDialog />;
    case "inbox":
      return <InboxDialog />;
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
