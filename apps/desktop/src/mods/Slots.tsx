/**
 * Where mods' UI shows up in Aura. Each core component that offers a slot
 * renders one of these; every mod's piece is wrapped in its own error
 * boundary so a failing mod shows an inline error instead of breaking Aura.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import type { Session } from "../gen";
import { useStore } from "../state/store";
import { slots, useSlot, type Entry } from "./registry";
import { reportModUiError } from "./report";

class ModBoundary extends Component<{ modId: string; children: ReactNode; quiet?: boolean }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[mod ${this.props.modId}] failed to render`, error, info.componentStack);
    reportModUiError(this.props.modId, "a component failed to render", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.quiet) return null;
    return (
      <div className="mod-error" role="alert" title={this.state.error.stack}>
        {this.props.modId}: {this.state.error.message}
      </div>
    );
  }
}

export function ModPiece({ entry, children, quiet }: { entry: Entry<unknown>; children: ReactNode; quiet?: boolean }) {
  return (
    <ModBoundary modId={entry.modId} quiet={quiet}>
      {children}
    </ModBoundary>
  );
}

export function SidebarModSections({ focused }: { focused: boolean }) {
  const sections = useSlot(slots.sidebarSection);
  return (
    <>
      {sections.map((s) => (
        <ModPiece key={s.key} entry={s}>
          <s.component focused={focused} />
        </ModPiece>
      ))}
    </>
  );
}

export function InspectorModSections({ session }: { session: Session }) {
  const sections = useSlot(slots.inspectorSection);
  return (
    <>
      {sections.map((s) => (
        <ModPiece key={s.key} entry={s}>
          <s.component session={session} />
        </ModPiece>
      ))}
    </>
  );
}

export function SessionRowModChips({ session, selected }: { session: Session; selected: boolean }) {
  const chips = useSlot(slots.sessionRowChips);
  return (
    <>
      {chips.map((c) => (
        <ModPiece key={c.key} entry={c} quiet>
          <c.component session={session} selected={selected} />
        </ModPiece>
      ))}
    </>
  );
}

export function BranchModDecorations(props: { cwd: string; status: unknown; place: "statusbar" | "inspector" | "row"; session: Session | null }) {
  const decorations = useSlot(slots.branchDecoration);
  return (
    <>
      {decorations.map((d) => (
        <ModPiece key={d.key} entry={d} quiet>
          <d.component {...props} />
        </ModPiece>
      ))}
    </>
  );
}

export function StatusBarModItems() {
  const items = useSlot(slots.statusBarItem);
  return (
    <>
      {items.map((i) => (
        <ModPiece key={i.key} entry={i} quiet>
          <i.component />
        </ModPiece>
      ))}
    </>
  );
}

export function NewSessionModFields({ cwd, onChange }: { cwd: string | null; onChange(key: string, c: { prompt?: string; data?: unknown } | null): void }) {
  const fields = useSlot(slots.newSessionField);
  return (
    <>
      {fields.map((f) => (
        <ModPiece key={f.key} entry={f}>
          <f.component cwd={cwd} onChange={(c) => onChange(f.key, c)} />
        </ModPiece>
      ))}
    </>
  );
}

/** A mod's view in its main-area tab, or a placeholder while its mod is not loaded; `active` while its tab is the one shown. */
export function ModView({ modId, viewId, props, close, active }: { modId: string; viewId: string; props: unknown; close: () => void; active: boolean }) {
  const views = useSlot(slots.view);
  const v = views.find((x) => x.modId === modId && x.key === `${modId}:${viewId}`);
  if (!v) return <div className="empty">This view is not available: its mod is not loaded.</div>;
  return (
    <ModPiece entry={v}>
      <v.component props={props} close={close} active={active} />
    </ModPiece>
  );
}

/** The registered title of a mod's view, or null when its mod is not loaded. */
export function useModViewTitle(modId: string, viewId: string): string | null {
  const views = useSlot(slots.view);
  return views.find((x) => x.modId === modId && x.key === `${modId}:${viewId}`)?.title ?? null;
}

export function useModViewOpen(): boolean {
  return useStore((s) => s.modView !== null);
}

export function ModDialog() {
  const dialog = useStore((s) => s.dialog);
  const close = useStore((s) => s.closeDialog);
  const dialogs = useSlot(slots.dialog);
  if (dialog.kind !== "mod") return null;
  const d = dialogs.find((x) => x.key === `${dialog.modId}:${dialog.id}`);
  if (!d) return null;
  return (
    <ModPiece entry={d}>
      <d.component props={dialog.props} close={close} />
    </ModPiece>
  );
}
