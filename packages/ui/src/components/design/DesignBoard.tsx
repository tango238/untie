import { lazy, Suspense } from "react";
import { DESIGN_BOARD_LABELS, type DesignBoardKind } from "@untie/core/model/design";
import { DslEditor } from "./DslEditor";
import { SitemapCanvas } from "./SitemapCanvas";

// レイアウトのプレビューは mokkun (約 750KB) を使うので、レイアウトを開くまで読み込まない
const LayoutBoard = lazy(() => import("./LayoutBoard").then((m) => ({ default: m.LayoutBoard })));

/**
 * 設計ボード。サイトマップは SitemapCanvas。レイアウトは LayoutBoard。データは DslEditor。画面は仮置きで、ボード名と「次の段階で作ります」の 1 文だけを中央に出す
 */
export function DesignBoard({ kind }: { kind: DesignBoardKind }) {
  if (kind === "sitemap") return <SitemapCanvas />;
  if (kind === "layout") {
    return (
      <Suspense fallback={<p className="hint layout-loading">プレビューを読み込んでいます…</p>}>
        <LayoutBoard />
      </Suspense>
    );
  }
  if (kind === "data") return <DslEditor />;
  return (
    <section className="design-board" aria-label={`設計ボード: ${DESIGN_BOARD_LABELS[kind]}`}>
      <h2>{DESIGN_BOARD_LABELS[kind]}</h2>
      <p>この画面は次の段階で作ります</p>
    </section>
  );
}
