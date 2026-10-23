import { useEffect, useRef, useState, type Ref } from "react";

export const COMMIT_DELAY_MS = 500;

interface Props {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  multiline?: boolean;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** 入力が止まって確定するまでの時間 */
  delay?: number;
}

/**
 * 入力中はローカル state に持ち、フォーカスが外れたとき・入力が止まって delay ミリ秒たったとき・
 * アンマウント時に 1 回だけ onCommit する (履歴を 1 件にするため)。
 */
export function CommitField({ value, onCommit, label, multiline, placeholder, inputRef, delay = COMMIT_DELAY_MS }: Props) {
  const [local, setLocal] = useState(value);
  const localRef = useRef(value);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const focused = useRef(false);
  const composing = useRef(false);

  // 外から値が変わった (Undo など) ら取り込む。
  // ただし入力中に、確定した値 (前後の空白を除いたもの) が戻ってきただけなら上書きしない
  // (「予約 」と打ったあとの続きの入力で、末尾の空白が消えるのを防ぐ)
  useEffect(() => {
    if (focused.current && value === localRef.current.trim()) return;
    setLocal(value);
    localRef.current = value;
    dirty.current = false;
  }, [value]);

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    commitRef.current(localRef.current);
  };

  useEffect(
    () => () => {
      flush();
    },
    [],
  );

  const change = (v: string) => {
    setLocal(v);
    localRef.current = v;
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    // IME の変換中は確定しない (compositionend で再開する)
    if (!composing.current) timer.current = setTimeout(flush, delay);
  };

  const handlers = {
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      composing.current = false;
      flush();
    },
    onCompositionStart: () => {
      composing.current = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    onCompositionEnd: () => {
      composing.current = false;
      if (dirty.current) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, delay);
      }
    },
  };

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {multiline ? (
        <textarea
          aria-label={label}
          value={local}
          placeholder={placeholder}
          rows={4}
          onChange={(e) => change(e.target.value)}
          {...handlers}
        />
      ) : (
        <input
          aria-label={label}
          ref={inputRef}
          value={local}
          placeholder={placeholder}
          onChange={(e) => change(e.target.value)}
          {...handlers}
          onKeyDown={(e) => {
            // 変換確定の Enter では確定しない
            if (e.key === "Enter" && !composing.current && !e.nativeEvent.isComposing) flush();
          }}
        />
      )}
    </label>
  );
}
