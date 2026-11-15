// 「ソースコードから作成」の、画面の段階の調査結果を覚えておく (業務の段階が、同じソースを読み直さずに済むように)。
// 覚える場所はこのアプリのメモリの中だけ (寿命は sourceRegistry.ts と同じ。別のモデルを開いたら忘れる。モデルのファイルには保存しない)。
//
// 古くなった調査結果を使わない決まり:
// - 別のモデルを開いた (docSeq が違う) ら使わない
// - ソースを登録し直した (フォルダを選び直した = 木が別のオブジェクトになる・ラベルを変えた・ソースを足した/外した) ら使わない
// - 画面の段階をやり直したら、覚えているものを新しい結果に置き換える (rememberScreenSurvey は 1 つだけ覚える)。
//   やり直しを始める時点で、前のものは忘れる (forgetScreenSurvey。やり直しが失敗・中断したとき、前の範囲の調査結果が残らないように)
import type { SourceTree } from "./sourceTree";

/** 画面の段階の調査結果 (業務の段階の調査の依頼に、データとして渡す) */
export interface ScreenSurvey {
  /** 調査結果の文章 (画面・API・ハンドラー・テーブルの対応) */
  survey: string;
  /** 調査で読んだファイルのパス */
  files: string[];
  /** 画面の段階で、利用者が書いた対象の画面の範囲 (空なら全部) */
  scope: string;
  /** 調査の会話が途中で終わった (上限・長すぎなどで打ち切られ、集まった分で進めた) とき真。業務の段階が、足りないところを読み直す */
  incomplete?: boolean;
}

/** 調査したソース (ラベルと、フォルダの木) */
export interface SurveyedSource {
  label: string;
  tree: SourceTree;
}

let remembered: { docSeq: number; sources: SurveyedSource[]; survey: ScreenSurvey } | null = null;

/** 同じソースの組か (登録し直したものは、木が別のオブジェクトなので違うものになる) */
function sameSources(a: readonly SurveyedSource[], b: readonly SurveyedSource[]): boolean {
  return a.length === b.length && a.every((x, i) => x.label === b[i]!.label && x.tree === b[i]!.tree);
}

/** いま開いているモデル (docSeq) の、画面の段階の調査結果を覚える (前に覚えていたものは置き換える)。調査結果が空なら、覚えず、前のものも忘れる */
export function rememberScreenSurvey(docSeq: number, sources: readonly SurveyedSource[], survey: ScreenSurvey): void {
  remembered = survey.survey.trim() === "" ? null : { docSeq, sources: sources.map((s) => ({ ...s })), survey: { ...survey, files: [...survey.files] } };
}

/** このモデル (docSeq) で、同じソースの組について覚えている調査結果。別のモデル・登録し直したソース・覚えていないときは null */
export function recallScreenSurvey(docSeq: number, sources: readonly SurveyedSource[]): ScreenSurvey | null {
  if (!remembered || remembered.docSeq !== docSeq || !sameSources(remembered.sources, sources)) return null;
  return { ...remembered.survey, files: [...remembered.survey.files] };
}

/** 覚えているものを忘れる */
export function forgetScreenSurvey(): void {
  remembered = null;
}
