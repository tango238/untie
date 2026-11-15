// 「ソースコードから作成」で登録したソース (ラベル付きのフォルダ) を、このアプリを開いている間だけ覚える。
// フォルダのハンドルはメモリに持つだけで、ファイルにもモデルにも保存しない (アプリを閉じる・再読み込みで消える)。
// ダイアログを閉じて開き直しても、段階ごとに選び直さなくてよいようにするためのもの。
// 取り違えを避けるため、別のモデルを開いた (ストアの docSeq が替わった) ら忘れる: 別のプロジェクトのソースが、前のモデルのものとして残らない。
import { forgetScreenSurvey } from "./surveyMemory";
import type { SourceTree } from "./sourceTree";

export interface RememberedSource {
  label: string;
  tree: SourceTree | null;
  /** 読めるファイルの数 (選んだときに数えたもの) */
  fileCount: number;
}

let remembered: { docSeq: number; sources: RememberedSource[] } | null = null;

/** いま開いているモデル (docSeq) の登録を覚える。何も選んでいない 1 行だけの空の登録は覚えない */
export function rememberSources(docSeq: number, sources: readonly RememberedSource[]): void {
  const empty = sources.length === 1 && sources[0]!.tree === null && sources[0]!.label.trim() === "";
  remembered = empty ? null : { docSeq, sources: sources.map((s) => ({ ...s })) };
}

/** このモデル (docSeq) で覚えている登録。別のモデルのものや、無ければ空 */
export function recallSources(docSeq: number): RememberedSource[] {
  return remembered && remembered.docSeq === docSeq ? remembered.sources.map((s) => ({ ...s })) : [];
}

/** 覚えているものを忘れる */
export function forgetSources(): void {
  remembered = null;
  // 画面の段階の調査結果 (surveyMemory.ts) は、同じ寿命
  forgetScreenSurvey();
}
