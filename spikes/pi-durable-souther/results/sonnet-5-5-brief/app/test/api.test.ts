import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp } from "../src/app.ts";

const server = createApp();
let base = "";
before(async () => { await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(() => server.close());

async function call(method: string, path: string, body?: unknown, raw?: string) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: res.status, json: (await res.json()) as any };
}
const stay = { guest: { name: "山田" }, roomType: "ツイン", checkIn: "2030-02-01", checkOut: "2030-02-03" };
const mk = async (state: string, extra: object = {}) => (await call("POST", "/test-setup/reservations", { ...stay, state, ...extra })).json;
const mkRoom = async (state: string) => (await call("POST", "/rooms", { type: "ツイン", state })).json;
const get = async (id: string) => (await call("GET", `/reservations/${id}`)).json;

test("ふだんの流れ: 仮予約 → 確定 → 変更 → チェックイン → 部屋割り当て → 追加料金 → チェックアウト", async () => {
  const created = await call("POST", "/reservations", { ...stay, channel: "電話" });
  assert.equal(created.status, 201);
  assert.equal(created.json.state, "仮予約");
  const id = created.json.id;
  assert.equal((await call("POST", `/reservations/${id}/confirm`)).json.outcome, "done");
  assert.equal((await get(id)).state, "確定");
  const ch = await call("PUT", `/reservations/${id}`, { checkOut: "2030-02-04" });
  assert.equal(ch.status, 200);
  assert.equal((await get(id)).checkOut, "2030-02-04");
  const ci = await call("POST", `/reservations/${id}/check-in`, { earlyCheckInAllowed: true, guest: { name: "山田 太郎", phone: "090" } });
  assert.equal(ci.json.outcome, "done");
  assert.equal((await get(id)).guest.phone, "090");
  const room = await mkRoom("準備完了");
  const as = await call("POST", `/rooms/${room.id}/assign`, { reservationId: id, full: false });
  assert.equal(as.json.outcome, "done");
  assert.equal((await call("GET", `/rooms/${room.id}`)).json.state, "使用中");
  assert.equal((await get(id)).roomId, room.id);
  const fee = await call("POST", `/reservations/${id}/charges`, { description: "ミニバー", amount: 800 });
  assert.equal(fee.status, 201);
  assert.deepEqual((await get(id)).charges.map((c: any) => c.amount), [800]);
  const out = await call("POST", `/reservations/${id}/check-out`);
  assert.equal(out.json.outcome, "done");
  assert.equal((await get(id)).state, "チェックアウト済");
  assert.equal((await call("GET", `/rooms/${room.id}`)).json.state, "清掃待ち");
});

test("取消: 取消料なし / あり", async () => {
  const a = await mk("確定");
  const r1 = await call("POST", `/reservations/${a.id}/cancel`, { cancellationFee: false });
  assert.equal(r1.json.outcome, "done");
  assert.equal((await get(a.id)).state, "取消");
  assert.deepEqual((await get(a.id)).charges, []);
  const b = await mk("確定");
  const r2 = await call("POST", `/reservations/${b.id}/cancel`, { cancellationFee: true, cancellationFeeAmount: 3000 });
  assert.equal(r2.json.outcome, "alternate");
  assert.equal(r2.json.condition, "取消料が発生する");
  const got = await get(b.id);
  assert.equal(got.state, "取消");
  assert.deepEqual(got.charges, [{ kind: "取消料", description: "取消料", amount: 3000 }]);
});

test("チェックイン: 早めにできないとき状態は変わらない", async () => {
  const a = await mk("確定");
  const r = await call("POST", `/reservations/${a.id}/check-in`, { earlyCheckInAllowed: false, guest: { name: "別人" } });
  assert.equal(r.json.outcome, "alternate");
  assert.equal(r.json.condition, "早めのチェックインができる");
  const got = await get(a.id);
  assert.equal(got.state, "確定");
  assert.equal(got.guest.name, "山田");
});

test("部屋の割り当て: 満室のとき割り当てない", async () => {
  const a = await mk("チェックイン済");
  const room = await mkRoom("準備完了");
  const r = await call("POST", `/rooms/${room.id}/assign`, { reservationId: a.id, full: true });
  assert.equal(r.json.outcome, "alternate");
  assert.equal(r.json.condition, "満室である");
  assert.equal((await call("GET", `/rooms/${room.id}`)).json.state, "準備完了");
  assert.equal((await get(a.id)).roomId, null);
});

const resStates = ["仮予約", "確定", "チェックイン済", "チェックアウト済", "取消"];
const resOps: [string, string, string, (s: string) => unknown, string[]][] = [
  ["確定する", "POST", "confirm", () => undefined, ["仮予約"]],
  ["変更する", "PUT", "", () => ({ checkOut: "2030-03-01" }), ["確定"]],
  ["取り消す", "POST", "cancel", () => ({ cancellationFee: false }), ["確定"]],
  ["チェックイン", "POST", "check-in", () => ({ earlyCheckInAllowed: true }), ["確定"]],
  ["追加料金", "POST", "charges", () => ({ description: "x", amount: 1 }), ["チェックイン済"]],
  ["チェックアウト", "POST", "check-out", () => undefined, ["チェックイン済"]],
];
for (const [name, method, act, body, ok] of resOps) {
  for (const s of resStates.filter((s) => !ok.includes(s))) {
    test(`前提の状態が違う: ${name} は ${s} では行えない (409・状態は変わらない)`, async () => {
      const r = await mk(s);
      const res = await call(method, `/reservations/${r.id}${act ? "/" + act : ""}`, body(s));
      assert.equal(res.status, 409);
      assert.equal(res.json.outcome, "wrongState");
      const got = await get(r.id);
      assert.equal(got.state, s);
      assert.deepEqual(got.charges, []);
    });
  }
}

test("前提の状態が違う: 部屋は 準備完了 以外では割り当てられない", async () => {
  const a = await mk("確定");
  for (const s of ["清掃待ち", "清掃中", "使用中"]) {
    const room = await mkRoom(s);
    const r = await call("POST", `/rooms/${room.id}/assign`, { reservationId: a.id, full: false });
    assert.equal(r.status, 409);
    assert.equal(r.json.outcome, "wrongState");
    assert.equal((await call("GET", `/rooms/${room.id}`)).json.state, s);
  }
});

test("チェックアウトで部屋が 清掃待ち になる (割り当て済みの部屋)", async () => {
  const room = await mkRoom("使用中");
  const a = await mk("チェックイン済", { roomId: room.id });
  await call("POST", `/reservations/${a.id}/check-out`);
  assert.equal((await call("GET", `/rooms/${room.id}`)).json.state, "清掃待ち");
});

test("無い予約・無い部屋は 404", async () => {
  for (const [m, p, b] of [
    ["GET", "/reservations/nope", undefined], ["POST", "/reservations/nope/confirm", undefined],
    ["PUT", "/reservations/nope", { checkOut: "2030-01-01" }], ["POST", "/reservations/nope/cancel", { cancellationFee: false }],
    ["POST", "/reservations/nope/check-in", { earlyCheckInAllowed: true }], ["POST", "/reservations/nope/charges", { description: "x", amount: 1 }],
    ["POST", "/reservations/nope/check-out", undefined], ["GET", "/rooms/nope", undefined],
    ["POST", "/rooms/nope/assign", { reservationId: "nope", full: false }],
  ] as const) {
    const r = await call(m, p, b);
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.equal(r.json.error.type, "notFound");
  }
  const room = await mkRoom("準備完了");
  assert.equal((await call("POST", `/rooms/${room.id}/assign`, { reservationId: "nope", full: false })).status, 404);
  assert.equal((await call("GET", "/unknown")).status, 404);
});

test("入力の誤り (400)", async () => {
  const a = await mk("確定");
  const cases: [string, string, unknown?, string?][] = [
    ["POST", "/reservations", { ...stay, roomType: "宮殿" }],
    ["POST", "/reservations", { ...stay, checkIn: "明日" }],
    ["POST", "/reservations", { roomType: "ツイン", checkIn: "2030-01-01", checkOut: "2030-01-02" }],
    ["POST", "/reservations", undefined, "{ broken"],
    ["POST", "/reservations", [1]],
    ["POST", "/rooms", { type: "ツイン", state: "空室" }],
    ["POST", "/rooms", { state: "準備完了" }],
    ["POST", "/test-setup/reservations", { ...stay, state: "なぞ" }],
    ["PUT", `/reservations/${a.id}`, {}],
    ["PUT", `/reservations/${a.id}`, { checkIn: "2030/01/01" }],
    ["POST", `/reservations/${a.id}/cancel`, {}],
    ["POST", `/reservations/${a.id}/cancel`, { cancellationFee: "yes" }],
    ["POST", `/reservations/${a.id}/check-in`, {}],
    ["POST", `/reservations/${a.id}/check-in`, { earlyCheckInAllowed: true, guest: { } }],
    ["POST", `/reservations/${a.id}/charges`, { description: "x", amount: "100" }],
    ["POST", `/reservations/${a.id}/charges`, { amount: 100 }],
  ];
  for (const [m, p, b, raw] of cases) {
    const r = await call(m, p, b, raw);
    assert.equal(r.status, 400, `${m} ${p} ${JSON.stringify(b ?? raw)}`);
    assert.equal(r.json.error.type, "input");
  }
  const room = await mkRoom("準備完了");
  assert.equal((await call("POST", `/rooms/${room.id}/assign`, { reservationId: a.id })).status, 400);
  assert.equal((await call("POST", `/rooms/${room.id}/assign`, { full: false })).status, 400);
  // 入力が誤りのときは何も変えない
  assert.equal((await get(a.id)).state, "確定");
});

test("一覧", async () => {
  assert.ok((await call("GET", "/reservations")).json.length > 0);
  assert.ok((await call("GET", "/rooms")).json.length > 0);
});
