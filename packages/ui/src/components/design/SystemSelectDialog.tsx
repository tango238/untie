import { useEffect, useMemo, useRef, useState } from "react";
import { loadLastDesignSystemId } from "../../store/designPrefs";
import { useUntieStore } from "../../store";

/**
 * 設計の対象のシステムを選ぶダイアログ。モデルのすべてのシステムを名前順に並べ、設計データがあるものには「設計あり」を付ける。
 * 選ぶと設計モードにする。モデルには書かない (設計と既定のデータベースは、最初の編集が ensureDesign で作る)。キャンセルしたら何も変えない。
 * 初期選択は、最後に設計したシステム (モデルにあるときだけ)。切り替えのときは、いまのシステム
 */
export function SystemSelectDialog({ onClose }: { onClose: () => void }) {
  const model = useUntieStore((s) => s.model);
  const currentId = useUntieStore((s) => s.ui.designSystemId);
  const enterDesign = useUntieStore((s) => s.enterDesign);

  const systems = useMemo(() => {
    const withDesign = new Set(model.designs.map((d) => d.systemId));
    return model.elements
      .filter((e) => e.kind === "system")
      .map((e) => ({ id: e.id, name: e.name || "(名前なし)", hasDesign: withDesign.has(e.id) }))
      .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }, [model]);

  const [selected, setSelected] = useState<string | null>(() => {
    const candidates = [currentId, loadLastDesignSystemId()];
    return candidates.find((id): id is string => id != null && systems.some((s) => s.id === id)) ?? null;
  });
  // 選ばれているラジオにフォーカスする (無ければ先頭)
  const focusRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    focusRef.current?.focus();
  }, []);

  const confirm = () => {
    if (selected === null) return;
    enterDesign(selected);
    onClose();
  };

  return (
    <div className="dialog-backdrop" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="dialog system-select-dialog" role="dialog" aria-modal="true" aria-label="システムの選択">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirm();
          }}
        >
          <h2>システムの選択</h2>
          {systems.length === 0 ? (
            <p>システムがまだありません。登場人物ボードでシステムを足してください。</p>
          ) : (
            <>
              <p>設計するシステムを選んでください。</p>
              <ul className="system-select-list" role="radiogroup" aria-label="システム">
                {systems.map((s, i) => (
                  <li key={s.id}>
                    <label>
                      <input
                        ref={s.id === selected || (selected === null && i === 0) ? focusRef : undefined}
                        type="radio"
                        name="design-system"
                        checked={selected === s.id}
                        onChange={() => setSelected(s.id)}
                      />
                      <span className="system-select-name">{s.name}</span>
                      {s.hasDesign && <span className="system-select-badge">設計あり</span>}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              キャンセル
            </button>
            <button type="submit" className="primary" disabled={selected === null}>
              設計する
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
