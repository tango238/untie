import { useEffect, useRef, useState } from "react";
import { updateElement } from "@untie/core/model/commands";
import { NAME_MAX_LENGTH } from "@untie/core/model/limits";
import type { Element } from "@untie/core/model/types";
import { useUntieStore } from "../store";

/**
 * 名前をその場で変える入力欄 (固定ボードのカード・業務一覧の登場人物・業務・活動・作業で共通)。
 * Enter・保存で確定し、Esc・フォーカスが外れたら取り消す。変換中の Enter・Esc では何もしない
 */
export function NameForm({ element, kindLabel, onDone }: { element: Element; /** 入力欄の aria-label (「○○の名前」) に入れる、要素の種類の呼び方 */ kindLabel: string; onDone: () => void }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const [value, setValue] = useState(element.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const save = () => {
    if (value.trim() !== element.name) {
      const r = dispatch((m) => updateElement(m, { id: element.id, patch: { name: value } }));
      if (!r.ok) {
        pushToast(r.reason, "error");
        return;
      }
    }
    onDone();
  };

  return (
    <form
      className="fixed-card-rename"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onBlur={(e) => {
        // フォーム内 (入力欄と保存ボタンの間) の移動では取り消さない
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDone();
      }}
    >
      <input
        ref={inputRef}
        aria-label={`${kindLabel}の名前`}
        maxLength={NAME_MAX_LENGTH}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // 変換確定の Enter / Esc では確定・取り消しをしない
          // WebKit は変換確定の Enter を compositionend の後に isComposing=false, keyCode=229 で送ることがある
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
            if (e.key === "Enter") e.preventDefault();
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
      />
      {/* 押したときに入力欄からフォーカスが外れて取り消しにならないよう、mousedown の既定動作を止める */}
      <button type="submit" onMouseDown={(e) => e.preventDefault()}>
        保存
      </button>
    </form>
  );
}
