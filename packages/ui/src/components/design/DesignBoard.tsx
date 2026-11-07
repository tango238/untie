import { DESIGN_BOARD_LABELS, type DesignBoardKind } from "@untie/core/model/design";
import { DslEditor } from "./DslEditor";
import { SitemapCanvas } from "./SitemapCanvas";

/**
 * 設計ボード。サイトマップは SitemapCanvas。データは DslEditor。それ以外 (レイアウト・画面) は仮置きで、ボード名と「次の段階で作ります」の 1 文だけを中央に出す
 */
export function DesignBoard({ kind }: { kind: DesignBoardKind }) {
  if (kind === "sitemap") return <SitemapCanvas />;
  if (kind === "data") return <DslEditor />;
  return (
    <section className="design-board" aria-label={`設計ボード: ${DESIGN_BOARD_LABELS[kind]}`}>
      <h2>{DESIGN_BOARD_LABELS[kind]}</h2>
      <p>この画面は次の段階で作ります</p>
    </section>
  );
}
