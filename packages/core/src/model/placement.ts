// 情報の置き場所 (システム・帳票の取得元・保存先) と画面が扱う情報の導出。純粋関数だけを置く。
// 0.4.0 から、これらは関係として保存せず、操作が扱う情報 (usecaseInformation とその access) と操作の対象から導く。
//   置き場所 = 情報を扱う操作の対象 (システム・帳票。画面を使う操作なら、その画面のシステム)
//   取得元 = access が read か省略の操作の対象、保存先 = access が write か省略の操作の対象
//   画面が扱う情報 = その画面を使う操作が扱う情報
// 同じ事実を 3 か所 (操作・画面・システム) で入力させず、ずれも起きないようにするため。
import type { InformationAccess, UntieModel } from "./types";

/** 置き場所での役割。source: 取得元 (読む)、store: 保存先 (書く) */
export type PlaceRole = "source" | "store";

export const PLACE_ROLES: readonly PlaceRole[] = ["source", "store"];

export const PLACE_ROLE_LABELS: Record<PlaceRole, string> = { source: "取得元", store: "保存先" };

/** access から役割を引く。省略は取得も保存もする */
export function accessRoles(access: InformationAccess | undefined): PlaceRole[] {
  if (access === "read") return ["source"];
  if (access === "write") return ["store"];
  return ["source", "store"];
}

/** 操作 id → 対象のシステム・帳票 id (直接の対象か、使う画面のシステム)。対象の無い操作は入れない */
export function usecasePlaces(model: UntieModel): Map<string, string> {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const result = new Map<string, string>();
  for (const r of model.relations) {
    if (r.kind === "usecaseSystem") {
      const t = byId.get(r.targetId);
      if (t && (t.kind === "system" || t.kind === "ledger")) result.set(r.sourceId, t.id);
    } else if (r.kind === "usecaseScreen") {
      const screen = byId.get(r.targetId);
      if (screen?.kind === "screen" && byId.get(screen.systemId)?.kind === "system") result.set(r.sourceId, screen.systemId);
    }
  }
  return result;
}

/** 導いた 1 件: 相手 (置き場所・情報・画面) と役割、それを決めた操作 (関係の並び順、重複なし) */
export interface Derived {
  id: string;
  roles: PlaceRole[];
  usecaseIds: string[];
}

function collect(map: Map<string, Derived[]>, ownerId: string, id: string, roles: PlaceRole[], usecaseId: string) {
  const list = map.get(ownerId) ?? [];
  let entry = list.find((d) => d.id === id);
  if (!entry) {
    entry = { id, roles: [], usecaseIds: [] };
    list.push(entry);
    map.set(ownerId, list);
  }
  for (const role of roles) if (!entry.roles.includes(role)) entry.roles.push(role);
  if (!entry.usecaseIds.includes(usecaseId)) entry.usecaseIds.push(usecaseId);
  entry.roles.sort((a, b) => PLACE_ROLES.indexOf(a) - PLACE_ROLES.indexOf(b));
}

/** 情報 id → 置き場所 (システム・帳票) と役割。扱う操作に対象が無い情報は入れない */
export function informationPlaces(model: UntieModel): Map<string, Derived[]> {
  const places = usecasePlaces(model);
  const result = new Map<string, Derived[]>();
  for (const r of model.relations) {
    if (r.kind !== "usecaseInformation") continue;
    const place = places.get(r.sourceId);
    if (place) collect(result, r.targetId, place, accessRoles(r.access), r.sourceId);
  }
  return result;
}

/** 置き場所 (システム・帳票) id → そこにある情報と役割 */
export function placeInformations(model: UntieModel): Map<string, Derived[]> {
  const places = usecasePlaces(model);
  const result = new Map<string, Derived[]>();
  for (const r of model.relations) {
    if (r.kind !== "usecaseInformation") continue;
    const place = places.get(r.sourceId);
    if (place) collect(result, place, r.targetId, accessRoles(r.access), r.sourceId);
  }
  return result;
}

/** 画面 id → その画面を使う操作が扱う情報と役割 */
export function screenInformations(model: UntieModel): Map<string, Derived[]> {
  const screenOf = new Map<string, string[]>();
  for (const r of model.relations) if (r.kind === "usecaseScreen") screenOf.set(r.sourceId, [...(screenOf.get(r.sourceId) ?? []), r.targetId]);
  const result = new Map<string, Derived[]>();
  for (const r of model.relations) {
    if (r.kind !== "usecaseInformation") continue;
    for (const screenId of screenOf.get(r.sourceId) ?? []) collect(result, screenId, r.targetId, accessRoles(r.access), r.sourceId);
  }
  return result;
}

/** 画面が判断する条件 1 件: 条件と、それを決めた操作 (関係の並び順、重複なし) */
export interface DerivedCondition {
  id: string;
  usecaseIds: string[];
}

/** 画面 id → その画面を使う操作が判断する条件 (usecaseCondition)。情報と違って役割は無い */
export function screenConditions(model: UntieModel): Map<string, DerivedCondition[]> {
  const screenOf = new Map<string, string[]>();
  for (const r of model.relations) if (r.kind === "usecaseScreen") screenOf.set(r.sourceId, [...(screenOf.get(r.sourceId) ?? []), r.targetId]);
  const result = new Map<string, DerivedCondition[]>();
  for (const r of model.relations) {
    if (r.kind !== "usecaseCondition") continue;
    for (const screenId of screenOf.get(r.sourceId) ?? []) {
      const list = result.get(screenId) ?? [];
      let entry = list.find((d) => d.id === r.targetId);
      if (!entry) {
        entry = { id: r.targetId, usecaseIds: [] };
        list.push(entry);
        result.set(screenId, list);
      }
      if (!entry.usecaseIds.includes(r.sourceId)) entry.usecaseIds.push(r.sourceId);
    }
  }
  return result;
}

/**
 * 操作が、情報を読むだけ (問い合わせ) か: 扱う情報があって、すべて取得だけで、状態を変えず、出来事も起こさない。
 * 取得だけに見えても、次の状態 (usecaseState) や起こす出来事 (usecaseEvent) があれば、何かを変える操作 (帳票を出す、など)。
 * 画面の既定 (一覧か入力か) と、AI に渡す操作の種類が、同じ判定を使う
 */
export function usecaseIsReadOnly(model: UntieModel, usecaseId: string): boolean {
  const access = model.relations.filter((r) => r.kind === "usecaseInformation" && r.sourceId === usecaseId);
  if (access.length === 0 || !access.every((r) => r.access === "read")) return false;
  return !model.relations.some((r) => (r.kind === "usecaseEvent" || r.kind === "usecaseState") && r.sourceId === usecaseId);
}
