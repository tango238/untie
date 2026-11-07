import { DESIGN_BOARD_LABELS, type DesignBoardKind } from "@untie/core/model/design";

/**
 * 設計ボード (サイトマップ・レイアウト・画面・データ) の仮置き。
 * 土台の段階なので、ボード名と「次の段階で作ります」の 1 文だけを中央に出す
 */
export function DesignBoard({ kind }: { kind: DesignBoardKind }) {
  return (
    <section className="design-board" aria-label={`設計ボード: ${DESIGN_BOARD_LABELS[kind]}`}>
      <h2>{DESIGN_BOARD_LABELS[kind]}</h2>
      <p>この画面は次の段階で作ります</p>
    </section>
  );
}
