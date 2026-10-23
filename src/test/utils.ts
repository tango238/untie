import { createHotelSample } from "../sample";
import { useUntieStore } from "../store";

/** グローバルストアをサンプルの初期状態に戻す */
export function resetStore(model = createHotelSample()) {
  useUntieStore.setState({
    model,
    history: { past: [], future: [] },
    dragBase: null,
    toasts: [],
    ui: { currentBoardId: model.boards[0]!.id, selection: null, rightPanel: "properties", nameFocusNonce: 0 },
  });
}
