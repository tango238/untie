// 業務ルールは model/pms.wasm が答える。ここは読み込むだけ。
import { readFileSync } from "node:fs";
import { load } from "../../model/pms.ts";

const bound = await load(readFileSync(new URL("../../model/pms.wasm", import.meta.url)));
export const rules = bound.modules["untie.sys_pms"];
export type ReservationState = Parameters<typeof rules.予約を確定する>[0];
export type RoomState = Parameters<typeof rules.部屋の割り当てを記録する>[0];
export const reservationStates: ReservationState[] = ["仮予約", "確定", "チェックイン済", "チェックアウト済", "取消"];
export const roomStates: RoomState[] = ["清掃待ち", "清掃中", "準備完了", "使用中"];

/** モデルの答え (value) を取り出す。入力が読めなかったときは投げる (呼ぶ前に状態の名前は確かめてある) */
export function answer<T>(r: { value?: T; issues?: unknown }): T {
  if (r.issues !== undefined || r.value === undefined) throw new Error("model refused input: " + JSON.stringify(r.issues));
  return r.value;
}
