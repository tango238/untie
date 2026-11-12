import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";

let server: Server;
let base: string;
before(async () => {
  server = createApp();
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

async function req(method: string, path: string, body?: unknown, raw?: string) {
  const res = await fetch(base + path, {
    method, headers: { "content-type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, body: (await res.json()) as any };
}
const newRes = async () => (await req("POST", "/reservations", { guestName: "山田" })).body.id as string;
const confirmed = async () => { const id = await newRes(); await req("POST", `/reservations/${id}/confirm`); return id; };
const checkedIn = async () => {
  const id = await confirmed();
  await req("POST", `/reservations/${id}/check-in`, { earlyCheckInAllowed: true });
  return id;
};
const newRoom = async (status = "準備完了") => (await req("POST", "/rooms", { status })).body.id as string;
const status = async (id: string) => (await req("GET", `/reservations/${id}`)).body.status;

// ---- 予約を確定する
test("確定: 仮予約 → 確定", async () => {
  const id = await newRes();
  assert.equal(await status(id), "仮予約");
  const r = await req("POST", `/reservations/${id}/confirm`);
  assert.equal(r.status, 200);
  assert.equal(r.body.reservation.status, "確定");
  assert.equal(await status(id), "確定");
});
test("確定: 仮予約でないと 409、状態は変わらない", async () => {
  const id = await confirmed();
  const r = await req("POST", `/reservations/${id}/confirm`);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "wrong_state");
  assert.equal(r.body.required, "仮予約");
  assert.equal(await status(id), "確定");
});
test("確定: 無い予約は 404", async () => {
  assert.equal((await req("POST", "/reservations/nope/confirm")).status, 404);
});

// ---- 予約を変更する
test("変更: 確定 → 確定、内容が変わる", async () => {
  const id = await confirmed();
  const r = await req("PUT", `/reservations/${id}`, { details: { nights: 3 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.reservation.details, { nights: 3 });
  assert.equal(await status(id), "確定");
});
test("変更: 仮予約では 409", async () => {
  const id = await newRes();
  const r = await req("PUT", `/reservations/${id}`, { details: {} });
  assert.equal(r.status, 409);
  assert.equal(r.body.required, "確定");
});
test("変更: 無い予約は 404 / details が無いと 400", async () => {
  assert.equal((await req("PUT", "/reservations/nope", { details: {} })).status, 404);
  const id = await confirmed();
  assert.equal((await req("PUT", `/reservations/${id}`, {})).status, 400);
  assert.equal((await req("PUT", `/reservations/${id}`, { details: [] })).status, 400);
});

// ---- 予約を取り消す
test("取消: 取消料なし → 取消", async () => {
  const id = await confirmed();
  const r = await req("POST", `/reservations/${id}/cancel`, { cancellationFeeApplies: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "取消");
  assert.equal(r.body.changed, true);
  assert.equal(await status(id), "取消");
});
test("取消: 取消料が発生するときはモデルの分岐の答えを返し、状態は動かさない", async () => {
  const id = await confirmed();
  const r = await req("POST", `/reservations/${id}/cancel`, { cancellationFeeApplies: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "予約を取り消す_取消料が発生する");
  assert.equal(r.body.changed, false);
  assert.equal(await status(id), "確定");
});
test("取消: 確定でないと 409 / 取消済をもう一度は 409", async () => {
  const id = await newRes();
  assert.equal((await req("POST", `/reservations/${id}/cancel`, { cancellationFeeApplies: false })).status, 409);
  const c = await confirmed();
  await req("POST", `/reservations/${c}/cancel`, { cancellationFeeApplies: false });
  assert.equal((await req("POST", `/reservations/${c}/cancel`, { cancellationFeeApplies: false })).status, 409);
});
test("取消: 条件が無い・真偽値でないと 400 / 無い予約は 404", async () => {
  const id = await confirmed();
  assert.equal((await req("POST", `/reservations/${id}/cancel`, {})).status, 400);
  assert.equal((await req("POST", `/reservations/${id}/cancel`, { cancellationFeeApplies: "yes" })).status, 400);
  assert.equal((await req("POST", "/reservations/nope/cancel", { cancellationFeeApplies: false })).status, 404);
});

// ---- チェックイン
test("チェックイン: 早めでもよい → チェックイン済、宿泊客を保存", async () => {
  const id = await confirmed();
  const r = await req("POST", `/reservations/${id}/check-in`, { earlyCheckInAllowed: true, guest: { name: "山田太郎" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "チェックイン済");
  assert.deepEqual(r.body.reservation.guest, { name: "山田太郎" });
  assert.equal(await status(id), "チェックイン済");
});
test("チェックイン: 早めにはできない → ロビーで待つ分岐、状態は確定のまま", async () => {
  const id = await confirmed();
  const r = await req("POST", `/reservations/${id}/check-in`, { earlyCheckInAllowed: false, guest: { name: "x" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "チェックインを記録する_早めのチェックインができる_でない");
  assert.equal(r.body.changed, false);
  assert.equal(r.body.reservation.guest, null);
  assert.equal(await status(id), "確定");
});
test("チェックイン: 確定でないと 409 / 入力の誤りは 400 / 無い予約は 404", async () => {
  const id = await newRes();
  assert.equal((await req("POST", `/reservations/${id}/check-in`, { earlyCheckInAllowed: true })).status, 409);
  const c = await confirmed();
  assert.equal((await req("POST", `/reservations/${c}/check-in`, {})).status, 400);
  assert.equal((await req("POST", `/reservations/${c}/check-in`, { earlyCheckInAllowed: 1 })).status, 400);
  assert.equal((await req("POST", `/reservations/${c}/check-in`, { earlyCheckInAllowed: true, guest: "x" })).status, 400);
  assert.equal(await status(c), "確定");
  assert.equal((await req("POST", "/reservations/nope/check-in", { earlyCheckInAllowed: true })).status, 404);
});

// ---- 部屋の割り当て
test("部屋の割り当て: 準備完了 → 使用中、予約に部屋が付く", async () => {
  const id = await checkedIn();
  const room = await newRoom();
  const r = await req("POST", `/reservations/${id}/room-assignment`, { roomId: room, roomFull: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "使用中");
  assert.equal(r.body.room.status, "使用中");
  assert.equal(r.body.reservation.roomId, room);
  assert.equal((await req("GET", `/rooms/${room}`)).body.status, "使用中");
});
test("部屋の割り当て: 満室 → 割り当てず待ってもらう", async () => {
  const id = await checkedIn();
  const room = await newRoom();
  const r = await req("POST", `/reservations/${id}/room-assignment`, { roomId: room, roomFull: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "部屋の割り当てを記録する_満室である");
  assert.equal(r.body.changed, false);
  assert.equal((await req("GET", `/rooms/${room}`)).body.status, "準備完了");
  assert.equal(await (async () => (await req("GET", `/reservations/${id}`)).body.roomId)(), null);
});
test("部屋の割り当て: 準備完了でない部屋は 409", async () => {
  const id = await checkedIn();
  for (const s of ["清掃待ち", "清掃中", "使用中"]) {
    const room = await newRoom(s);
    const r = await req("POST", `/reservations/${id}/room-assignment`, { roomId: room, roomFull: false });
    assert.equal(r.status, 409);
    assert.equal(r.body.required, "準備完了");
  }
});
test("部屋の割り当て: 無い部屋・無い予約は 404、入力の誤りは 400", async () => {
  const id = await checkedIn();
  assert.equal((await req("POST", `/reservations/${id}/room-assignment`, { roomId: "nope", roomFull: false })).status, 404);
  assert.equal((await req("POST", `/reservations/nope/room-assignment`, { roomId: "x", roomFull: false })).status, 404);
  const room = await newRoom();
  assert.equal((await req("POST", `/reservations/${id}/room-assignment`, { roomFull: false })).status, 400);
  assert.equal((await req("POST", `/reservations/${id}/room-assignment`, { roomId: room })).status, 400);
});

// ---- 追加料金
test("追加料金: チェックイン済で登録できる (何度でも)", async () => {
  const id = await checkedIn();
  const r = await req("POST", `/reservations/${id}/charges`, { description: "ルームサービス", amount: 1500 });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "追加料金を登録する_完了");
  await req("POST", `/reservations/${id}/charges`, { description: "ミニバー", amount: 500 });
  const got = (await req("GET", `/reservations/${id}`)).body;
  assert.equal(got.charges.length, 2);
  assert.equal(got.status, "チェックイン済");
});
test("追加料金: チェックイン済でないと 409、料金は増えない", async () => {
  for (const id of [await newRes(), await confirmed()]) {
    const r = await req("POST", `/reservations/${id}/charges`, { description: "x", amount: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.required, "チェックイン済");
    assert.equal((await req("GET", `/reservations/${id}`)).body.charges.length, 0);
  }
});
test("追加料金: 入力の誤りは 400 / 無い予約は 404", async () => {
  const id = await checkedIn();
  assert.equal((await req("POST", `/reservations/${id}/charges`, { amount: 1 })).status, 400);
  assert.equal((await req("POST", `/reservations/${id}/charges`, { description: "x", amount: "1" })).status, 400);
  assert.equal((await req("POST", `/reservations/${id}/charges`, { description: "x" })).status, 400);
  assert.equal((await req("POST", "/reservations/nope/charges", { description: "x", amount: 1 })).status, 404);
});

// ---- チェックアウト
test("チェックアウト: チェックイン済 → チェックアウト済、部屋は清掃待ち", async () => {
  const id = await checkedIn();
  const room = await newRoom();
  await req("POST", `/reservations/${id}/room-assignment`, { roomId: room, roomFull: false });
  const r = await req("POST", `/reservations/${id}/check-out`);
  assert.equal(r.status, 200);
  assert.equal(r.body.reservation.status, "チェックアウト済");
  assert.equal(r.body.room.status, "清掃待ち");
  assert.equal((await req("GET", `/rooms/${room}`)).body.status, "清掃待ち");
});
test("チェックアウト: 部屋が未割り当てでも予約は進む", async () => {
  const id = await checkedIn();
  const r = await req("POST", `/reservations/${id}/check-out`);
  assert.equal(r.status, 200);
  assert.equal(await status(id), "チェックアウト済");
});
test("チェックアウト: チェックイン済でないと 409 / 二度目も 409 / 無い予約は 404", async () => {
  const id = await confirmed();
  const r = await req("POST", `/reservations/${id}/check-out`);
  assert.equal(r.status, 409);
  assert.equal(r.body.required, "チェックイン済");
  const c = await checkedIn();
  await req("POST", `/reservations/${c}/check-out`);
  assert.equal((await req("POST", `/reservations/${c}/check-out`)).status, 409);
  assert.equal((await req("POST", "/reservations/nope/check-out")).status, 404);
});

// ---- 通しの流れ
test("通し: 予約 → 確定 → 変更 → チェックイン → 割り当て → 追加料金 → チェックアウト", async () => {
  const id = await newRes();
  const room = await newRoom();
  assert.equal((await req("POST", `/reservations/${id}/confirm`)).status, 200);
  assert.equal((await req("PUT", `/reservations/${id}`, { details: { nights: 2 } })).status, 200);
  assert.equal((await req("POST", `/reservations/${id}/check-in`, { earlyCheckInAllowed: true })).status, 200);
  assert.equal((await req("POST", `/reservations/${id}/room-assignment`, { roomId: room, roomFull: false })).status, 200);
  assert.equal((await req("POST", `/reservations/${id}/charges`, { description: "x", amount: 100 })).status, 200);
  assert.equal((await req("POST", `/reservations/${id}/check-out`)).status, 200);
  assert.equal(await status(id), "チェックアウト済");
});

// ---- 用意・参照・入力
test("用意: 予約と部屋の作成・参照・一覧", async () => {
  const id = await newRes();
  assert.ok((await req("GET", "/reservations")).body.some((r: any) => r.id === id));
  assert.equal((await req("GET", "/reservations/nope")).status, 404);
  assert.equal((await req("GET", "/rooms/nope")).status, 404);
  assert.equal((await req("POST", "/reservations", {})).status, 400);
  assert.equal((await req("POST", "/rooms", { status: "壊れている" })).status, 400);
  assert.equal((await req("POST", "/rooms", { id: "dup", status: "清掃中" })).status, 201);
  assert.equal((await req("POST", "/rooms", { id: "dup", status: "清掃中" })).status, 409);
});
test("入力: 壊れた JSON は 400、知らない道は 404", async () => {
  const id = await confirmed();
  assert.equal((await req("POST", `/reservations/${id}/cancel`, undefined, "{oops")).status, 400);
  assert.equal((await req("POST", `/reservations/${id}/cancel`, undefined, "[1]")).status, 400);
  assert.equal((await req("GET", "/nothing")).status, 404);
  assert.equal((await req("POST", `/reservations/${id}/unknown`, {})).status, 404);
});
