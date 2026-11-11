// 開発モード: 開発者が中身を確かめるための画面 (内部のモデルを直に見る・直すボードなど) を出すかどうか。
// 利用者に見せると覚えることが増えすぎる画面は、ふだんは出さず、開発モードのときだけ出す。
// 開発サーバー (vite) を起動するときの設定 UNTIE_DEV_MODE で決まる (既定は off)。build したものは必ず off なので、デプロイしたものには出ない。
// 切り替えは起動時だけで、画面からは変えられない。
import { ANALYSIS_KINDS, parseAnalysisBoardId, type AnalysisKind } from "@untie/core/model/analysis";
import { DESIGN_BOARD_KINDS, parseDesignBoardId, type DesignBoardKind } from "@untie/core/model/design";

// 各アプリの vite.config.ts が define で埋める (テストなど、埋まっていないところでは off)
declare const __UNTIE_DEV_MODE__: boolean | undefined;
const built = typeof __UNTIE_DEV_MODE__ === "boolean" ? __UNTIE_DEV_MODE__ : false;
let override: boolean | undefined;

/** 開発モードか */
export function isDevMode(): boolean {
  return override ?? built;
}

/** テストで開発モードを切り替える (undefined で起動時の設定に戻す) */
export function setDevModeForTest(value: boolean | undefined): void {
  override = value;
}

/** 開発モードのときだけ出す分析ボード: イベントストーミング (分析から導いたドメインモデルの候補) */
export const DEV_ONLY_ANALYSIS_KINDS: readonly AnalysisKind[] = ["storming"];
/** 開発モードのときだけ出す設計ボード: ドメイン・コンテキストマップ (内部のドメインモデルを直に見る・直す) */
export const DEV_ONLY_DESIGN_KINDS: readonly DesignBoardKind[] = ["domain", "contextmap", "rules"];

/** いま選べる分析ボード (並べる順) */
export function visibleAnalysisKinds(): AnalysisKind[] {
  return ANALYSIS_KINDS.filter((k) => isDevMode() || !DEV_ONLY_ANALYSIS_KINDS.includes(k));
}

/** いま選べる設計ボード (並べる順) */
export function visibleDesignKinds(): DesignBoardKind[] {
  return DESIGN_BOARD_KINDS.filter((k) => isDevMode() || !DEV_ONLY_DESIGN_KINDS.includes(k));
}

/** そのボードを、いま開けるか (開発モードでなければ、開発用のボードは開けない)。自由ボード・固定ボードはいつも開ける */
export function isBoardAvailable(boardId: string): boolean {
  if (isDevMode()) return true;
  const analysis = parseAnalysisBoardId(boardId);
  if (analysis) return !DEV_ONLY_ANALYSIS_KINDS.includes(analysis);
  const design = parseDesignBoardId(boardId);
  if (design) return !DEV_ONLY_DESIGN_KINDS.includes(design);
  return true;
}
