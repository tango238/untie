import { designScreenName } from "@untie/core/model/sitemap";
import { useUntieStore } from "../../store";
import { MokkunPreview } from "./MokkunPreview";
import { cachedMokkunDoc } from "./mokkunDoc";

/**
 * 設計モードの画面ボードの中央: 選んだ画面を mokkun で描いたプレビュー。プレビューの中の遷移で、選んだ画面も変わる。
 * 画面 UI が mokkun の検証に通らないときは、仮の画面を出して、上に理由を出す
 */
export function ScreenBoard() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const selectedId = useUntieStore((s) => s.ui.designScreenId);
  const selectDesignScreen = useUntieStore((s) => s.selectDesignScreen);
  const design = model.designs.find((d) => d.systemId === systemId);
  const screen = design?.screens.find((s) => s.id === selectedId);

  if (!design || !systemId || !screen) {
    return (
      <section className="layout-board" aria-label="画面のプレビュー">
        <p className="hint">{design && design.screens.length > 0 ? "左の一覧から画面を選んでください" : "サイトマップで画面を足すと、ここでプレビューできます"}</p>
      </section>
    );
  }
  const doc = cachedMokkunDoc(model, systemId, design);
  const problem = doc.viewErrors[screen.id];
  return (
    <section className="layout-board" aria-label="画面のプレビュー">
      <div className="layout-toolbar">
        <h2 className="dsl-title">{designScreenName(model, screen)}</h2>
      </div>
      {problem !== undefined && (
        <div className="hint mokkun-error screen-problem" role="alert">
          <strong>この画面の問題</strong>
          <p>画面 UI が mokkun の検証に通らないので、仮の画面を出しています。右の「画面の組み立て」で直してください。</p>
          <p>{problem}</p>
        </div>
      )}
      {doc.error !== undefined ? (
        <p className="hint mokkun-error" role="alert">
          プレビューできません: 画面の定義が mokkun の検証に通りませんでした ({doc.error})
        </p>
      ) : (
        <div className="layout-frame">
          <MokkunPreview
            schema={doc.schema}
            viewName={doc.viewNameOf(screen.id)}
            shell={doc.shellOf(doc.viewNameOf(screen.id))}
            onNavigate={(view) => {
              const target = design.screens.find((s) => doc.viewNameOf(s.id) === view);
              if (target) selectDesignScreen(target.id);
            }}
          />
        </div>
      )}
    </section>
  );
}
