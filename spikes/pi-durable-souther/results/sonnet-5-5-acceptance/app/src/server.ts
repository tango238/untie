import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { load } from "../../model/pms.ts";

// 業務ルール (状態の前提・移り変わり・条件の分岐) はすべて model/pms.wasm が答える。ここは入出力と保存だけ。
const bound = await load(readFileSync(new URL("../../model/pms.wasm", import.meta.url)));
const model = bound.modules["untie.sys_pms"];
const NS = "untie.sys_pms.";

interface Charge { description: string; amount: number }
interface Reservation {
  id: string; state: string; roomId?: string; guestName?: string;
  details: Record<string, string>; charges: Charge[]; cancellationFee?: number;
}
interface Room { id: string; state: string }

class HttpError extends Error {
  status: number;
  kind: string;
  constructor(status: number, kind: string, message: string) { super(message); this.status = status; this.kind = kind; }
}
const bad = (m: string) => new HttpError(400, "input", m);
const notFound = (m: string) => new HttpError(404, "notFound", m);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
function bool(b: Obj, k: string): boolean {
  if (typeof b[k] !== "boolean") throw bad(`${k} は true / false で渡してください`);
  return b[k] as boolean;
}
function optStr(b: Obj, k: string): string | undefined {
  if (b[k] === undefined) return undefined;
  if (typeof b[k] !== "string" || (b[k] as string).trim() === "") throw bad(`${k} は空でない文字列で渡してください`);
  return b[k] as string;
}
function money(v: unknown, k: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw bad(`${k} は 0 以上の数で渡してください`);
  return v;
}
/** モデルが公開する状態の型として読む (正しい状態名かはモデルが決める) */
function state(v: unknown, type: "予約の状態" | "部屋の状態"): string {
  const r = bound.program.decode<string>(NS + type, v);
  if ("issues" in r) throw bad(`${type} が正しくありません`);
  return r.value;
}
function ask<T>(r: { value: T } | { issues: unknown }): T {
  if ("issues" in r) throw new HttpError(500, "server", "モデルが入力を受け付けませんでした");
  return r.value;
}

export function createApp(): Server {
  const reservations = new Map<string, Reservation>();
  const rooms = new Map<string, Room>();
  let seq = 0;
  const nextId = (p: string) => `${p}${++seq}`;

  const getRes = (id: string) => reservations.get(id) ?? (() => { throw notFound(`予約 ${id} がありません`); })();
  const getRoom = (id: string) => rooms.get(id) ?? (() => { throw notFound(`部屋 ${id} がありません`); })();
  const wrong = (res: Obj) => ({ status: 409, body: { outcome: "wrongState", ...res } });

  const resView = (r: Reservation) => ({ ...r, charges: [...r.charges] });

  function resOp(id: string, body: Obj, op: string): { status: number; body: Obj } {
    // 入力の検査 → 存在の確認 → モデル、の順
    let cond = false, fee: number | undefined, charge: Charge | undefined, guest: string | undefined, details: Record<string, string> = {};
    if (op === "cancel") {
      cond = bool(body, "cancellationFeeApplies");
      if (body.cancellationFee !== undefined) fee = money(body.cancellationFee, "cancellationFee");
    } else if (op === "check-in") {
      cond = bool(body, "earlyCheckInAllowed");
      guest = optStr(body, "guestName");
    } else if (op === "charges") {
      const d = optStr(body, "description");
      if (d === undefined) throw bad("description は必須です");
      charge = { description: d, amount: money(body.amount, "amount") };
    } else if (op === "change") {
      for (const k of ["checkInDate", "checkOutDate", "roomType", "guestName"]) {
        const v = optStr(body, k);
        if (v !== undefined) details[k] = v;
      }
      if (Object.keys(details).length === 0) throw bad("変更する項目 (checkInDate, checkOutDate, roomType, guestName) を 1 つ以上渡してください");
    }
    const r = getRes(id);
    const cur = state(r.state, "予約の状態");
    const view = () => ({ reservation: resView(r) });
    switch (op) {
      case "confirm": {
        const v = ask(model.予約を確定する(cur as never));
        if (v === "予約を確定する_状態が違う") return wrong(view());
        r.state = v;
        return { status: 200, body: { outcome: "done", ...view() } };
      }
      case "change": {
        const v = ask(model.予約を変更する(cur as never));
        if (v === "予約を変更する_状態が違う") return wrong(view());
        r.state = v;
        Object.assign(r.details, details);
        if (details.guestName) r.guestName = details.guestName;
        return { status: 200, body: { outcome: "done", ...view() } };
      }
      case "cancel": {
        const v = ask(model.予約を取り消す(cur as never, cond));
        if (typeof v === "object" && v.type === "予約を取り消す_状態が違う") return wrong(view());
        if (typeof v === "object" && v.type === "予約を取り消す_取消料が発生する") {
          r.state = v.予約の状態;
          if (fee !== undefined) { r.cancellationFee = fee; r.charges.push({ description: "取消料", amount: fee }); }
          return { status: 200, body: { outcome: "alternate", condition: "取消料が発生する", ...view() } };
        }
        r.state = (v as { type: string }).type === "取消" ? "取消" : r.state;
        return { status: 200, body: { outcome: "done", ...view() } };
      }
      case "check-in": {
        const v = ask(model.チェックインを記録する(cur as never, cond));
        if (v === "チェックインを記録する_状態が違う") return wrong(view());
        if (v === "チェックインを記録する_早めのチェックインができる_でない")
          return { status: 200, body: { outcome: "alternate", condition: "早めのチェックインができる", ...view() } };
        r.state = v;
        if (guest) r.guestName = guest;
        return { status: 200, body: { outcome: "done", ...view() } };
      }
      case "charges": {
        const v = ask(model.追加料金を登録する(cur as never));
        if (v === "追加料金を登録する_状態が違う") return wrong(view());
        r.charges.push(charge!);
        return { status: 200, body: { outcome: "done", ...view() } };
      }
      default: { // check-out
        const v = ask(model.チェックアウトを記録する(cur as never));
        if (typeof v === "object" && v.type === "チェックアウトを記録する_状態が違う") return wrong(view());
        const res = v as { 予約の状態: string; 部屋の状態: string };
        r.state = res.予約の状態;
        const room = r.roomId ? rooms.get(r.roomId) : undefined;
        if (room) room.state = res.部屋の状態;
        return { status: 200, body: { outcome: "done", ...view(), ...(room ? { room: { ...room } } : {}) } };
      }
    }
  }

  function assign(id: string, body: Obj): { status: number; body: Obj } {
    const full = bool(body, "fullHouse");
    const resId = optStr(body, "reservationId");
    const room = getRoom(id);
    const r = resId ? getRes(resId) : undefined;
    const v = ask(model.部屋の割り当てを記録する(state(room.state, "部屋の状態") as never, full));
    if (v === "部屋の割り当てを記録する_状態が違う") return wrong({ room: { ...room } });
    if (v === "部屋の割り当てを記録する_満室である")
      return { status: 200, body: { outcome: "alternate", condition: "満室である", room: { ...room } } };
    room.state = v;
    if (r) r.roomId = room.id;
    return { status: 200, body: { outcome: "done", room: { ...room } } };
  }

  async function route(req: IncomingMessage): Promise<{ status: number; body: Obj }> {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const m = req.method ?? "GET";
    let body: Obj = {};
    if (m === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() !== "") {
        let j: unknown;
        try { j = JSON.parse(text); } catch { throw bad("JSON として読めません"); }
        if (!isObj(j)) throw bad("JSON のオブジェクトで渡してください");
        body = j;
      }
    }
    const [a, b, c] = parts;
    // 確かめるための操作 (dev)
    if (a === "dev" && m === "POST" && b === "reservations" && parts.length === 2) {
      const st = state(body.state ?? "仮予約", "予約の状態");
      const roomId = optStr(body, "roomId");
      if (roomId) getRoom(roomId);
      const r: Reservation = { id: nextId("R"), state: st, roomId, guestName: optStr(body, "guestName"), details: {}, charges: [] };
      reservations.set(r.id, r);
      return { status: 201, body: { reservation: resView(r) } };
    }
    if (a === "dev" && m === "POST" && b === "rooms" && parts.length === 2) {
      const room: Room = { id: nextId("K"), state: state(body.state ?? "準備完了", "部屋の状態") };
      rooms.set(room.id, room);
      return { status: 201, body: { room: { ...room } } };
    }
    if (a === "reservations" && b && m === "GET" && parts.length === 2) return { status: 200, body: { reservation: resView(getRes(b)) } };
    if (a === "rooms" && b && m === "GET" && parts.length === 2) return { status: 200, body: { room: { ...getRoom(b) } } };
    if (a === "reservations" && b && c && m === "POST" && parts.length === 3) {
      const ops: Record<string, string> = { confirm: "confirm", change: "change", cancel: "cancel", "check-in": "check-in", charges: "charges", "check-out": "check-out" };
      if (ops[c]) return resOp(b, body, ops[c]);
    }
    if (a === "rooms" && b && c === "assign" && m === "POST" && parts.length === 3) return assign(b, body);
    throw new HttpError(404, "notFound", "そのような API はありません");
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let out: { status: number; body: Obj };
    try { out = await route(req); }
    catch (e) {
      out = e instanceof HttpError
        ? { status: e.status, body: { outcome: "error", error: { type: e.kind === "input" ? "input" : e.kind, message: e.message } } }
        : { status: 500, body: { outcome: "error", error: { type: "server", message: String(e) } } };
    }
    res.writeHead(out.status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(out.body));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`listening on :${port}`));
}
