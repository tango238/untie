// 受け入れテストと app をつなぐ。HTTP 越しに状態を用意し、HTTP 越しに保存された状態を読む。
import type { AddressInfo } from "node:net";
import type { AcceptanceDriver } from "./run.test.ts";
import { createApp } from "../app/src/server.ts";

const server = createApp();
await new Promise<void>((r) => server.listen(0, r));
server.unref();
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}
const post = async (p: string, b?: unknown) => {
  const r = await call("POST", p, b);
  if (r.status >= 300 && r.status !== 409) throw new Error(`${p}: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

let n = 0;
// 予約を、指定の状態まで API で進める
async function makeReservation(state: string): Promise<string> {
  const id = (await post("/reservations", { 宿泊客: { 名前: "客" } })).body.id as string;
  const steps: [string, unknown][] = [];
  if (state !== "仮予約") steps.push(["confirm", {}]);
  if (state === "チェックイン済" || state === "チェックアウト済") steps.push(["check-in", { 早めのチェックインができる: true }]);
  if (state === "チェックアウト済") steps.push(["check-out", {}]);
  if (state === "取消") steps.push(["cancel", { 取消料が発生する: false }]);
  for (const [op, b] of steps) await post(`/reservations/${id}/${op}`, b);
  return id;
}

const driver: AcceptanceDriver = {
  async run({ operation, states, conditions }) {
    const roomState = states["部屋の状態"];
    let resState = states["予約の状態"];
    const roomId = `Z${++n}`;
    let rid: string;
    let roomForCheckout = false;

    if (roomState !== undefined) {
      await post("/rooms", { id: roomId, 状態: roomState });
      rid = await makeReservation("チェックイン済");
    } else {
      rid = await makeReservation(resState);
      // チェックアウトは、部屋の状態も確かめるため、チェックイン済のときだけ部屋を割り当てておく
      if (operation === "チェックアウトを記録する" && resState === "チェックイン済") {
        await post("/rooms", { id: roomId, 状態: "準備完了" });
        await post(`/reservations/${rid}/assign-room`, { 部屋: roomId, 満室である: false });
        roomForCheckout = true;
      }
    }

    const P = `/reservations/${rid}`;
    let r;
    switch (operation) {
      case "予約を確定する": r = await post(`${P}/confirm`); break;
      case "予約を変更する": r = await post(`${P}/change`, { 内容: { メモ: "変更" } }); break;
      case "予約を取り消す":
        r = await post(`${P}/cancel`, { 取消料が発生する: conditions["取消料が発生する"], 取消料: 1000 }); break;
      case "チェックインを記録する":
        r = await post(`${P}/check-in`, { 早めのチェックインができる: conditions["早めのチェックインができる"] }); break;
      case "部屋の割り当てを記録する":
        r = await post(`${P}/assign-room`, { 部屋: roomId, 満室である: conditions["満室である"] }); break;
      case "追加料金を登録する": r = await post(`${P}/charges`, { 内容: "追加", 金額: 100 }); break;
      case "チェックアウトを記録する": r = await post(`${P}/check-out`); break;
      default: throw new Error(`知らない操作: ${operation}`);
    }

    // 保存されている状態を読む
    const out: Record<string, string> = {};
    out["予約の状態"] = (await call("GET", P)).body.状態;
    if (roomState !== undefined || roomForCheckout) out["部屋の状態"] = (await call("GET", `/rooms/${roomId}`)).body.状態;

    if (r.status === 409) return { outcome: "wrongState", states: out };
    const cond = Object.keys(conditions)[0];
    const 結果: string = r.body.結果;
    const alt = /取消料を請求に加えて|ロビーで待つ|空きが出るまで待つ/.test(結果);
    if (alt) return { outcome: "alternate", condition: cond, states: out };
    return { outcome: "done", states: out };
  },
};
export default driver;
