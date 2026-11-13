// キャンバス外 (ツールバー・要素一覧) からキャンバスを操作するための薄い橋渡し。
// Canvas が起動中に関数を登録する。キャンバスが無い環境 (テスト) では何もしない。
import type { Point } from "./toFlow";

export interface CanvasApi {
  /** 見えている範囲の中央 (フロー座標) */
  getCenter?: () => Point | null;
  /** 要素のノードへスクロールする。laneId があれば (ワークフローボード)、その行の中の要素を先に探す (同じ業務・作業が複数の行に出るため) */
  focus?: (elementId: string, laneId?: string) => void;
}

export const canvasApi: CanvasApi = {};

/** 見えている範囲の中央。取れなければ固定の位置 */
export function viewCenter(): Point {
  return canvasApi.getCenter?.() ?? { x: 400, y: 300 };
}

/** 要素一覧からキャンバスへドラッグするときの dataTransfer の型 */
export const ELEMENT_DRAG_TYPE = "application/x-untie-element";
