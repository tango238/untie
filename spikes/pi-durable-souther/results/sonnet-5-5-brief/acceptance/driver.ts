// 受け入れテストと、アプリケーション (HTTP API) をつなぐ。業務ルールは判断しない。
import type { AddressInfo } from "node:net";
import { createApp } from "../app/src/app.ts";
import type { AcceptanceDriver, AcceptanceResult } from "./run.test.ts";

const server = createApp();
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
server.unref();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

const stay = { guest: { name: "山田 太郎" }, roomType: "シングル", checkIn: "2030-01-10", checkOut: "2030-01-12" };

const driver: AcceptanceDriver = {
  async run({ operation, states, conditions }) {
    const roomState = states["部屋の状態"];
    const resState = states["予約の状態"];
    // 前提の状態のものを用意する (確かめるための API)
    let roomId: string | undefined;
    if (roomState !== undefined) roomId = (await call("POST", "/rooms", { type: "シングル", state: roomState })).json.id;
    let resId: string | undefined;
    if (resState !== undefined || roomState !== undefined) {
      // 部屋の操作は予約を読むだけなので、予約は何でもよい (確定にしておく)。チェックアウトでは使用中の部屋を結びつける
      const body: Record<string, unknown> = { ...stay, state: resState ?? "確定" };
      if (operation === "チェックアウトを記録する") {
        roomId = (await call("POST", "/rooms", { type: "シングル", state: "使用中" })).json.id;
        body.roomId = roomId;
      }
      resId = (await call("POST", "/test-setup/reservations", body)).json.id;
    }

    let r: { status: number; json: any };
    switch (operation) {
      case "予約を確定する": r = await call("POST", `/reservations/${resId}/confirm`); break;
      case "予約を変更する": r = await call("PUT", `/reservations/${resId}`, { checkOut: "2030-01-13" }); break;
      case "予約を取り消す": r = await call("POST", `/reservations/${resId}/cancel`, { cancellationFee: conditions["取消料が発生する"] }); break;
      case "チェックインを記録する": r = await call("POST", `/reservations/${resId}/check-in`, { earlyCheckInAllowed: conditions["早めのチェックインができる"] }); break;
      case "部屋の割り当てを記録する": r = await call("POST", `/rooms/${roomId}/assign`, { reservationId: resId, full: conditions["満室である"] }); break;
      case "追加料金を登録する": r = await call("POST", `/reservations/${resId}/charges`, { description: "ルームサービス", amount: 1500 }); break;
      case "チェックアウトを記録する": r = await call("POST", `/reservations/${resId}/check-out`); break;
      default: throw new Error(`知らない操作: ${operation}`);
    }

    // 保存されている状態を読み直す
    const after: Record<string, string> = {};
    if (resState !== undefined) after["予約の状態"] = (await call("GET", `/reservations/${resId}`)).json.state;
    if (roomId !== undefined && (roomState !== undefined || operation === "チェックアウトを記録する"))
      after["部屋の状態"] = (await call("GET", `/rooms/${roomId}`)).json.state;
    // 部屋の操作のとき、予約の状態は期待に無いので返さなくてよい (部屋のみ)
    if (roomState !== undefined && resState === undefined) delete after["予約の状態"];

    const outcome = r.json.outcome as AcceptanceResult["outcome"] | undefined;
    if (outcome === undefined) return { outcome: "error", error: { type: r.status >= 500 ? "server" : "input", status: r.status }, states: after };
    return { outcome, ...(r.json.condition ? { condition: r.json.condition } : {}), states: after };
  },
};
export default driver;
