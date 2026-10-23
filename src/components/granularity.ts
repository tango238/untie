// 固定ボードごとの書き方と粒度の目安。似た要素を並べて見比べられるよう、
// ボードごとに比べる種類の組を決め、固定ボードのヒント欄とプロパティ欄で使う。
import type { FixedLayer } from "../model/fixedBoards";
import type { ElementKind } from "../model/types";

export type GuideKind = Exclude<ElementKind, "issue">;

export interface GranularityGuide {
  /** 何を書くか (1 行の定義) */
  what: string;
  /** 粒度の目安 */
  size: string;
  /** 書き方 */
  naming: string;
  /** 良い例 */
  examples: string;
  /** 大きすぎる例と、それが当たるもの */
  tooBig: string;
  /** 細かすぎる例と、それが当たるもの */
  tooSmall: string;
  /** 迷ったときの問い */
  question: string;
  /** プロパティ欄の名前欄に出す書き方 */
  nameHint: string;
}

export const GRANULARITY: Record<GuideKind, GranularityGuide> = {
  actor: {
    what: "作業を受け持つ社内の人の役割",
    size: "役割の単位。同じ作業を受け持つ人は 1 つにまとめる",
    naming: "「〇〇担当」「〇〇係」などの役割名",
    examples: "フロント担当、清掃担当、支配人",
    tooBig: "スタッフ → 役割ごとに分ける",
    tooSmall: "山田さん → 個人ではなく役割で書く",
    question: "社内の人で、作業を受け持つか",
    nameHint: "個人名ではなく役割名で書きます (例: フロント担当)",
  },
  externalActor: {
    what: "顧客・取引先・外部サービスなど、社外の相手",
    size: "やり取りする相手の単位。社外のシステムもここに入れる",
    naming: "相手の呼び名",
    examples: "宿泊客、予約サイト、決済サービス",
    tooBig: "外部の人 → 相手ごとに分ける",
    tooSmall: "常連の宿泊客 → 作業が変わらなければまとめる",
    question: "社外の相手で、作業に関わるか (自社で使う仕組みならシステム)",
    nameHint: "相手の呼び名で書きます (例: 宿泊客、予約サイト)",
  },
  system: {
    what: "自社で使う情報システム。作業を自動で受け持ち、情報の置き場所にもなる",
    size: "1 つの製品・仕組みの単位",
    naming: "システム名",
    examples: "宿泊管理システム、会計システム",
    tooBig: "社内システム → 製品ごとに分ける",
    tooSmall: "予約画面 → システムの中の 1 画面 (操作に当たる)",
    question: "自社で使う仕組みで、作業を受け持つか、情報を持つか (紙なら帳票、社外なら外部アクター)",
    nameHint: "システム名で書きます (例: 宿泊管理システム)",
  },
  ledger: {
    what: "紙の台帳・伝票など、情報を書き残す・読み取る紙",
    size: "1 冊の台帳・1 種類の伝票の単位",
    naming: "台帳・伝票の名前",
    examples: "宿泊者名簿、清掃チェック表",
    tooBig: "紙の書類 → 台帳・伝票ごとに分ける",
    tooSmall: "名簿の 1 ページ → 帳票の中身",
    question: "紙で、情報を書き残したり読み取ったりするか (作業は受け持たない)",
    nameHint: "台帳・伝票の名前で書きます (例: 宿泊者名簿)",
  },
  business: {
    what: "部門や担当で分かれる仕事の大きなまとまり",
    size: "活動がいくつか入る。業務マニュアルの章くらい",
    naming: "「〇〇受付」「〇〇管理」などの区分の名前",
    examples: "予約受付、チェックイン、清掃・準備",
    tooBig: "ホテル運営 → 業務に分ける",
    tooSmall: "客室対応 → 活動に当たる",
    question: "これだけで仕事の区分として説明できるか",
    nameHint: "仕事の区分の名前で書きます (例: 予約受付)",
  },
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
    what: "人やシステムが行う 1 つの手順",
    size: "1 人 (または 1 つのシステム) が一続きでやり終える。途中で担当が代わるなら分ける",
    naming: "「〇〇を△△する」(担当の動き)",
    examples: "本人確認をする、鍵を渡す",
    tooBig: "チェックインする → 活動か業務に当たる",
    tooSmall: "鍵を棚から取る → 作業の手順の一部",
    question: "誰が (どのシステムが) やるかを決められるか。担当は必ず結ぶ",
    nameHint: "「〇〇を△△する」と担当の動きで書きます (例: 本人確認をする)",
  },
  usecase: {
    what: "作業の中で、システムや帳票に対して行う 1 回の操作",
    size: "画面 1 つ、または記入 1 回。情報を登録・検索・更新・取消するくらいの単位",
    naming: "「〇〇を△△する」(情報に対する動き)",
    examples: "チェックインを記録する、予約を検索する",
    tooBig: "予約を管理する → 登録・変更・取消に分ける",
    tooSmall: "氏名欄に入力する → 操作の中の 1 項目",
    question: "どのシステム・帳票の、どの情報に触れるか言えるか (言えなければ作業。帳票への記入も操作に含む)",
    nameHint: "「〇〇を△△する」と情報に対する動きで書きます (例: チェックインを記録する)",
  },
  context: {
    what: "情報をまとめる親カテゴリ (関心ごとの領域)",
    size: "関係の深い情報が数個入る。情報を探すときの見出しくらい",
    naming: "名詞の分類名",
    examples: "予約、顧客、客室、料金",
    tooBig: "ホテル → 分類にならない",
    tooSmall: "予約番号 → 情報の中の項目",
    question: "情報をここに分けて置けば探しやすいか",
    nameHint: "名詞の分類名で書きます (例: 顧客)",
  },
  information: {
    what: "業務で扱う情報のまとまり。記録や書類に当たる",
    size: "伝票 1 枚・台帳の 1 行・画面の 1 件くらい",
    naming: "名詞 (〇〇、〇〇記録)",
    examples: "予約、宿泊客、請求、清掃記録",
    tooBig: "顧客情報全般 → 情報ごとに分ける",
    tooSmall: "電話番号 → 情報の中の項目 (説明に書く)",
    question: "操作で登録したり探したりする対象か",
    nameHint: "名詞で書きます (例: 予約、清掃記録)",
  },
  variation: {
    what: "情報や条件を分ける種別と、その値の一覧",
    size: "値が数個から十数個の区分",
    naming: "「〇〇種別」「〇〇区分」「〇〇方法」",
    examples: "部屋タイプ、予約経路、支払方法",
    tooBig: "マスタ → 区分ごとに分ける",
    tooSmall: "シングル → 値の 1 つ",
    question: "値によって作業や条件が変わるか",
    nameHint: "区分の名前で書き、値は下の一覧に足します (例: 支払方法)",
  },
  state: {
    what: "情報やモノがたどる段階",
    size: "状態グループ 1 つに数個。同時には 1 つだけになる",
    naming: "「〇〇済」「〇〇中」「〇〇待ち」",
    examples: "仮予約、確定、清掃中、準備完了",
    tooBig: "処理中 → 何の処理か分ける",
    tooSmall: "鍵を渡した → 作業の途中で、段階は変わらない",
    question: "この段階によって、次にできる操作が変わるか",
    nameHint: "「〇〇済」「〇〇中」などの段階で書きます (例: 清掃中)",
  },
  condition: {
    what: "作業や操作で判断に使う条件・ルール",
    size: "判断 1 つ分。はい・いいえで答えられる",
    naming: "「〇〇である」「〇〇ができる」「〇〇が発生する」",
    examples: "取消料が発生する、満室である",
    tooBig: "予約のルール → 判断ごとに分ける",
    tooSmall: "前日 18 時以降 → 条件の中身 (説明に書く)",
    question: "これで操作の結果や進め方が変わるか",
    nameHint: "はい・いいえで答えられる形で書きます (例: 満室である)",
  },
};

const PEOPLE: GuideKind[] = ["actor", "externalActor", "system", "ledger"];
const WORK: GuideKind[] = ["buc", "activity", "usecase"];
const DATA: GuideKind[] = ["context", "information", "variation"];

/** 固定ボードごとに並べる種類と、強調する種類 (並べたもの全部がボードに出るなら強調しない) */
export const LAYER_GUIDES: Record<FixedLayer, { kinds: GuideKind[]; current?: GuideKind }> = {
  actor: { kinds: PEOPLE },
  business: { kinds: ["business", "buc", "activity"], current: "business" },
  buc: { kinds: WORK, current: "buc" },
  activity: { kinds: WORK, current: "activity" },
  usecase: { kinds: WORK, current: "usecase" },
  context: { kinds: DATA, current: "context" },
  information: { kinds: DATA, current: "information" },
  variation: { kinds: DATA, current: "variation" },
  state: { kinds: ["state", "condition"], current: "state" },
  condition: { kinds: ["condition", "state"], current: "condition" },
};

export function isGuideKind(kind: string): kind is GuideKind {
  return Object.keys(GRANULARITY).includes(kind);
}
