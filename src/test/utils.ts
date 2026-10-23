import { placeOnBoard } from "../model/commands";
import type { UntieModel } from "../model/types";
import { createHotelSample } from "../sample";
import { useUntieStore } from "../store";

/**
 * サンプルの「全体」ボードにアクターのカード (フロント担当・支配人) を足したもの。
 * サンプル自体はアクターをラベルで見せるためカードを置いていないが、カード操作のテストに使う。
 */
export function sampleWithActorCards(): UntieModel {
  let m = createHotelSample();
  for (const [elementId, x] of [["actor_front", 40], ["actor_manager", 260]] as const) {
    const r = placeOnBoard(m, { boardId: "board_overview", elementId, position: { x, y: -120 } });
    if (!r.ok) throw new Error(r.reason);
    m = r.model;
  }
  return m;
}

/** グローバルストアをサンプル (アクターのカード付き) の初期状態に戻す */
export function resetStore(model = sampleWithActorCards()) {
  useUntieStore.setState({
    model,
    history: { past: [], future: [] },
    dragBase: null,
    toasts: [],
    ui: { currentBoardId: model.boards[0]!.id, selection: null, rightPanel: "properties", nameFocusNonce: 0 },
  });
}
