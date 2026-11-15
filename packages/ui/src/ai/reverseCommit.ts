// 「ソースコードから作成」の段階の結果を、開いているモデルに 1 件の履歴として反映する。
// 段階は、実行を始めたときのモデル (base) から結果のモデルを組み立てて返すだけで、ストアは触らない。ここで、最後に 1 回だけ書く:
// 失敗・中断のときは呼ばれないので、モデルは実行の前のまま。書くのは beginAgentEdit〜endAgentEdit の中の 1 回の agentApply なので、
// 元に戻す (Undo) で、その段階の結果がまとめて戻る。
import type { UntieModel } from "@untie/core/model/types";
import { useUntieStore } from "../store";
import { useAgentStore } from "./agentStore";

/** AI のペインが作業中 (または編集の途中) の理由。段階を実行するボタンにも使う */
export const AGENT_BUSY_REASON = "AI のペインが作業中です。終わってから実行してください。";

/** AI のペインが、モデルを編集している最中か (実行中、または 1 件の履歴にまとめている途中) */
export function agentIsEditing(): boolean {
  return useAgentStore.getState().running || useUntieStore.getState().agentBase !== null;
}

export type CommitResult = { ok: true } | { ok: false; reason: string };

/**
 * base から作った next を、今のモデルとして反映する。実行中にモデルが替わっていたら (別のモデルを開いた・手で直した・AI の会話が書いた)、
 * 古い base から作った結果で上書きしないよう、反映せず理由を返す。クラウドファイルには書かない
 */
export function commitStageModel(base: UntieModel, next: UntieModel, docSeq: number): CommitResult {
  const st = useUntieStore.getState();
  if (st.cloud) return { ok: false, reason: "クラウドのファイルには、この機能で足せません。" };
  // AI のペインの編集の途中に書くと、ペインの 1 件の履歴にまとまってしまう (段階の結果だけを元に戻せなくなる)。ペインが終わってからにする
  if (agentIsEditing()) return { ok: false, reason: `${AGENT_BUSY_REASON}結果は反映しませんでした。` };
  if (st.docSeq !== docSeq || st.model !== base) return { ok: false, reason: "実行している間にモデルが変わったので、結果は反映しませんでした。もう一度実行してください。" };
  st.beginAgentEdit();
  const r = st.agentApply(() => ({ ok: true as const, model: next }));
  st.endAgentEdit();
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}
