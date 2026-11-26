// The API a mod's UI half receives in `activate(ctx)`.
//
// The UI half is an ES module loaded into Aura's window. It shares Aura's
// React and zustand: import them normally ("react", "zustand"); the SDK's
// build maps those imports to Aura's own copies. Aura's reusable components
// and hooks come from "@aura/host" (see ./host.ts).
//
// The UI half is NOT sandboxed: it runs with the same rights as Aura's own
// interface. Keep secrets (tokens) in the daemon half.

import type { ComponentType } from "react";
import type { Json } from "./daemon";
import type { Session } from "./core";

import type { Disposer } from "./daemon";
export type { Disposer };

export interface CommandDef {
  /** Prefixed with "<modId>." automatically unless it already is. */
  id: string;
  title: string;
  group: string;
  keywords?: string[];
  /** A `when` expression, e.g. "focus:sidebar && !inputFocused && mod.github.prSelected". */
  when?: string;
  hidden?: boolean;
  run: (arg?: unknown) => void | Promise<void>;
}

export interface KeyBindingDef {
  /** "mod+k", "g p", "leader p r" … */
  keys: string;
  /** Full command id (a mod's own commands are "<modId>.<id>"). */
  command: string;
  when?: string;
  arg?: unknown;
  label?: string;
}

/** Props of a sidebar section component. */
export interface SidebarSectionProps {
  /** Whether keyboard focus is in the sidebar. */
  focused: boolean;
}

/** Props of an inspector section; it renders for the selected session. */
export interface InspectorSectionProps {
  session: Session;
}

export interface SessionRowProps {
  session: Session;
  selected: boolean;
}

export interface BranchDecorationProps {
  /** Folder of the session the branch status belongs to. */
  cwd: string;
  /** Core's git branch status (`git.branch_status`). */
  status: Json;
  /** "statusbar" | "inspector" | "row" */
  place: "statusbar" | "inspector" | "row";
  session: Session | null;
}

export interface NewSessionFieldProps {
  cwd: string | null;
  /** Contribute text that is appended to the new session's first prompt, and links to store. */
  onChange(contribution: { prompt?: string; data?: Json } | null): void;
}

export interface ViewProps<P = any> {
  props: P;
  /** Closes the view and returns to the selected session. */
  close(): void;
}

export interface DialogProps<P = any> {
  props: P;
  close(): void;
}

export interface InboxItemProps {
  item: { id: string; title: string; detail?: string; at: string; unread: boolean; data?: Json };
}

export interface TranscriptLink {
  /** Shown as a chip, e.g. "#123" or "owner/repo#45". */
  label: string;
  url: string;
  kind: string;
}

export interface UiApi {
  readonly mod: { id: string; version: string };
  /** Call `mod.<id>.<name>` on this mod's daemon half. */
  rpc<T = any>(name: string, params?: unknown): Promise<T>;
  /** Call another mod's daemon method (`mod.<modId>.<name>`). */
  call<T = any>(modId: string, name: string, params?: unknown): Promise<T>;
  /** Notifications `mod.<id>.<name>` from this mod's daemon half. */
  on(name: string, fn: (payload: any) => void): Disposer;
  /** Notifications from another mod. */
  onMod(modId: string, name: string, fn: (payload: any) => void): Disposer;
  /** Fires with "open" every time the daemon connection (re)opens. */
  onConnection(fn: (state: "open" | "closed" | "connecting") => void): Disposer;
  /** Aura's core RPC client (same object Aura uses). */
  client: { call<T = any>(method: string, params?: unknown): Promise<T> };
  /** localStorage namespaced to "aura.mod.<id>.". */
  storage: {
    get<T = any>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    delete(key: string): void;
  };
  settings: {
    get<T = Json>(key: string): T;
    set(key: string, value: unknown): Promise<void>;
    onChange(fn: (key: string, value: Json) => void): Disposer;
  };

  commands: { register(cmd: CommandDef): Disposer; run(id: string, arg?: unknown): void };
  keys: {
    bind(binding: KeyBindingDef): Disposer;
    /** Which-key label for a sequence prefix, e.g. group("leader p", "Pull requests"). */
    group(prefix: string, label: string): Disposer;
  };
  /** `when` context keys, readable as "mod.<id>.<key>". */
  context: { set(key: string, value: boolean | string | number | null): void };

  ui: {
    sidebarSection(def: { id: string; title?: string; order?: number; component: ComponentType<SidebarSectionProps> }): Disposer;
    inspectorSection(def: { id: string; order?: number; component: ComponentType<InspectorSectionProps> }): Disposer;
    sessionRowChips(def: { id: string; order?: number; component: ComponentType<SessionRowProps> }): Disposer;
    branchDecoration(def: { id: string; component: ComponentType<BranchDecorationProps> }): Disposer;
    statusBarItem(def: { id: string; order?: number; component: ComponentType<{}> }): Disposer;
    settingsTab(def: { id: string; title: string; component: ComponentType<{}> }): Disposer;
    newSessionField(def: { id: string; component: ComponentType<NewSessionFieldProps> }): Disposer;
    inboxRenderer(def: { component: ComponentType<InboxItemProps>; open?(item: InboxItemProps["item"]): void }): Disposer;
    transcriptLinks(def: { id: string; detect(text: string, session: Session): TranscriptLink[] }): Disposer;
    /** A full main-area view, opened with `openView`. */
    view(def: { id: string; title: string; component: ComponentType<ViewProps> }): Disposer;
    dialog(def: { id: string; component: ComponentType<DialogProps> }): Disposer;
  };

  openView(id: string, props?: unknown): void;
  closeView(): void;
  /** The mod view that is open, if it is one of this mod's. */
  activeView(): { id: string; props: any } | null;
  openDialog(id: string, props?: unknown): void;

  /** Which window this UI half runs in: the main one, or a detached session window. Announce things from "main" only. */
  readonly window: "main" | "session";
  /** A desktop notification; clicking it calls `onNotificationClick` with `target`. */
  notify(title: string, body?: string, target?: Json): void;
  toast(message: string, level?: "info" | "warn" | "error"): void;
  confirm(opts: { title: string; message: string; danger?: boolean }): Promise<boolean>;
  /** Called when the user clicks a notification this mod sent with a `target`. */
  onNotificationClick(fn: (target: Json) => void): Disposer;
  /** Ask Aura not to show its own "turn finished" toast for a session (e.g. a mod is handling it). */
  suppressTurnToast(fn: (session: Session) => boolean): Disposer;
}

/** What `ui.js` default-exports. May return a deactivate function. */
export type UiActivate = (ctx: UiApi) => void | (() => void);

export function defineUi(activate: UiActivate): UiActivate {
  return activate;
}
