import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.ts";

const server = createApp();
let base = "";
before(async () => { await new Promise<void>((r) => server.listen(0, r)); base = `http://localhost:${(server.address() as AddressInfo).port}`; });
after(() => server.close());

async function call(method: string, path: string, body?: unknown, raw?: string) {
  const res = await fetch(base + path, { method, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: res.status, body: (await res.json()) as any };
}
const post = (p: string, b?: unknown) => call("POST", p, b);
let rn = 0;
const newRoom = async (状態 = "準備完了") => { const id = `K${++rn}`; await post("/rooms", { id, 状態 }); return id; };
async function reservation(upTo: "仮予約" | "確定" | "チェックイン済" = "仮予約") {
  const r = await post("/reservations", { 宿泊客: { 名前: "山田" }, 内容: { 部屋タイプ: "ツイン" } });
  const id = r.body.id as string;
  if (upTo !== "仮予約") await post(`/reservations/${id}/confirm`);
  if (upTo === "チェックイン済") await post(`/reservations/${id}/check-in`, { 早めのチェックインができる: true });
  return id;
}
const stateOf = async (id: string) => (await call("GET", `/reservations/${id}`)).body.状態;

// 予約を、ある状態に置く (全状態を作る)
async function inState(s: string) {
  switch (s) {
    case "仮予約": return reservation();
    case "確定": return reservation("確定");
    case "チェックイン済": return reservation("チェックイン済");
    case "チェックアウト済": { const id = await reservation("チェックイン済"); await post(`/reservations/${id}/check-out`); return id; }
    case "取消": { const id = await reservation("確定"); await post(`/reservations/${id}/cancel`, { 取消料が発生する: false }); return id; }
  }
  throw new Error(s);
}
const ALL = ["仮予約", "確定", "チェックイン済", "チェックアウト済", "取消"];

test("予約を登録すると仮予約になる", async () => {
  const r = await post("/reservations", { 宿泊客: { 名前: "山田" } });
  assert.equal(r.status, 201); assert.equal(r.body.状態, "仮予約");
  assert.equal((await call("GET", "/reservations")).body.length > 0, true);
});

test("予約を確定する: ふだんの流れ", async () => {
  const id = await reservation();
  const r = await post(`/reservations/${id}/confirm`);
  assert.equal(r.status, 200); assert.equal(r.body.予約.状態, "確定");
  assert.equal(await stateOf(id), "確定");
});
for (const s of ALL.filter((s) => s !== "仮予約")) test(`予約を確定する: ${s} では行えない`, async () => {
  const id = await inState(s);
  const r = await post(`/reservations/${id}/confirm`);
  assert.equal(r.status, 409); assert.equal(await stateOf(id), s);
});

test("予約を変更する: ふだんの流れ (内容が変わり、状態は確定のまま)", async () => {
  const id = await reservation("確定");
  const r = await post(`/reservations/${id}/change`, { 内容: { 部屋タイプ: "シングル" } });
  assert.equal(r.status, 200); assert.equal(r.body.予約.内容.部屋タイプ, "シングル"); assert.equal(r.body.予約.状態, "確定");
});
for (const s of ALL.filter((s) => s !== "確定")) test(`予約を変更する: ${s} では行えない`, async () => {
  const id = await inState(s);
  const before = (await call("GET", `/reservations/${id}`)).body;
  const r = await post(`/reservations/${id}/change`, { 内容: { 部屋タイプ: "X" } });
  assert.equal(r.status, 409);
  assert.deepEqual((await call("GET", `/reservations/${id}`)).body, before);
});

test("予約を取り消す: ふだんの流れ", async () => {
  const id = await reservation("確定");
  const r = await post(`/reservations/${id}/cancel`, { 取消料が発生する: false });
  assert.equal(r.status, 200); assert.equal(r.body.予約.状態, "取消"); assert.deepEqual(r.body.予約.請求, []);
});
test("予約を取り消す: 取消料が発生する → 請求に加えて取消", async () => {
  const id = await reservation("確定");
  const r = await post(`/reservations/${id}/cancel`, { 取消料が発生する: true, 取消料: 5000 });
  assert.equal(r.status, 200); assert.equal(r.body.予約.状態, "取消");
  assert.deepEqual(r.body.予約.請求, [{ 内容: "取消料", 金額: 5000, 種別: "取消料" }]);
});
for (const s of ALL.filter((s) => s !== "確定")) test(`予約を取り消す: ${s} では行えない`, async () => {
  const id = await inState(s);
  const r = await post(`/reservations/${id}/cancel`, { 取消料が発生する: true, 取消料: 100 });
  assert.equal(r.status, 409); assert.equal(await stateOf(id), s);
  assert.equal((await call("GET", `/reservations/${id}`)).body.請求.length, 0);
});
test("予約を取り消す: 入力の誤り", async () => {
  const id = await reservation("確定");
  assert.equal((await post(`/reservations/${id}/cancel`, {})).status, 400);
  assert.equal((await post(`/reservations/${id}/cancel`, { 取消料が発生する: "yes" })).status, 400);
  assert.equal((await post(`/reservations/${id}/cancel`, { 取消料が発生する: true })).status, 400);
  assert.equal((await post(`/reservations/${id}/cancel`, { 取消料が発生する: true, 取消料: -1 })).status, 400);
  assert.equal(await stateOf(id), "確定");
});

test("チェックインを記録する: ふだんの流れ (宿泊客を保存)", async () => {
  const id = await reservation("確定");
  const r = await post(`/reservations/${id}/check-in`, { 早めのチェックインができる: true, 宿泊客: { 住所: "東京" } });
  assert.equal(r.status, 200); assert.equal(r.body.予約.状態, "チェックイン済");
  assert.deepEqual(r.body.予約.宿泊客, { 名前: "山田", 住所: "東京" });
});
test("チェックインを記録する: 早めのチェックインができない → ロビーで待つ、状態は変えない", async () => {
  const id = await reservation("確定");
  const r = await post(`/reservations/${id}/check-in`, { 早めのチェックインができる: false, 宿泊客: { 住所: "東京" } });
  assert.equal(r.status, 200); assert.match(r.body.結果, /ロビー/);
  assert.equal(await stateOf(id), "確定");
  assert.deepEqual((await call("GET", `/reservations/${id}`)).body.宿泊客, { 名前: "山田" });
});
for (const s of ALL.filter((s) => s !== "確定")) test(`チェックインを記録する: ${s} では行えない`, async () => {
  const id = await inState(s);
  const r = await post(`/reservations/${id}/check-in`, { 早めのチェックインができる: true });
  assert.equal(r.status, 409); assert.equal(await stateOf(id), s);
});
test("チェックインを記録する: 入力の誤り", async () => {
  const id = await reservation("確定");
  assert.equal((await post(`/reservations/${id}/check-in`, {})).status, 400);
  assert.equal((await post(`/reservations/${id}/check-in`, { 早めのチェックインができる: true, 宿泊客: "x" })).status, 400);
});

test("部屋の割り当てを記録する: ふだんの流れ", async () => {
  const id = await reservation("チェックイン済"); const room = await newRoom();
  const r = await post(`/reservations/${id}/assign-room`, { 部屋: room, 満室である: false });
  assert.equal(r.status, 200); assert.equal(r.body.部屋.状態, "使用中"); assert.equal(r.body.予約.部屋, room);
  assert.equal((await call("GET", `/rooms/${room}`)).body.状態, "使用中");
});
test("部屋の割り当てを記録する: 満室である → 割り当てず待つ", async () => {
  const id = await reservation("チェックイン済"); const room = await newRoom();
  const r = await post(`/reservations/${id}/assign-room`, { 部屋: room, 満室である: true });
  assert.equal(r.status, 200); assert.match(r.body.結果, /待つ/);
  assert.equal((await call("GET", `/rooms/${room}`)).body.状態, "準備完了");
  assert.equal(r.body.予約.部屋, undefined);
});
for (const s of ["清掃待ち", "清掃中", "使用中"]) test(`部屋の割り当てを記録する: 部屋が${s}では行えない`, async () => {
  const id = await reservation("チェックイン済"); const room = await newRoom(s);
  const r = await post(`/reservations/${id}/assign-room`, { 部屋: room, 満室である: false });
  assert.equal(r.status, 409);
  assert.equal((await call("GET", `/rooms/${room}`)).body.状態, s);
  assert.equal((await call("GET", `/reservations/${id}`)).body.部屋, undefined);
});
test("部屋の割り当てを記録する: 無い部屋・入力の誤り", async () => {
  const id = await reservation("チェックイン済");
  assert.equal((await post(`/reservations/${id}/assign-room`, { 部屋: "nai", 満室である: false })).status, 404);
  assert.equal((await post(`/reservations/${id}/assign-room`, { 満室である: false })).status, 400);
  const room = await newRoom();
  assert.equal((await post(`/reservations/${id}/assign-room`, { 部屋: room })).status, 400);
});

test("追加料金を登録する: ふだんの流れ (複数回、状態は変わらない)", async () => {
  const id = await reservation("チェックイン済");
  assert.equal((await post(`/reservations/${id}/charges`, { 内容: "ルームサービス", 金額: 3000 })).status, 200);
  const r = await post(`/reservations/${id}/charges`, { 内容: "ミニバー", 金額: 500 });
  assert.equal(r.body.予約.請求.length, 2); assert.equal(r.body.予約.状態, "チェックイン済");
});
for (const s of ALL.filter((s) => s !== "チェックイン済")) test(`追加料金を登録する: ${s} では行えない`, async () => {
  const id = await inState(s);
  const n = (await call("GET", `/reservations/${id}`)).body.請求.length;
  const r = await post(`/reservations/${id}/charges`, { 内容: "x", 金額: 1 });
  assert.equal(r.status, 409);
  assert.equal((await call("GET", `/reservations/${id}`)).body.請求.length, n);
});
test("追加料金を登録する: 入力の誤り", async () => {
  const id = await reservation("チェックイン済");
  assert.equal((await post(`/reservations/${id}/charges`, { 内容: "x", 金額: "100" })).status, 400);
  assert.equal((await post(`/reservations/${id}/charges`, { 内容: "x", 金額: 1.5 })).status, 400);
  assert.equal((await post(`/reservations/${id}/charges`, { 金額: 1 })).status, 400);
});

test("チェックアウトを記録する: ふだんの流れ (予約はチェックアウト済、部屋は清掃待ち)", async () => {
  const id = await reservation("チェックイン済"); const room = await newRoom();
  await post(`/reservations/${id}/assign-room`, { 部屋: room, 満室である: false });
  const r = await post(`/reservations/${id}/check-out`);
  assert.equal(r.status, 200); assert.equal(r.body.予約.状態, "チェックアウト済"); assert.equal(r.body.部屋.状態, "清掃待ち");
  assert.equal((await call("GET", `/rooms/${room}`)).body.状態, "清掃待ち");
});
test("チェックアウトを記録する: 部屋が未割り当てでも予約は進む", async () => {
  const id = await reservation("チェックイン済");
  const r = await post(`/reservations/${id}/check-out`);
  assert.equal(r.status, 200); assert.equal(r.body.部屋, null);
});
for (const s of ALL.filter((s) => s !== "チェックイン済")) test(`チェックアウトを記録する: ${s} では行えない`, async () => {
  const id = await inState(s);
  const r = await post(`/reservations/${id}/check-out`);
  assert.equal(r.status, 409); assert.equal(await stateOf(id), s);
});

test("全体の流れ: 登録→確定→チェックイン→割当→追加料金→チェックアウト", async () => {
  const id = await reservation(); const room = await newRoom();
  for (const [p, b] of [["confirm", {}], ["check-in", { 早めのチェックインができる: true }], ["assign-room", { 部屋: room, 満室である: false }],
    ["charges", { 内容: "朝食", 金額: 1200 }], ["check-out", {}]] as const)
    assert.equal((await post(`/reservations/${id}/${p}`, b)).status, 200, p);
  assert.equal(await stateOf(id), "チェックアウト済");
});

test("無い予約・経路・入力の誤り", async () => {
  for (const op of ["confirm", "change", "cancel", "check-in", "assign-room", "charges", "check-out"])
    assert.equal((await post(`/reservations/nai/${op}`, { 内容: {}, 取消料が発生する: false })).status, 404, op);
  assert.equal((await call("GET", "/reservations/nai")).status, 404);
  assert.equal((await call("GET", "/rooms/nai")).status, 404);
  assert.equal((await call("GET", "/nothing")).status, 404);
  assert.equal((await post("/reservations", {})).status, 400);
  assert.equal((await call("POST", "/reservations", undefined, "{bad")).status, 400);
  assert.equal((await call("POST", "/reservations", undefined, "[1]")).status, 400);
  const id = await reservation("確定");
  assert.equal((await post(`/reservations/${id}/change`, {})).status, 400);
  assert.equal((await post(`/reservations/${id}/unknown`)).status, 404);
});
test("部屋を用意する: 入力の誤りと重複", async () => {
  assert.equal((await post("/rooms", { id: "A1", 状態: "準備完了" })).status, 201);
  assert.equal((await post("/rooms", { id: "A1", 状態: "準備完了" })).status, 409);
  assert.equal((await post("/rooms", { id: "A2", 状態: "ほげ" })).status, 400);
  assert.equal((await post("/rooms", { 状態: "準備完了" })).status, 400);
});
