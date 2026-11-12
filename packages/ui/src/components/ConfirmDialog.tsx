import { useEffect, useRef } from "react";

export interface ConfirmDialogProps {
  title: string;
  message: string;
  /** メッセージの下に箇条書きで添える項目 (例: 一緒に消えるもの) */
  details?: readonly string[];
  /** details の下に、見出し付きで分けて出す箇条書き (例: 子への影響のあとに「消える設計データ」) */
  detailGroups?: readonly { title: string; items: readonly string[] }[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** キャンセルと確定のあいだに置く、もう 1 つの選択肢 (例: 保存せずに続ける) */
  alternateLabel?: string;
  onAlternate?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** window.confirm の代わりの確認ダイアログ。表示するときだけマウントする */
export function ConfirmDialog({
  title,
  message,
  details,
  detailGroups,
  confirmLabel = "OK",
  cancelLabel = "キャンセル",
  danger = false,
  alternateLabel,
  onAlternate,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div
      className="dialog-backdrop"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{message}</p>
        {details && details.length > 0 && (
          <ul className="dialog-details">
            {details.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        )}
        {detailGroups?.map((g) => (
          <section key={g.title} className="dialog-detail-group">
            <h3 className="dialog-detail-title">{g.title}</h3>
            <ul className="dialog-details">
              {g.items.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </section>
        ))}
        <div className="dialog-actions">
          <button type="button" ref={cancelRef} onClick={onCancel}>
            {cancelLabel}
          </button>
          {alternateLabel && onAlternate && (
            <button type="button" onClick={onAlternate}>
              {alternateLabel}
            </button>
          )}
          <button type="button" className={danger ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
