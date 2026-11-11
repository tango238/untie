import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { call, isRoomState, type Operation, type Result } from "./model.ts";

type Json = Record<string, unknown>;
type Reservation = {
  id: string; guestName: string; details: Json; guest: Json | null; status: string;
  roomId: string | null; charges: { description: string; amount: number }[];
};
type Room = { id: string; status: string };

class HttpError extends Error {
  status: number; body: Json;
  constructor(status: number, code: string, extra: Json = {}) {
    super(code); this.status = status; this.body = { error: code, ...extra };
  }
}
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function createApp(): Server {
  const reservations = new Map<string, Reservation>();
  const rooms = new Map<string, Room>();
  let seq = 0;

  const getReservation = (id: string) => {
    const r = reservations.get(id);
    if (!r) throw new HttpError(404, "reservation_not_found", { id });
    return r;
  };
  const getRoom = (id: string) => {
    const r = rooms.get(id);
    if (!r) throw new HttpError(404, "room_not_found", { id });
    return r;
  };
  const bool = (body: Json, key: string): boolean => {
    if (typeof body[key] !== "boolean") throw new HttpError(400, "invalid_input", { field: key, expected: "boolean" });
    return body[key] as boolean;
  };
  const str = (body: Json, key: string): string => {
    if (typeof body[key] !== "string" || (body[key] as string).trim() === "")
      throw new HttpError(400, "invalid_input", { field: key, expected: "non-empty string" });
    return body[key] as string;
  };
  const run = (op: Operation, current: string, conditions: boolean[] = []) => {
    const r: Result = call(op, current, conditions);
    if (r.ok) return r.value;
    if (r.kind === "precondition")
      throw new HttpError(409, "wrong_state", { operation: op, current, required: r.required });
    throw new HttpError(400, "model_rejected", { issues: r.issues });
  };

  async function readBody(req: IncomingMessage): Promise<Json> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    if (text === "") return {};
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new HttpError(400, "invalid_json"); }
    if (!isObj(parsed)) throw new HttpError(400, "invalid_input", { expected: "object" });
    return parsed;
  }

  async function route(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const m = req.method ?? "GET";
    const [a, id, action] = parts;

    if (a === "rooms" && parts.length <= 2) {
      if (m === "POST" && !id) {
        const body = await readBody(req);
        const rid = body.id === undefined ? `room-${++seq}` : str(body, "id");
        const status = str(body, "status");
        if (!isRoomState(status)) throw new HttpError(400, "invalid_input", { field: "status" });
        if (rooms.has(rid)) throw new HttpError(409, "already_exists", { id: rid });
        const room = { id: rid, status };
        rooms.set(rid, room);
        return { status: 201, body: room };
      }
      if (m === "GET" && id) return { status: 200, body: getRoom(id) };
    }

    if (a === "reservations" && parts.length <= 3) {
      if (m === "POST" && !id) {
        // 予約サイトでの登録 (— → 仮予約) の代わりに、確かめるために用意する。
        const body = await readBody(req);
        const r: Reservation = {
          id: `res-${++seq}`, guestName: str(body, "guestName"),
          details: isObj(body.details) ? body.details : {}, guest: null, status: "仮予約", roomId: null, charges: [],
        };
        reservations.set(r.id, r);
        return { status: 201, body: r };
      }
      if (m === "GET" && !id) return { status: 200, body: [...reservations.values()] };
      if (m === "GET" && id && !action) return { status: 200, body: getReservation(id) };

      if ((id && action && m === "POST") || (id && !action && m === "PUT")) {
        const r = getReservation(id);
        const body = await readBody(req);
        const done = (o: { outcome: string }, changed: boolean) => ({
          status: 200,
          body: { outcome: o.outcome, changed, reservation: r, ...(r.roomId ? { room: rooms.get(r.roomId) } : {}) },
        });

        if (action === "confirm") {
          const o = run("予約を確定する", r.status);
          r.status = o.reservationState ?? r.status;
          return done(o, true);
        }
        if (m === "PUT" && !action) {
          if (!isObj(body.details)) throw new HttpError(400, "invalid_input", { field: "details", expected: "object" });
          const o = run("予約を変更する", r.status);
          r.details = body.details;
          r.status = o.reservationState ?? r.status;
          return done(o, true);
        }
        if (action === "cancel") {
          const fee = bool(body, "cancellationFeeApplies");
          const o = run("予約を取り消す", r.status, [fee]);
          if (o.reservationState) { r.status = o.reservationState; return done(o, true); }
          return done(o, false);
        }
        if (action === "check-in") {
          const early = bool(body, "earlyCheckInAllowed");
          if (body.guest !== undefined && !isObj(body.guest))
            throw new HttpError(400, "invalid_input", { field: "guest", expected: "object" });
          const o = run("チェックインを記録する", r.status, [early]);
          if (o.reservationState) {
            r.status = o.reservationState;
            if (body.guest) r.guest = body.guest as Json;
            return done(o, true);
          }
          return done(o, false);
        }
        if (action === "room-assignment") {
          const roomId = str(body, "roomId");
          const full = bool(body, "roomFull");
          const room = getRoom(roomId);
          const o = run("部屋の割り当てを記録する", room.status, [full]);
          if (o.roomState) {
            room.status = o.roomState;
            r.roomId = room.id;
            return done(o, true);
          }
          return { status: 200, body: { outcome: o.outcome, changed: false, reservation: r, room } };
        }
        if (action === "charges") {
          const description = str(body, "description");
          if (typeof body.amount !== "number" || !Number.isFinite(body.amount))
            throw new HttpError(400, "invalid_input", { field: "amount", expected: "number" });
          const o = run("追加料金を登録する", r.status);
          r.charges.push({ description, amount: body.amount });
          return done(o, true);
        }
        if (action === "check-out") {
          const o = run("チェックアウトを記録する", r.status);
          r.status = o.reservationState ?? r.status;
          const room = r.roomId ? rooms.get(r.roomId) : undefined;
          if (room && o.roomState) room.status = o.roomState;
          return done(o, true);
        }
      }
    }
    throw new HttpError(404, "not_found");
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let out: { status: number; body: unknown };
    try { out = await route(req); }
    catch (e) {
      if (e instanceof HttpError) out = { status: e.status, body: e.body };
      else { console.error(e); out = { status: 500, body: { error: "internal_error" } }; }
    }
    res.writeHead(out.status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(out.body));
  });
}
