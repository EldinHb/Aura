import { useStore } from "../state/store";
import { UpdateBanner } from "../features/updates/UpdateBanner";
import { useUpdateBanner } from "../features/updates/updates";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const banner = useUpdateBanner();
  if (toasts.length === 0 && !banner) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {banner && <UpdateBanner phase={banner} />}
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          <span className="toast-msg">{t.message}</span>
          {t.actions?.map((a) => (
            <button
              key={a.label}
              type="button"
              className="toast-action"
              data-hint
              data-command="toast.action"
              onClick={() => {
                dismiss(t.id);
                a.run();
              }}
            >
              {a.label}
            </button>
          ))}
          <button type="button" className="toast-close" data-hint data-command="toast.dismiss" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
