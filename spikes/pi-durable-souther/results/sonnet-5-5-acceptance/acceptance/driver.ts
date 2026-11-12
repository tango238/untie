import type { AcceptanceDriver, AcceptanceResult } from "./run.test.ts";
import { createApp } from "../app/src/server.ts";
import type { AddressInfo } from "node:net";

// アプリケーションを起こして (1 度だけ)、HTTP だけで操作する。モデルは直接呼ばない。
const server = createApp();
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
server.unref();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
}

const driver: AcceptanceDriver = {
  async run({ operation, states, conditions }): Promise<AcceptanceResult> {
    let resId: string | undefined, roomId: string | undefined;
    // 前の状態を用意する (確かめるための dev API)
    if (states["部屋の状態"]) roomId = (await call("POST", "/dev/rooms", { state: states["部屋の状態"] })).json.room.id;
    if (states["予約の状態"]) resId = (await call("POST", "/dev/reservations", { state: states["予約の状態"], roomId })).json.reservation.id;
    else if (operation === "部屋の割り当てを記録する") { /* 部屋だけ */ }
    if (operation === "チェックアウトを記録する" && !roomId) {
      roomId = (await call("POST", "/dev/rooms", { state: "使用中" })).json.room.id;
      resId = (await call("POST", "/dev/reservations", { state: states["予約の状態"], roomId })).json.reservation.id;
    }
    const r = resId ? `/reservations/${resId}` : "";
    let out;
    switch (operation) {
      case "予約を確定する": out = await call("POST", `${r}/confirm`); break;
      case "予約を変更する": out = await call("POST", `${r}/change`, { roomType: "ツイン" }); break;
      case "予約を取り消す": out = await call("POST", `${r}/cancel`, { cancellationFeeApplies: conditions["取消料が発生する"], cancellationFee: 1000 }); break;
      case "チェックインを記録する": out = await call("POST", `${r}/check-in`, { earlyCheckInAllowed: conditions["早めのチェックインができる"], guestName: "山田" }); break;
      case "部屋の割り当てを記録する": out = await call("POST", `/rooms/${roomId}/assign`, { fullHouse: conditions["満室である"] }); break;
      case "追加料金を登録する": out = await call("POST", `${r}/charges`, { description: "ルームサービス", amount: 500 }); break;
      case "チェックアウトを記録する": out = await call("POST", `${r}/check-out`); break;
      default: throw new Error(`未対応の操作: ${operation}`);
    }
    const j = out.json;
    const after: Record<string, string> = {};
    if (resId) after["予約の状態"] = (await call("GET", `/reservations/${resId}`)).json.reservation.state;
    if (roomId) after["部屋の状態"] = (await call("GET", `/rooms/${roomId}`)).json.room.state;
    const result: AcceptanceResult = { outcome: j.outcome, states: after };
    if (j.condition) result.condition = j.condition;
    if (j.outcome === "error") result.error = { type: j.error.type, status: out.status };
    return result;
  },
};
export default driver;
