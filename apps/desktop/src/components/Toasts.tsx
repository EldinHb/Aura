import { useStore } from "../state/store";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          <span className="toast-msg">{t.message}</span>
          {t.action && (
            <button type="button" className="toast-action" data-hint data-command="toast.action" onClick={() => { dismiss(t.id); t.action!.run(); }}>
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast-close" data-hint data-command="toast.dismiss" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
