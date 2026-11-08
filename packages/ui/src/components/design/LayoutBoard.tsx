import { builtinDesignScreen, designScreenName, SHELL_SHORT_LABELS } from "@untie/core/model/sitemap";
import type { SystemDesign } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { MokkunPreview } from "./MokkunPreview";
import { cachedMokkunDoc } from "./mokkunDoc";

/** プレビューする画面: 選んでいる画面 (ui.designScreenId)、無ければトップページ、それも無ければ最初の画面 */
export function previewScreenId(design: SystemDesign | undefined, selectedId: string | undefined): string | undefined {
  if (!design || design.screens.length === 0) return undefined;
  if (selectedId !== undefined && design.screens.some((s) => s.id === selectedId)) return selectedId;
  return builtinDesignScreen(design, "top")?.id ?? design.screens[0]!.id;
}

/** 設計モードのレイアウトボードの中央: 画面を選んで、mokkun で描いたプレビューを見る。プレビューの中の遷移で、選んだ画面も変わる */
export function LayoutBoard() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const selectedId = useUntieStore((s) => s.ui.designScreenId);
  const selectDesignScreen = useUntieStore((s) => s.selectDesignScreen);
  const design = model.designs.find((d) => d.systemId === systemId);
  const current = previewScreenId(design, selectedId);

  if (!design || !systemId || current === undefined) {
    return (
      <section className="layout-board" aria-label="レイアウトのプレビュー">
        <p className="hint">サイトマップで画面を足すとプレビューできます</p>
      </section>
    );
  }
  const doc = cachedMokkunDoc(model, systemId, design);
  return (
    <section className="layout-board" aria-label="レイアウトのプレビュー">
      <div className="layout-toolbar">
        <label className="layout-screen-select">
          <span>プレビューする画面</span>
          <select aria-label="プレビューする画面" value={current} onChange={(e) => selectDesignScreen(e.target.value)}>
            {design.screens.map((s) => (
              <option key={s.id} value={s.id}>
                {designScreenName(model, s)}
              </option>
            ))}
          </select>
        </label>
        {design.screens.find((s) => s.id === current)?.shell !== undefined && (
          <p className="hint">この画面はレイアウトを上書きしています ({SHELL_SHORT_LABELS[doc.shellOf(current)]})。画面ボードで変えられます</p>
        )}
      </div>
      {doc.viewErrors[current] !== undefined && (
        <p className="hint mokkun-error" role="alert">
          この画面の画面 UI が mokkun の検証に通らないので、仮の画面を出しています ({doc.viewErrors[current]})
        </p>
      )}
      {doc.error !== undefined ? (
        <p className="hint mokkun-error" role="alert">
          プレビューできません: 画面の定義が mokkun の検証に通りませんでした ({doc.error})
        </p>
      ) : (
        <div className="layout-frame">
          <MokkunPreview
            schema={doc.schema}
            viewName={doc.viewNameOf(current)}
            shell={doc.shellOf(doc.viewNameOf(current))}
            onNavigate={(view) => {
              // プレビューの中で画面が移ったら、選んでいる画面も移す (設計に無い view 名は無視)
              const target = design.screens.find((s) => doc.viewNameOf(s.id) === view);
              if (target) selectDesignScreen(target.id);
            }}
          />
        </div>
      )}
    </section>
  );
}
