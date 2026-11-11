// 設計モードの設計ボード (サイトマップ・ナビゲーション・画面・データ・関連・シーケンス図・ドメイン・コンテキストマップ)。モデルには保存せず、id と順序とラベルだけをここに置く。
// 固定ボード (fixedBoards.ts)・分析ボード (analysis.ts) と同じ流儀。
import type { DesignScreen, SystemDesign, UntieModel } from "./types";

/** ボードの選択肢に並べる順 */
export const DESIGN_BOARD_KINDS = ["sitemap", "navigation", "screen", "data", "relation", "sequence", "domain", "contextmap"] as const;
export type DesignBoardKind = (typeof DESIGN_BOARD_KINDS)[number];

export const DESIGN_BOARD_LABELS: Record<DesignBoardKind, string> = {
  sitemap: "サイトマップ",
  navigation: "ナビゲーション",
  screen: "画面",
  data: "データ",
  relation: "関連",
  sequence: "シーケンス図",
  domain: "ドメイン",
  contextmap: "コンテキストマップ",
};

const PREFIX = "design:";

export function designBoardId(kind: DesignBoardKind): string {
  return `${PREFIX}${kind}`;
}

/** 設計ボードの id なら種類を返す */
export function parseDesignBoardId(boardId: string): DesignBoardKind | null {
  if (!boardId.startsWith(PREFIX)) return null;
  const kind = boardId.slice(PREFIX.length);
  return (DESIGN_BOARD_KINDS as readonly string[]).includes(kind) ? (kind as DesignBoardKind) : null;
}

/** 既定のデータベースの id と名前 (ensureDesign が、データベースが 1 つも無いときに足す) */
export const DEFAULT_DATABASE_ID = "db_default";
export const DEFAULT_DATABASE_NAME = "既定のデータベース";

/**
 * 設計から、条件に合う画面を外し、それを指す遷移とナビゲーションの項目も外す (画面の bindings は画面と一緒に消える)。
 * removeElement / moveToSystem (画面が別のシステムへ移る) / repairModel が同じ範囲を外すための共通の処理。
 * immer の draft にも普通のオブジェクトにも使える (design を直接書き換える)。外した画面の id を返す
 */
export function removeDesignScreens(design: SystemDesign, shouldRemove: (screen: DesignScreen) => boolean): Set<string> {
  const gone = new Set(design.screens.filter(shouldRemove).map((s) => s.id));
  if (gone.size === 0) return gone;
  design.screens = design.screens.filter((s) => !gone.has(s.id));
  design.transitions = design.transitions.filter((t) => !gone.has(t.from) && !gone.has(t.to));
  for (const group of design.layout.navigation) group.items = group.items.filter((i) => !gone.has(i.screenId));
  return gone;
}

/**
 * 設計が使うデータベースの id。databaseIds が空のときは既定のデータベース: db_default があればそれ、無ければ databases の先頭、それも無ければ無し
 */
export function effectiveDatabaseIds(model: Pick<UntieModel, "databases">, design: Pick<SystemDesign, "databaseIds">): string[] {
  if (design.databaseIds.length > 0) return design.databaseIds;
  const fallback = model.databases.find((d) => d.id === DEFAULT_DATABASE_ID) ?? model.databases[0];
  return fallback ? [fallback.id] : [];
}

/** すべての設計で使われている id (画面・遷移・ナビゲーションのグループ)。これらは設計をまたいで一意なので、新しい id を作るときに避ける */
export function usedDesignIds(model: Pick<UntieModel, "designs">): Set<string> {
  const used = new Set<string>();
  for (const d of model.designs) {
    for (const s of d.screens) used.add(s.id);
    for (const t of d.transitions) used.add(t.id);
    for (const g of d.layout.navigation) used.add(g.id);
  }
  return used;
}
