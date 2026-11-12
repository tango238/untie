import { pathToFileURL } from "node:url";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { load } from "../../model/pms.ts";

// 業務ルール(状態の移り変わり・条件の分岐)は model/pms.wasm が答える。ここは入出力と保存だけ。
const wasm = readFileSync(new URL("../../model/pms.wasm", import.meta.url));
const bound = await load(wasm);
const model = bound.modules["untie.sys_pms"];

type Json = Record<string, unknown>;
type Charge = { 内容: string; 金額: number; 種別: "追加料金" | "取消料" };
type Reservation = { id: string; 状態: string; 宿泊客: Json; 内容: Json; 部屋?: string; 請求: Charge[] };
type Room = { id: string; 状態: string };

class HttpError extends Error {
  status: number; code: string; detail?: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) { super(message); this.status = status; this.code = code; this.detail = detail; }
}
const bad = (m: string, detail?: unknown) => new HttpError(400, "入力の誤り", m, detail);

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
function str(b: Json, k: string): string {
  const v = b[k];
  if (typeof v !== "string" || v.trim() === "") throw bad(`「${k}」は空でない文字列で渡してください`);
  return v;
}
function bool(b: Json, k: string): boolean {
  if (typeof b[k] !== "boolean") throw bad(`「${k}」は true か false で渡してください`);
  return b[k] as boolean;
}
function obj(b: Json, k: string, required: boolean): Json {
  if (b[k] === undefined && !required) return {};
  if (!isObj(b[k])) throw bad(`「${k}」はオブジェクトで渡してください`);
  return b[k] as Json;
}
function amount(b: Json, k: string): number {
  const v = b[k];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw bad(`「${k}」は 0 以上の整数で渡してください`);
  return v;
}

// モデルの答えを { 種類, 値 } にそろえる。モデルが入力を拒んだ(issues)ときはアプリの不具合として 500。
function ask(r: { issues?: unknown; value?: unknown }): { kind: string; value: any } {
  if (r.issues !== undefined) throw new HttpError(500, "モデルが入力を拒否", "モデルが入力を受け付けませんでした", r.issues);
  const v = r.value as any;
  return typeof v === "string" ? { kind: v, value: v } : { kind: v.type, value: v };
}

export function createApp(): Server {
  const reservations = new Map<string, Reservation>();
  const rooms = new Map<string, Room>();
  let seq = 0;

  const getR = (id: string) => {
    const r = reservations.get(id);
    if (!r) throw new HttpError(404, "予約が無い", `予約 ${id} はありません`);
    return r;
  };
  const getRoom = (id: string) => {
    const r = rooms.get(id);
    if (!r) throw new HttpError(404, "部屋が無い", `部屋 ${id} はありません`);
    return r;
  };
  const wrongState = (what: string, state: string) =>
    new HttpError(409, "状態が違う", `${what}は、今の状態「${state}」では行えません`);
  // 条件のときの別の結果 (状態は変えない / 変える) を 200 で返す
  const outcome = (結果: string, r: Reservation, extra: Json = {}) => ({ status: 200, body: { 結果, 予約: r, ...extra } });

  async function route(method: string, path: string, body: Json): Promise<{ status: number; body: unknown }> {
    const seg = path.split("/").filter(Boolean);
    const post = method === "POST", get = method === "GET";

    if (post && path === "/rooms") {
      const id = str(body, "id");
      const 状態 = str(body, "状態");
      if (rooms.has(id)) throw new HttpError(409, "重複", `部屋 ${id} は既にあります`);
      const dec = bound.decode["untie.sys_pms"].部屋の状態.decode(状態);
      if (dec.issues !== undefined) throw bad("「状態」が部屋の状態として読めません", dec.issues);
      const room = { id, 状態 };
      rooms.set(id, room);
      return { status: 201, body: room };
    }
    if (get && seg[0] === "rooms" && seg.length === 2) return { status: 200, body: getRoom(seg[1]) };
    if (post && path === "/reservations") {
      // 「予約を登録する」(予約サイト側): — → 仮予約
      const r: Reservation = {
        id: `R${++seq}`, 状態: "仮予約",
        宿泊客: obj(body, "宿泊客", true), 内容: obj(body, "内容", false), 請求: [],
      };
      reservations.set(r.id, r);
      return { status: 201, body: r };
    }
    if (get && path === "/reservations") return { status: 200, body: [...reservations.values()] };
    if (seg[0] !== "reservations" || seg.length < 2) throw new HttpError(404, "経路なし", "そのAPIはありません");
    if (get && seg.length === 2) return { status: 200, body: getR(seg[1]) };
    if (!post || seg.length !== 3) throw new HttpError(404, "経路なし", "そのAPIはありません");

    const r = getR(seg[1]);
    const op = seg[2];
    const state = r.状態 as any;

    switch (op) {
      case "confirm": {
        const a = ask(model.予約を確定する(state));
        if (a.kind !== "確定") throw wrongState("予約の確定", r.状態);
        r.状態 = "確定";
        return outcome("確定した", r);
      }
      case "change": {
        const 内容 = obj(body, "内容", true);
        const a = ask(model.予約を変更する(state));
        if (a.kind !== "確定") throw wrongState("予約の変更", r.状態);
        r.内容 = { ...r.内容, ...内容 };
        return outcome("変更した", r);
      }
      case "cancel": {
        const 取消料が発生する = bool(body, "取消料が発生する");
        const 取消料 = 取消料が発生する ? amount(body, "取消料") : 0;
        const a = ask(model.予約を取り消す(state, 取消料が発生する));
        if (a.kind === "予約を取り消す_状態が違う") throw wrongState("予約の取消", r.状態);
        if (a.kind === "予約を取り消す_取消料が発生する") {
          r.請求.push({ 内容: "取消料", 金額: 取消料, 種別: "取消料" }); // 取消料を請求に加えてから取り消す
          r.状態 = a.value.予約の状態;
          return outcome("取消料を請求に加えて取り消した", r);
        }
        r.状態 = a.kind;
        return outcome("取り消した", r);
      }
      case "check-in": {
        const 宿泊客 = obj(body, "宿泊客", false);
        const ok = bool(body, "早めのチェックインができる");
        const a = ask(model.チェックインを記録する(state, ok));
        if (a.kind === "チェックインを記録する_状態が違う") throw wrongState("チェックイン", r.状態);
        if (a.kind === "チェックインを記録する_早めのチェックインができる_でない")
          return outcome("部屋の準備が済むまでロビーで待つ", r);
        r.状態 = "チェックイン済";
        r.宿泊客 = { ...r.宿泊客, ...宿泊客 };
        return outcome("チェックインした", r);
      }
      case "assign-room": {
        const room = getRoom(str(body, "部屋"));
        const full = bool(body, "満室である");
        const a = ask(model.部屋の割り当てを記録する(room.状態 as any, full));
        if (a.kind === "部屋の割り当てを記録する_状態が違う") throw wrongState("部屋の割り当て", `部屋が${room.状態}`);
        if (a.kind === "部屋の割り当てを記録する_満室である")
          return outcome("部屋を割り当てず、空きが出るまで待つ", r, { 部屋: room });
        room.状態 = a.kind;
        r.部屋 = room.id;
        return outcome("部屋を割り当てた", r, { 部屋: room });
      }
      case "charges": {
        const 内容 = str(body, "内容");
        const 金額 = amount(body, "金額");
        const a = ask(model.追加料金を登録する(state));
        if (a.kind !== "追加料金を登録する_完了") throw wrongState("追加料金の登録", r.状態);
        r.請求.push({ 内容, 金額, 種別: "追加料金" });
        return outcome("追加料金を登録した", r);
      }
      case "check-out": {
        const a = ask(model.チェックアウトを記録する(state));
        if (a.kind !== "チェックアウトを記録する_結果") throw wrongState("チェックアウト", r.状態);
        r.状態 = a.value.予約の状態;
        const room = r.部屋 ? rooms.get(r.部屋) : undefined;
        if (room) room.状態 = a.value.部屋の状態;
        return outcome("チェックアウトした", r, { 部屋: room ?? null });
      }
    }
    throw new HttpError(404, "経路なし", "そのAPIはありません");
  }

  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      let body: Json = {};
      if (text.trim() !== "") {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { throw bad("JSON として読めません"); }
        if (!isObj(parsed)) throw bad("本文は JSON オブジェクトで渡してください");
        body = parsed;
      }
      const out = await route(req.method ?? "GET", new URL(req.url ?? "/", "http://x").pathname, body);
      send(out.status, out.body);
    } catch (e) {
      if (e instanceof HttpError) send(e.status, { エラー: e.code, 説明: e.message, 詳細: e.detail });
      else send(500, { エラー: "内部エラー", 説明: String(e) });
    }
  });
}

// `node app/src/server.ts` で起動
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`http://localhost:${port}`));
}
