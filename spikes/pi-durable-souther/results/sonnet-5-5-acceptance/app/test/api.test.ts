import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/server.ts";

let server: Server;
let base: string;
before(async () => {
  server = createApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(method: string, path: string, body?: unknown, raw?: string) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: res.status, json: (await res.json()) as any };
}
const mkRes = async (state: string, roomId?: string) => (await call("POST", "/dev/reservations", { state, roomId })).json.reservation.id as string;
const mkRoom = async (state: string) => (await call("POST", "/dev/rooms", { state })).json.room.id as string;
const resState = async (id: string) => (await call("GET", `/reservations/${id}`)).json.reservation.state;

const states = ["仮予約", "確定", "チェックイン済", "チェックアウト済", "取消"];
/** 前提でない状態では 409 wrongState で、状態は変わらない */
async function wrongFor(ok: string, path: string, body?: unknown) {
  for (const s of states.filter((x) => x !== ok)) {
    const id = await mkRes(s);
    const r = await call("POST", `/reservations/${id}/${path}`, body);
    assert.equal(r.status, 409, s);
    assert.equal(r.json.outcome, "wrongState");
    assert.equal(await resState(id), s);
  }
}

describe("予約を確定する", () => {
  test("仮予約 → 確定", async () => {
    const id = await mkRes("仮予約");
    const r = await call("POST", `/reservations/${id}/confirm`);
    assert.equal(r.status, 200);
    assert.equal(r.json.outcome, "done");
    assert.equal(await resState(id), "確定");
  });
  test("状態が違う", () => wrongFor("仮予約", "confirm"));
  test("無い予約は 404", async () => assert.equal((await call("POST", "/reservations/nope/confirm")).status, 404));
});

describe("予約を変更する", () => {
  test("確定 → 確定、内容が保存される", async () => {
    const id = await mkRes("確定");
    const r = await call("POST", `/reservations/${id}/change`, { roomType: "ツイン", checkInDate: "2025-01-02" });
    assert.equal(r.status, 200);
    const g = (await call("GET", `/reservations/${id}`)).json.reservation;
    assert.equal(g.state, "確定");
    assert.equal(g.details.roomType, "ツイン");
  });
  test("状態が違う (内容は変わらない)", async () => {
    await wrongFor("確定", "change", { roomType: "ツイン" });
    const id = await mkRes("仮予約");
    await call("POST", `/reservations/${id}/change`, { roomType: "ツイン" });
    assert.deepEqual((await call("GET", `/reservations/${id}`)).json.reservation.details, {});
  });
  test("入力の誤り: 空 / 型違い / JSON でない", async () => {
    const id = await mkRes("確定");
    assert.equal((await call("POST", `/reservations/${id}/change`, {})).status, 400);
    assert.equal((await call("POST", `/reservations/${id}/change`, { roomType: 3 })).status, 400);
    assert.equal((await call("POST", `/reservations/${id}/change`, undefined, "{x")).status, 400);
  });
  test("無い予約は 404", async () => assert.equal((await call("POST", "/reservations/nope/change", { roomType: "a" })).status, 404));
});

describe("予約を取り消す", () => {
  test("取消料なし: 取消", async () => {
    const id = await mkRes("確定");
    const r = await call("POST", `/reservations/${id}/cancel`, { cancellationFeeApplies: false });
    assert.equal(r.json.outcome, "done");
    assert.equal(await resState(id), "取消");
  });
  test("取消料あり: 請求に加えて取消", async () => {
    const id = await mkRes("確定");
    const r = await call("POST", `/reservations/${id}/cancel`, { cancellationFeeApplies: true, cancellationFee: 3000 });
    assert.equal(r.json.outcome, "alternate");
    assert.equal(r.json.condition, "取消料が発生する");
    const g = (await call("GET", `/reservations/${id}`)).json.reservation;
    assert.equal(g.state, "取消");
    assert.deepEqual(g.charges, [{ description: "取消料", amount: 3000 }]);
  });
  test("状態が違う", async () => {
    await wrongFor("確定", "cancel", { cancellationFeeApplies: false });
    await wrongFor("確定", "cancel", { cancellationFeeApplies: true });
  });
  test("入力の誤り", async () => {
    const id = await mkRes("確定");
    assert.equal((await call("POST", `/reservations/${id}/cancel`, {})).status, 400);
    assert.equal((await call("POST", `/reservations/${id}/cancel`, { cancellationFeeApplies: "yes" })).status, 400);
    assert.equal((await call("POST", `/reservations/${id}/cancel`, { cancellationFeeApplies: true, cancellationFee: -1 })).status, 400);
    assert.equal(await resState(id), "確定");
  });
  test("無い予約は 404", async () => assert.equal((await call("POST", "/reservations/nope/cancel", { cancellationFeeApplies: false })).status, 404));
});

describe("チェックインを記録する", () => {
  test("早めでよい: チェックイン済、宿泊客が保存される", async () => {
    const id = await mkRes("確定");
    const r = await call("POST", `/reservations/${id}/check-in`, { earlyCheckInAllowed: true, guestName: "山田" });
    assert.equal(r.json.outcome, "done");
    const g = (await call("GET", `/reservations/${id}`)).json.reservation;
    assert.equal(g.state, "チェックイン済");
    assert.equal(g.guestName, "山田");
  });
  test("早めでない: ロビーで待つ、状態は変わらない", async () => {
    const id = await mkRes("確定");
    const r = await call("POST", `/reservations/${id}/check-in`, { earlyCheckInAllowed: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.outcome, "alternate");
    assert.equal(r.json.condition, "早めのチェックインができる");
    assert.equal(await resState(id), "確定");
  });
  test("状態が違う", () => wrongFor("確定", "check-in", { earlyCheckInAllowed: true }));
  test("入力の誤り", async () => {
    const id = await mkRes("確定");
    assert.equal((await call("POST", `/reservations/${id}/check-in`, {})).status, 400);
    assert.equal((await call("POST", `/reservations/${id}/check-in`, { earlyCheckInAllowed: true, guestName: "" })).status, 400);
  });
  test("無い予約は 404", async () => assert.equal((await call("POST", "/reservations/nope/check-in", { earlyCheckInAllowed: true })).status, 404));
});

describe("部屋の割り当てを記録する", () => {
  test("準備完了 → 使用中、予約に結びつく", async () => {
    const room = await mkRoom("準備完了");
    const id = await mkRes("チェックイン済");
    const r = await call("POST", `/rooms/${room}/assign`, { fullHouse: false, reservationId: id });
    assert.equal(r.json.outcome, "done");
    assert.equal((await call("GET", `/rooms/${room}`)).json.room.state, "使用中");
    assert.equal((await call("GET", `/reservations/${id}`)).json.reservation.roomId, room);
  });
  test("満室: 割り当てない", async () => {
    const room = await mkRoom("準備完了");
    const r = await call("POST", `/rooms/${room}/assign`, { fullHouse: true });
    assert.equal(r.json.outcome, "alternate");
    assert.equal(r.json.condition, "満室である");
    assert.equal((await call("GET", `/rooms/${room}`)).json.room.state, "準備完了");
  });
  test("状態が違う", async () => {
    for (const s of ["清掃待ち", "清掃中", "使用中"]) {
      const room = await mkRoom(s);
      const r = await call("POST", `/rooms/${room}/assign`, { fullHouse: false });
      assert.equal(r.status, 409);
      assert.equal(r.json.outcome, "wrongState");
      assert.equal((await call("GET", `/rooms/${room}`)).json.room.state, s);
    }
  });
  test("入力の誤り・無い部屋・無い予約", async () => {
    const room = await mkRoom("準備完了");
    assert.equal((await call("POST", `/rooms/${room}/assign`, {})).status, 400);
    assert.equal((await call("POST", `/rooms/nope/assign`, { fullHouse: false })).status, 404);
    assert.equal((await call("POST", `/rooms/${room}/assign`, { fullHouse: false, reservationId: "nope" })).status, 404);
    assert.equal((await call("GET", `/rooms/${room}`)).json.room.state, "準備完了");
  });
});

describe("追加料金を登録する", () => {
  test("チェックイン済: 請求に加わる", async () => {
    const id = await mkRes("チェックイン済");
    assert.equal((await call("POST", `/reservations/${id}/charges`, { description: "ルームサービス", amount: 1200 })).json.outcome, "done");
    await call("POST", `/reservations/${id}/charges`, { description: "ミニバー", amount: 300 });
    const g = (await call("GET", `/reservations/${id}`)).json.reservation;
    assert.equal(g.state, "チェックイン済");
    assert.equal(g.charges.length, 2);
  });
  test("状態が違う (請求は増えない)", async () => {
    await wrongFor("チェックイン済", "charges", { description: "x", amount: 1 });
    const id = await mkRes("確定");
    await call("POST", `/reservations/${id}/charges`, { description: "x", amount: 1 });
    assert.equal((await call("GET", `/reservations/${id}`)).json.reservation.charges.length, 0);
  });
  test("入力の誤り", async () => {
    const id = await mkRes("チェックイン済");
    for (const b of [{}, { description: "x" }, { description: "x", amount: "1" }, { description: "x", amount: -5 }, { amount: 5 }])
      assert.equal((await call("POST", `/reservations/${id}/charges`, b)).status, 400);
  });
  test("無い予約は 404", async () => assert.equal((await call("POST", "/reservations/nope/charges", { description: "x", amount: 1 })).status, 404));
});

describe("チェックアウトを記録する", () => {
  test("チェックアウト済・部屋は清掃待ち", async () => {
    const room = await mkRoom("使用中");
    const id = await mkRes("チェックイン済", room);
    const r = await call("POST", `/reservations/${id}/check-out`);
    assert.equal(r.json.outcome, "done");
    assert.equal(await resState(id), "チェックアウト済");
    assert.equal((await call("GET", `/rooms/${room}`)).json.room.state, "清掃待ち");
  });
  test("状態が違う (部屋も変わらない)", async () => {
    const room = await mkRoom("使用中");
    for (const s of states.filter((x) => x !== "チェックイン済")) {
      const id = await mkRes(s, room);
      assert.equal((await call("POST", `/reservations/${id}/check-out`)).status, 409);
      assert.equal(await resState(id), s);
    }
    assert.equal((await call("GET", `/rooms/${room}`)).json.room.state, "使用中");
  });
  test("無い予約は 404", async () => assert.equal((await call("POST", "/reservations/nope/check-out")).status, 404));
});

describe("その他", () => {
  test("通しの流れ", async () => {
    const id = await mkRes("仮予約");
    const room = await mkRoom("準備完了");
    await call("POST", `/reservations/${id}/confirm`);
    await call("POST", `/reservations/${id}/check-in`, { earlyCheckInAllowed: true });
    await call("POST", `/rooms/${room}/assign`, { fullHouse: false, reservationId: id });
    await call("POST", `/reservations/${id}/charges`, { description: "x", amount: 1 });
    await call("POST", `/reservations/${id}/check-out`);
    assert.equal(await resState(id), "チェックアウト済");
    assert.equal((await call("GET", `/rooms/${room}`)).json.room.state, "清掃待ち");
  });
  test("dev: 不正な状態名は 400", async () => {
    assert.equal((await call("POST", "/dev/reservations", { state: "謎" })).status, 400);
    assert.equal((await call("POST", "/dev/rooms", { state: "謎" })).status, 400);
    assert.equal((await call("POST", "/dev/reservations", { roomId: "nope" })).status, 404);
  });
  test("未知の経路は 404、無い予約の GET も 404", async () => {
    assert.equal((await call("GET", "/nothing")).status, 404);
    assert.equal((await call("GET", "/reservations/nope")).status, 404);
    assert.equal((await call("POST", "/reservations/x/unknown")).status, 404);
  });
});
