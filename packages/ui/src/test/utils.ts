import { placeOnBoard } from "@untie/core/model/commands";
import type { UntieModel } from "@untie/core/model/types";
import { createHotelSample } from "@untie/core/sample";
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
    file: null,
    savedModel: null,
    history: { past: [], future: [] },
    dragBase: null,
    agentBase: null,
    toasts: [],
    ui: { currentBoardId: model.boards[0]!.id, selection: null, rightPanel: "properties", nameFocusNonce: 0 },
  });
}
