import { useEffect } from "react";
import { useUntieStore, type ToastItem } from "../store";

const AUTO_DISMISS_MS = 4000;

function ToastRow({ toast }: { toast: ToastItem }) {
  const dismiss = useUntieStore((s) => s.dismissToast);
  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [toast.id, dismiss]);
  return (
    <div className={`toast tone-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
      <span>{toast.message}</span>
      <button type="button" className="toast-close" aria-label="閉じる" onClick={() => dismiss(toast.id)}>
        ×
      </button>
    </div>
  );
}

export function ToastHost() {
  const toasts = useUntieStore((s) => s.toasts);
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  );
}
