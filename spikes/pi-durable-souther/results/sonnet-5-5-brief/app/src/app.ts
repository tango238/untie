import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { answer, reservationStates, roomStates, rules, type ReservationState, type RoomState } from "./model.ts";
import { Store, type Reservation, type Room } from "./store.ts";

const ROOM_TYPES = ["シングル", "ツイン", "スイート"];
const CHANNELS = ["電話", "予約サイト", "直接来館"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  status: number; body: Record<string, unknown>;
  constructor(status: number, kind: string, message: string, extra: Record<string, unknown> = {}) {
    super(message); this.status = status; this.body = { error: { type: kind, message, ...extra } };
  }
}
const bad = (msg: string, field?: string) => new HttpError(400, "input", msg, field ? { field } : {});
const notFound = (what: string, id: string) => new HttpError(404, "notFound", `${what}「${id}」が無い`);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(b: Obj, k: string, required: boolean, allowed?: string[], pattern?: RegExp): string | undefined {
  const v = b[k];
  if (v === undefined || v === null) { if (required) throw bad(`${k} が要る`, k); return undefined; }
  if (typeof v !== "string" || v === "") throw bad(`${k} は空でない文字列`, k);
  if (allowed && !allowed.includes(v)) throw bad(`${k} は ${allowed.join("・")} のどれか`, k);
  if (pattern && !pattern.test(v)) throw bad(`${k} は YYYY-MM-DD`, k);
  return v;
}
function bool(b: Obj, k: string): boolean {
  if (typeof b[k] !== "boolean") throw bad(`${k} は true / false で渡す`, k);
  return b[k] as boolean;
}
function guestOf(b: Obj, required: boolean): { name: string; [k: string]: unknown } | undefined {
  const g = b.guest;
  if (g === undefined || g === null) { if (required) throw bad("guest が要る", "guest"); return undefined; }
  if (!isObj(g) || typeof g.name !== "string" || g.name === "") throw bad("guest は { name } を持つ", "guest");
  return g as { name: string };
}

export function createApp(store = new Store()): Server {
  const reservation = (id: string): Reservation => store.reservations.get(id) ?? (() => { throw notFound("予約", id); })();
  const room = (id: string): Room => store.rooms.get(id) ?? (() => { throw notFound("部屋", id); })();

  function newReservation(b: Obj, state: ReservationState): Reservation {
    const r: Reservation = {
      id: store.nextId("R"), state, guest: guestOf(b, true)!,
      roomType: str(b, "roomType", true, ROOM_TYPES)!,
      checkIn: str(b, "checkIn", true, undefined, DATE)!, checkOut: str(b, "checkOut", true, undefined, DATE)!,
      channel: str(b, "channel", false, CHANNELS) ?? null, roomId: null, charges: [],
    };
    if (b.roomId !== undefined && b.roomId !== null) { r.roomId = room(String(b.roomId)).id; }
    store.reservations.set(r.id, r);
    return r;
  }

  const wrong = (res: Reservation | Room) => ({ status: 409, body: { outcome: "wrongState", state: res.state } });

  async function route(method: string, path: string, body: Obj): Promise<{ status: number; body: unknown }> {
    const seg = path.split("/").filter(Boolean).map(decodeURIComponent);
    const [a, id, act] = seg;

    if (a === "reservations" && seg.length === 1) {
      if (method === "POST") return { status: 201, body: newReservation(body, "仮予約") }; // 予約サイトが作る想定の仮予約
      if (method === "GET") return { status: 200, body: [...store.reservations.values()] };
    }
    if (a === "rooms" && seg.length === 1) {
      if (method === "POST") {
        const state = str(body, "state", true, roomStates)! as RoomState;
        const r: Room = { id: store.nextId("room"), type: str(body, "type", true, ROOM_TYPES)!, state };
        store.rooms.set(r.id, r);
        return { status: 201, body: r };
      }
      if (method === "GET") return { status: 200, body: [...store.rooms.values()] };
    }
    // 確かめるための操作: 前提の状態を指定して予約を用意する
    if (a === "test-setup" && id === "reservations" && method === "POST") {
      const state = str(body, "state", true, reservationStates)! as ReservationState;
      return { status: 201, body: newReservation(body, state) };
    }
    if (a === "reservations" && id !== undefined) {
      if (seg.length === 2 && method === "GET") return { status: 200, body: reservation(id) };
      if (seg.length === 2 && method === "PUT") {
        const r = reservation(id);
        const patch = {
          guest: guestOf(body, false), roomType: str(body, "roomType", false, ROOM_TYPES),
          checkIn: str(body, "checkIn", false, undefined, DATE), checkOut: str(body, "checkOut", false, undefined, DATE),
          channel: str(body, "channel", false, CHANNELS),
        };
        if (Object.values(patch).every((v) => v === undefined)) throw bad("変える項目が無い");
        const res = answer(rules.予約を変更する(r.state));
        if (res !== "確定") return wrong(r);
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) (r as unknown as Obj)[k] = v;
        r.state = "確定";
        return { status: 200, body: { outcome: "done", reservation: r } };
      }
      if (seg.length === 3 && method === "POST") {
        const r = reservation(id);
        switch (act) {
          case "confirm": {
            if (answer(rules.予約を確定する(r.state)) !== "確定") return wrong(r);
            r.state = "確定";
            return { status: 200, body: { outcome: "done", reservation: r } };
          }
          case "cancel": {
            const fee = bool(body, "cancellationFee");
            let amount: number | null = null;
            if (body.cancellationFeeAmount !== undefined) {
              if (typeof body.cancellationFeeAmount !== "number" || !Number.isInteger(body.cancellationFeeAmount)) throw bad("cancellationFeeAmount は整数", "cancellationFeeAmount");
              amount = body.cancellationFeeAmount;
            }
            const res = answer(rules.予約を取り消す(r.state, fee));
            if (res.type === "予約を取り消す_状態が違う") return wrong(r);
            if (res.type === "予約を取り消す_取消料が発生する") {
              r.charges.push({ kind: "取消料", description: "取消料", amount });
              r.state = res.予約の状態 as ReservationState;
              return { status: 200, body: { outcome: "alternate", condition: "取消料が発生する", reservation: r } };
            }
            r.state = "取消";
            return { status: 200, body: { outcome: "done", reservation: r } };
          }
          case "check-in": {
            const early = bool(body, "earlyCheckInAllowed");
            const guest = guestOf(body, false);
            const res = answer(rules.チェックインを記録する(r.state, early));
            if (res === "チェックインを記録する_状態が違う") return wrong(r);
            if (res === "チェックインを記録する_早めのチェックインができる_でない")
              return { status: 200, body: { outcome: "alternate", condition: "早めのチェックインができる", reservation: r } };
            if (guest) r.guest = guest;
            r.state = "チェックイン済";
            return { status: 200, body: { outcome: "done", reservation: r } };
          }
          case "charges": {
            const description = str(body, "description", true)!;
            const amount = body.amount;
            if (typeof amount !== "number" || !Number.isInteger(amount)) throw bad("amount は整数", "amount");
            if (answer(rules.追加料金を登録する(r.state)) !== "追加料金を登録する_完了") return wrong(r);
            r.charges.push({ kind: "追加料金", description, amount });
            return { status: 201, body: { outcome: "done", reservation: r } };
          }
          case "check-out": {
            const res = answer(rules.チェックアウトを記録する(r.state));
            if (res.type === "チェックアウトを記録する_状態が違う") return wrong(r);
            r.state = res.予約の状態 as ReservationState;
            const rm = r.roomId ? store.rooms.get(r.roomId) : undefined;
            if (rm) rm.state = res.部屋の状態 as RoomState;
            return { status: 200, body: { outcome: "done", reservation: r, room: rm ?? null } };
          }
        }
      }
    }
    if (a === "rooms" && id !== undefined) {
      if (seg.length === 2 && method === "GET") return { status: 200, body: room(id) };
      if (seg.length === 3 && act === "assign" && method === "POST") {
        const rm = room(id);
        const full = bool(body, "full");
        const resId = str(body, "reservationId", true)!;
        const r = reservation(resId);
        const res = answer(rules.部屋の割り当てを記録する(rm.state, full));
        if (res === "部屋の割り当てを記録する_状態が違う") return wrong(rm);
        if (res === "部屋の割り当てを記録する_満室である")
          return { status: 200, body: { outcome: "alternate", condition: "満室である", room: rm } };
        rm.state = res as RoomState;
        r.roomId = rm.id;
        return { status: 200, body: { outcome: "done", room: rm, reservation: r } };
      }
    }
    throw new HttpError(404, "notFound", `${method} ${path} は無い`);
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      let body: Obj = {};
      if (text.trim() !== "") {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { throw bad("JSON として読めない"); }
        if (!isObj(parsed)) throw bad("本体は JSON のオブジェクト");
        body = parsed;
      }
      const out = await route(req.method ?? "GET", new URL(req.url ?? "/", "http://x").pathname, body);
      send(out.status, out.body);
    } catch (e) {
      if (e instanceof HttpError) send(e.status, e.body);
      else send(500, { error: { type: "server", message: String(e) } });
    }
  });
}
