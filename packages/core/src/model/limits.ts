// 文字列の長さの上限 (schema/untie.schema.json の maxLength を手で写したもの。一致は __tests__/limits.test.ts で確かめる)。
// コマンドはこれを超える入力を失敗にし、readModel / repairModel は超えた文字列を切り詰める (設計書 3.4・6 章)。
// 超えたまま Y.Doc に入ると、スキーマに合わない要素として全員の画面から消え、関係もサーバーに消されるため。

/** 名前 (要素・ボード・meta.name・リンクの表示名・状態グループ・バリエーションの値) */
export const NAME_MAX_LENGTH = 200;
/** 説明 (要素・meta.description) と課題の分析の各項目 */
export const DESCRIPTION_MAX_LENGTH = 4000;
export const GROUP_MAX_LENGTH = 200;
export const VALUE_MAX_LENGTH = 200;
export const ANALYSIS_MAX_LENGTH = 4000;
export const LINK_TITLE_MAX_LENGTH = 200;
export const LINK_URL_MAX_LENGTH = 2000;
/** 非機能要件の検証方法 */
export const VERIFICATION_MAX_LENGTH = 4000;
/** 作業の起点 (その他) */
export const TRIGGER_NOTE_MAX_LENGTH = 4000;
/** データベースの DSL (Prisma 風。0.5.0) */
export const DSL_MAX_LENGTH = 200000;
/** 画面 UI (view) を JSON にしたときの大きさ (設計の画面 UI。0.5.0) */
export const VIEW_JSON_MAX_LENGTH = 200000;
/** 画面 UI (view) の入れ子の深さと、節 (オブジェクト・配列・値) の数の上限。YAML のエイリアスなどで小さな入力が巨大に膨らむのを防ぐ */
export const VIEW_MAX_DEPTH = 64;
export const VIEW_MAX_NODES = 50000;

/** JSON Schema の maxLength と同じ数え方 (コードポイント。サロゲートペアは 1 文字) */
export function textLength(text: string): number {
  let n = 0;
  // for...of は文字列をコードポイントで進む
  for (const _ of text) n++;
  return n;
}

/** max 文字 (コードポイント) を超えていれば、max 文字に切り詰める。超えていなければそのまま */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let n = 0;
  let end = 0;
  for (const ch of text) {
    if (n === max) return text.slice(0, end);
    n++;
    end += ch.length;
  }
  return text;
}

export const isTooLong = (text: string, max: number): boolean => text.length > max && textLength(text) > max;

/** 項目ごとの上限と、失敗の理由 (画面にそのまま出せる) */
export const LIMITS = {
  name: { max: NAME_MAX_LENGTH, label: "名前" },
  description: { max: DESCRIPTION_MAX_LENGTH, label: "説明" },
  group: { max: GROUP_MAX_LENGTH, label: "状態グループ" },
  value: { max: VALUE_MAX_LENGTH, label: "値" },
  analysis: { max: ANALYSIS_MAX_LENGTH, label: "分析の各項目" },
  linkTitle: { max: LINK_TITLE_MAX_LENGTH, label: "リンクの表示名" },
  linkUrl: { max: LINK_URL_MAX_LENGTH, label: "リンクの URL" },
  boardName: { max: NAME_MAX_LENGTH, label: "ボード名" },
  verification: { max: VERIFICATION_MAX_LENGTH, label: "検証方法" },
  triggerNote: { max: TRIGGER_NOTE_MAX_LENGTH, label: "起点 (その他)" },
  dsl: { max: DSL_MAX_LENGTH, label: "DSL" },
  viewJson: { max: VIEW_JSON_MAX_LENGTH, label: "画面 UI (JSON にしたもの)" },
  personaHandle: { max: NAME_MAX_LENGTH, label: "ペルソナの呼び名" },
  personaAttributes: { max: NAME_MAX_LENGTH, label: "ペルソナの属性" },
  personaBackground: { max: DESCRIPTION_MAX_LENGTH, label: "ペルソナの背景と役割" },
  personaGoals: { max: DESCRIPTION_MAX_LENGTH, label: "ペルソナの目標" },
  personaNotes: { max: DESCRIPTION_MAX_LENGTH, label: "ペルソナの備考" },
  eventTimingNote: { max: DESCRIPTION_MAX_LENGTH, label: "発生タイミングの補足" },
  transitionLabel: { max: NAME_MAX_LENGTH, label: "遷移の文言" },
} as const;
export type LimitKey = keyof typeof LIMITS;

/** 上限を超えていれば理由 (「名前は 200 文字までです」)、収まっていれば null */
export function checkLength(key: LimitKey, text: string): string | null {
  const { max, label } = LIMITS[key];
  // 末尾が英数字のラベル (URL) は、助詞の前に空白を入れる
  return isTooLong(text, max) ? `${label}${/[A-Za-z0-9]$/.test(label) ? " " : ""}は ${max} 文字までです` : null;
}
