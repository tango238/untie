// 活動 (BUC)・作業 (アクティビティ)・操作 (ユースケース) の書き方と粒度の目安。
// 3 段を並べて見比べられるよう、固定ボードのヒント欄とプロパティ欄で使う。

export const GUIDE_KINDS = ["buc", "activity", "usecase"] as const;
export type GuideKind = (typeof GUIDE_KINDS)[number];

export interface GranularityGuide {
  /** 何を書くか (1 行の定義) */
  what: string;
  /** 粒度の目安 */
  size: string;
  /** 書き方 */
  naming: string;
  /** 良い例 */
  examples: string;
  /** 大きすぎる例と、それが当たる段 */
  tooBig: string;
  /** 細かすぎる例と、それが当たる段 */
  tooSmall: string;
  /** 迷ったときの問い */
  question: string;
  /** プロパティ欄の名前欄に出す書き方 */
  nameHint: string;
}

export const GRANULARITY: Record<GuideKind, GranularityGuide> = {
  buc: {
    what: "業務の中で、1 つの目的を果たす作業のまとまり",
    size: "依頼やきっかけから完了までの一連の流れ。作業が 2〜5 個入る",
    naming: "「〇〇対応」「〇〇提供」などのまとまりの名前",
    examples: "客室対応、飲食提供",
    tooBig: "宿泊業務全般 → 業務に当たる",
    tooSmall: "鍵を渡す → 作業に当たる",
    question: "これが終わると、何か 1 つ片づいたと言えるか",
    nameHint: "まとまりの名前で書きます (例: 客室対応)",
  },
  activity: {
    what: "人が行う 1 つの手順",
    size: "1 人が一続きでやり終える。途中で担当が代わるなら分ける",
    naming: "「〇〇を△△する」(人の動き)",
    examples: "本人確認をする、鍵を渡す",
    tooBig: "チェックインする → 活動か業務に当たる",
    tooSmall: "鍵を棚から取る → 作業の手順の一部",
    question: "誰がやるかを 1 人に決められるか",
    nameHint: "「〇〇を△△する」と人の動きで書きます (例: 本人確認をする)",
  },
  usecase: {
    what: "作業の中で、システムや帳簿に対して行う 1 回の操作",
    size: "画面 1 つ、または記入 1 回。情報を登録・検索・更新・取消するくらいの単位",
    naming: "「〇〇を△△する」(情報に対する動き)",
    examples: "チェックインを記録する、予約を検索する",
    tooBig: "予約を管理する → 登録・変更・取消に分ける",
    tooSmall: "氏名欄に入力する → 操作の中の 1 項目",
    question: "どのシステム・帳簿の、どの情報に触れるか言えるか (言えなければ人の作業。紙の帳簿への記入も操作に含む)",
    nameHint: "「〇〇を△△する」と情報に対する動きで書きます (例: チェックインを記録する)",
  },
};

export function isGuideKind(kind: string): kind is GuideKind {
  return (GUIDE_KINDS as readonly string[]).includes(kind);
}
