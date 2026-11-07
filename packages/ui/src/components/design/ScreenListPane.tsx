import { useMemo } from "react";
import { designScreenName, entryScreenIds } from "@untie/core/model/sitemap";
import { useUntieStore } from "../../store";

/** 設計モードの画面ボードの左ペイン: サイトマップの画面の一覧。画面 UI のある画面と入口の画面に印を付け、押すとその画面を選ぶ */
export function ScreenListPane() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const selectedId = useUntieStore((s) => s.ui.designScreenId);
  const selectDesignScreen = useUntieStore((s) => s.selectDesignScreen);
  const design = model.designs.find((d) => d.systemId === systemId);
  const entries = useMemo(() => (systemId && design ? new Set(entryScreenIds(model, systemId, design)) : new Set<string>()), [model, systemId, design]);
  const screens = design?.screens ?? [];

  return (
    <aside className="sitemap-tree screen-list-pane" aria-label="画面の一覧">
      <h2 className="panel-title">画面</h2>
      {screens.length === 0 ? (
        <p className="hint screen-list-hint">サイトマップで画面を足してください。</p>
      ) : (
        <ul className="screen-pick">
          {screens.map((s) => {
            const selected = s.id === selectedId;
            return (
              <li key={s.id} className={`screen-pick-row${selected ? " is-selected" : ""}`} data-screen-id={s.id}>
                <button type="button" className="screen-pick-name" aria-current={selected ? "true" : undefined} onClick={() => selectDesignScreen(s.id)}>
                  {designScreenName(model, s)}
                </button>
                {entries.has(s.id) && <span className="screen-badge is-entry">入口</span>}
                {s.view !== undefined && <span className="screen-badge is-ui">UI あり</span>}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
