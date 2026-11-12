// モデル (model/pms.wasm) を呼ぶ薄い層。業務ルールはここにも書かない:
// ・どの状態から始められるか、結果がどの状態か、は wasm の surface (宣言) から読む。
// ・条件の分かれ目は wasm が答える。
import { readFileSync } from "node:fs";
import { load } from "../../model/pms.ts";

const MODULE = "untie.sys_pms";
const bound = await load(readFileSync(new URL("../../model/pms.wasm", import.meta.url)));
const surface = bound.program.surface as any;
const behaviors: Record<string, any> = Object.fromEntries(
  surface.modules.find((m: any) => m.name === MODULE).behaviors.map((b: any) => [b.name, b]),
);
const declaration = (name: string) => surface.declarations.find((d: any) => d.module === MODULE && d.name === name);
const caseNames = (name: string): string[] => declaration(name).cases.map((c: any) => c.name);
const reservationStates = caseNames("予約の状態");
const roomStates = caseNames("部屋の状態");

export type Operation =
  | "予約を確定する" | "予約を変更する" | "予約を取り消す" | "チェックインを記録する"
  | "部屋の割り当てを記録する" | "追加料金を登録する" | "チェックアウトを記録する";

export type Outcome = {
  /** モデルが答えた結果の名前 (分岐のときは分岐の名前) */
  outcome: string;
  /** 結果が予約の新しい状態を表すとき */
  reservationState?: string;
  /** 結果が部屋の新しい状態を表すとき */
  roomState?: string;
};

export type Result =
  | { ok: true; value: Outcome }
  | { ok: false; kind: "precondition"; required: string }
  | { ok: false; kind: "invalid"; issues: unknown };

/** 操作が前提にする状態 (最初の引数の型の名前)。 */
export function requiredState(op: Operation): string {
  return behaviors[op].parameters[0].type.name;
}

/** 部屋の状態の値かどうか、モデルの decoder に聞く。 */
export function isRoomState(s: string): boolean {
  return bound.decode[MODULE]["部屋の状態"].decode(s).issues === undefined;
}

export function call(op: Operation, current: string, conditions: boolean[] = []): Result {
  // モデルの入力型は状態ごとに 1 つの値しかなく、別の状態の値も受け取ってしまう。
  // そのため、前提の状態かどうかは、モデルが宣言している前提の型と突き合わせて確かめる。
  const required = requiredState(op);
  if (current !== required) return { ok: false, kind: "precondition", required };
  const fn = (bound.modules[MODULE] as any)[op] as (...a: unknown[]) => any;
  const answer = fn({ type: required }, ...conditions);
  if (answer.issues !== undefined) return { ok: false, kind: "invalid", issues: answer.issues.list ?? answer.issues };
  const a = behaviors[op].answers;
  const v = answer.value;
  const out: Outcome = { outcome: typeof v === "string" ? v : a.name };
  if (typeof v === "string") {
    if (reservationStates.includes(v)) out.reservationState = v;
    else if (roomStates.includes(v)) out.roomState = v;
    return { ok: true, value: out };
  }
  const decl = declaration(a.name);
  if (decl?.is === "product") {
    for (const f of decl.fields) {
      if (f.name === "予約の状態") out.reservationState = f.type.name;
      if (f.name === "部屋の状態") out.roomState = f.type.name;
    }
  } else if (reservationStates.includes(a.name)) out.reservationState = a.name;
  else if (roomStates.includes(a.name)) out.roomState = a.name;
  return { ok: true, value: out };
}
