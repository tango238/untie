import { useEffect, useState } from "react";
import { checkHours } from "@untie/core/model/commands";
import { activityHours, formatHours } from "@untie/core/model/selectors";
import type { Element, UntieModel } from "@untie/core/model/types";

/**
 * 作業・操作の時間の表示。作業は、作業自身の時間と使う操作の合計を分けて出す。
 * 時間が入っていなければ何も出さない
 */
export function HoursLabel({ element, model, className = "hours-label" }: { element: Element; model: UntieModel; className?: string }) {
  if (element.kind === "usecase") {
    return element.hours === undefined ? null : <span className={className}>⏱ {formatHours(element.hours)}</span>;
  }
  if (element.kind !== "activity") return null;
  const h = activityHours(model, element.id);
  if (h.own === undefined && h.usecases === undefined) return null;
  return (
    <span className={className}>
      ⏱ {h.own !== undefined && <span className="hours-part">作業 {formatHours(h.own)}</span>}
      {h.own !== undefined && h.usecases !== undefined && <span className="hours-sep"> / </span>}
      {h.usecases !== undefined && <span className="hours-part">操作の合計 {formatHours(h.usecases)}</span>}
    </span>
  );
}

/** 時間の入力 (時間単位、小数点第一位まで)。フォーカスが外れたとき・Enter で確定し、空にすると消す */
export function HoursField({
  value,
  onCommit,
  onError,
  readOnly,
}: {
  value: number | undefined;
  onCommit: (hours: number | null) => void;
  onError: (reason: string) => void;
  readOnly?: boolean;
}) {
  const [local, setLocal] = useState(value === undefined ? "" : String(value));
  useEffect(() => setLocal(value === undefined ? "" : String(value)), [value]);
  const commit = () => {
    const text = local.trim();
    if (text === "") {
      if (value !== undefined) onCommit(null);
      return;
    }
    const n = Number(text);
    const reason = Number.isNaN(n) ? "時間は数で入力してください" : checkHours(n);
    if (reason) {
      onError(reason);
      setLocal(value === undefined ? "" : String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <label className="field">
      <span className="field-label">時間 (時間単位、小数点第一位まで)</span>
      <input
        aria-label="時間"
        type="number"
        inputMode="decimal"
        min={0}
        step={0.1}
        placeholder="例: 0.5"
        readOnly={readOnly}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
    </label>
  );
}
