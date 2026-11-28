/** Commands for the computers the window shows: this one and the paired remote computers (state/computers.ts). */
import { registerCommands, setRemoteShown, type Command } from "../lib/commands";
import { useStore, LOCAL } from "../state/store";
import { cycleComputer, switchComputer } from "../state/computers";
import { openComputerMenu } from "../components/ComputerSwitcher";

const st = useStore.getState;

const computerCommands: Command[] = [
  { id: "computer.switch", title: "Computer: Switch…", group: "Computer", keywords: ["remote", "server", "host", "machine", "this mac"], run: () => openComputerMenu() },
  { id: "computer.local", title: "Computer: Show this computer", group: "Computer", keywords: ["local", "this mac", "home"], run: () => switchComputer(LOCAL) },
  { id: "computer.next", title: "Computer: Next", group: "Computer", run: () => cycleComputer(1) },
  { id: "computer.prev", title: "Computer: Previous", group: "Computer", run: () => cycleComputer(-1) },
  { id: "computer.add", title: "Computer: Add remote computer…", group: "Computer", keywords: ["pair", "remote", "server", "connect"], run: () => st().openDialog({ kind: "computers", add: true }) },
  { id: "computer.manage", title: "Computer: Manage remote computers…", group: "Computer", keywords: ["pair", "remove", "rename", "remote", "server"], run: () => st().openDialog({ kind: "computers" }) },
];

export function registerComputerCommands(): () => void {
  setRemoteShown(() => st().computer !== LOCAL);
  return registerCommands(computerCommands);
}
